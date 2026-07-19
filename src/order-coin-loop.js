"use strict";

const { isPlanActionable } = require("./plan-actionability");
const { warehouseGridEligibility } = require("./warehouse-domain");

function selectWarehouseCandidate(state) {
  const requiredIds = new Set(Object.entries(state.board?.requiredItemCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([itemId]) => String(itemId)));
  const knowledge = state.warehouse?.inventoryKnowledge;
  if (knowledge?.status === "loaded" && Number(knowledge.exchangeCapacity) <= 0) return null;
  const capacity = Number(state.warehouse?.unlockedSlots ?? state.warehouse?.totalSlots ?? Infinity);
  const occupied = Number(state.warehouse?.occupiedSlots ?? 0);
  if (!knowledge && Number.isFinite(capacity) && occupied >= capacity) return null;
  return (state.board?.grids || []).find((grid) => {
    return warehouseGridEligibility(grid, { requiredItemIds: requiredIds }).eligible;
  }) || null;
}

class OrderCoinLoop {
  constructor({ collectState, planOrders, runBoardAction, submitOrder, preflightStore = null, storeBoardItem = null, loadWarehouseInventory = null, retrieveWarehouseItem = null, switchProductionMode = null, allowProductionModeSwitch = true, minEnergy = 0, minEmptySpaces = 2, onEvent = null }) {
    this.collectState = collectState;
    this.planOrders = planOrders;
    this.runBoardAction = runBoardAction;
    this.submitOrder = submitOrder;
    this.preflightStore = preflightStore;
    this.storeBoardItem = storeBoardItem;
    this.loadWarehouseInventory = loadWarehouseInventory;
    this.retrieveWarehouseItem = retrieveWarehouseItem;
    this.switchProductionMode = switchProductionMode;
    this.allowProductionModeSwitch = !!allowProductionModeSwitch;
    this.onEvent = onEvent;
    this.minEnergy = Math.max(0, Number(minEnergy) || 0);
    this.minEmptySpaces = Math.max(0, Number(minEmptySpaces) || 0);
    this.targetSlot = null;
  }

  async tryProductionModeSwitch({ target, state, plan, execute, signal, actions }) {
    const action = target?.nextAction;
    if (action?.type !== "switch-production-mode") return null;
    if (!execute) return { result: { ok: true, executed: false, reason: "planned", targetSlot: this.targetSlot, nextAction: action, actions, state, plan } };
    if (!this.allowProductionModeSwitch) return { result: { ok: true, executed: false, reason: "production-mode-switch-awaiting-execution-boundary", targetSlot: this.targetSlot, nextAction: action, actions, state, plan } };
    if (!this.switchProductionMode) return { result: { ok: false, executed: false, reason: "production-mode-switch-executor-unavailable", targetSlot: this.targetSlot, nextAction: action, actions, state, plan } };
    const switched = await this.switchProductionMode(action.producer, action.productionModeId, { signal, expectedCurrentModeId: action.currentModeId });
    const recorded = { step: actions.length + 1, type: "switch-production-mode", producer: action.producer, producerItemId: action.producerItemId, previousModeId: action.currentModeId, productionModeId: action.productionModeId, ok: switched.ok, reason: switched.reason, before: switched.before, after: switched.after };
    actions.push(recorded);
    this.onEvent?.(recorded);
    if (!switched.ok) return { result: { ok: false, executed: true, reason: switched.reason || "production-mode-switch-failed", targetSlot: this.targetSlot, actions, state, plan, productionMode: switched } };
    return { continue: true };
  }

  async tryWarehouseRetrieve({ plan, state, execute, signal, actions }) {
    let planningState = state;
    let loadedInventory = false;
    if (plan.warehouseInventoryLoadRequired) {
      if (!this.loadWarehouseInventory) return null;
      if (!execute) return { result: { ok: true, executed: false, reason: "planned", nextAction: { type: "load-warehouse-inventory", ...plan.warehouseLoadRequest }, actions, state, plan } };
      const loaded = await this.loadWarehouseInventory({ signal });
      if (!loaded.ok) return { result: { ok: false, executed: true, reason: loaded.reason || "warehouse-inventory-load-failed", actions, state, plan, warehouse: loaded } };
      planningState = loaded.state;
      plan = await this.planOrders(planningState);
      loadedInventory = true;
    }
    const target = this.targetSlot == null
      ? plan.recommended
      : plan.plans?.find((item) => String(item.slot) === this.targetSlot) || plan.recommended;
    const action = target?.nextAction;
    if (action?.type !== "retrieve-from-warehouse") return loadedInventory ? { result: { ok: true, executed: execute, reason: "waiting-warehouse-item-unavailable", actions, state: planningState, plan } } : null;
    this.targetSlot = String(target.slot);
    if (!execute) return { result: { ok: true, executed: false, reason: "planned", targetSlot: this.targetSlot, nextAction: action, actions, state: planningState, plan } };
    if (!this.retrieveWarehouseItem) return { result: { ok: false, executed: false, reason: "warehouse-retrieval-executor-unavailable", actions, state: planningState, plan } };
    const retrieved = await this.retrieveWarehouseItem(action, { signal, inventory: planningState.warehouse?.inventoryKnowledge, before: planningState });
    const recorded = { step: actions.length + 1, type: "retrieve-from-warehouse", warehouseSlotId: action.warehouseSlotId, itemId: action.itemId, ok: retrieved.ok, reason: retrieved.reason, actualBoardIndex: retrieved.actualBoardIndex ?? null, before: retrieved.before, after: retrieved.after };
    actions.push(recorded);
    this.onEvent?.(recorded);
    if (!retrieved.ok) return { result: { ok: false, executed: true, reason: retrieved.reason || "warehouse-retrieval-failed", targetSlot: this.targetSlot, actions, state: planningState, plan, warehouse: retrieved } };
    return { continue: true };
  }

  async tryWarehouseStore({ plan, state, execute, signal, actions }) {
    const fallback = this.storeBoardItem ? selectWarehouseCandidate(state) : null;
    const plannerOwnsCandidates = Array.isArray(plan.warehouseStoreCandidates);
    const selectedStoreAction = plan.recommended?.nextAction?.type === "store-to-warehouse" ? plan.recommended.nextAction : null;
    const candidates = plannerOwnsCandidates
      ? [selectedStoreAction, ...plan.warehouseStoreCandidates].filter((candidate, index, values) => candidate && values.findIndex((entry) => Number(entry?.sourceIndex) === Number(candidate.sourceIndex)) === index)
      : fallback ? [{ type: "store-to-warehouse", sourceIndex: fallback.index, itemId: fallback.itemId, opportunityCost: null, storeAvailability: { status: "native-preflight-required" } }] : [];
    if (!candidates.length) return null;
    let warehouseCandidate = null, checked = null;
    const preflightResults = [];
    for (const candidate of candidates) {
      const result = this.preflightStore
        ? await this.preflightStore(candidate.sourceIndex, { signal })
        : { ok: true, storeAvailability: { status: "available", sourceIndex: candidate.sourceIndex, itemId: candidate.itemId, targetSlotId: null } };
      preflightResults.push({ sourceIndex: candidate.sourceIndex, itemId: candidate.itemId, ok: result.ok, reason: result.reason || null });
      if (!result.ok) continue;
      if (plannerOwnsCandidates) {
        const freshState = result.before || state;
        const expectedSignature = result.storeAvailability?.boardSignature;
        if (expectedSignature != null && freshState.board?.signature != null && String(expectedSignature) !== String(freshState.board.signature)) {
          preflightResults.at(-1).reason = "warehouse-preflight-signature-mismatch";
          continue;
        }
        const enrichedState = JSON.parse(JSON.stringify(freshState));
        enrichedState.warehouse = { ...(enrichedState.warehouse || {}), storeAvailability: result.storeAvailability };
        const replanned = await this.planOrders(enrichedState);
        const replannedTarget = this.targetSlot == null
          ? replanned.recommended
          : replanned.plans.find((item) => String(item.slot) === this.targetSlot) || replanned.recommended;
        const selectedAction = replannedTarget?.nextAction;
        if (selectedAction?.type !== "store-to-warehouse" || Number(selectedAction.sourceIndex) !== Number(candidate.sourceIndex)) {
          preflightResults.at(-1).reason = "planner-selected-another-path";
          continue;
        }
        warehouseCandidate = { ...candidate, ...selectedAction };
        plan = replanned;
      } else {
        warehouseCandidate = candidate;
      }
      checked = result;
      break;
    }
    if (!warehouseCandidate) return { result: { ok: true, executed: execute, reason: "waiting-warehouse-store-unavailable", targetSlot: this.targetSlot, preflightResults, actions, state, plan } };
    const nextAction = { ...warehouseCandidate, storeAvailability: checked.storeAvailability };
    if (!execute) return { result: { ok: true, executed: false, reason: "planned", targetSlot: this.targetSlot, nextAction, preflightResults, actions, state, plan } };
    const stored = await this.storeBoardItem(warehouseCandidate.sourceIndex, { signal, preflight: checked });
    const action = { step: actions.length + 1, type: "move-to-warehouse", index: warehouseCandidate.sourceIndex, itemId: warehouseCandidate.itemId, targetSlotId: checked.storeAvailability?.targetSlotId ?? null, opportunityCost: warehouseCandidate.opportunityCost, ok: stored.ok, reason: stored.reason, before: stored.before, after: stored.after };
    actions.push(action);
    this.onEvent?.(action);
    if (!stored.ok) return { result: { ok: false, executed: true, reason: stored.reason || "warehouse-store-failed", targetSlot: this.targetSlot, actions, state, plan, warehouse: stored } };
    return { continue: true };
  }

  async run({ execute = false, maxActions = null, signal = null } = {}) {
    const requestedLimit = Number(maxActions);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.max(1, Math.floor(requestedLimit))
      : Infinity;
    const actions = [];
    for (let step = 0; step < limit; step += 1) {
      if (signal?.aborted) return { ok: false, executed: execute, reason: "aborted", targetSlot: this.targetSlot, actions };
      const state = await this.collectState();
      const energy = Number(state.resources?.energy);
      if (Number.isFinite(energy) && energy <= this.minEnergy) {
        return { ok: true, executed: execute, reason: "energy-depleted", targetSlot: this.targetSlot, actions, state };
      }
      let plan = await this.planOrders(state);
      const retrieval = await this.tryWarehouseRetrieve({ plan, state, execute, signal, actions });
      if (retrieval?.continue) continue;
      if (retrieval?.result) return retrieval.result;
      let target = this.targetSlot == null ? null : plan.plans.find((item) => String(item.slot) === this.targetSlot);
      const actionContext = { hasMergeCandidate: (state.board?.mergeCandidates || []).length > 0 };
      const actionable = (candidate) => isPlanActionable(candidate, actionContext);
      if (!actionable(target)) {
        target = actionable(plan.recommended)
          ? plan.recommended
          : plan.plans.find(actionable) || null;
        this.targetSlot = target ? String(target.slot) : null;
      }
      if (!target) {
        const boundary = plan.boundaryReason || "no-feasible-order";
        if (boundary === "board-space-deadlock") {
          const warehouse = await this.tryWarehouseStore({ plan, state, execute, signal, actions });
          if (warehouse?.continue) continue;
          if (warehouse?.result) return warehouse.result;
        }
        if (boundary === "evidence-waiting") return { ok: true, executed: execute, status: "evidence-waiting", reason: "evidence-waiting", actions, state, plan };
        const reason = String(boundary).startsWith("waiting-") ? boundary : `waiting-${boundary}`;
        return { ok: true, executed: execute, reason, actions, state, plan };
      }
      if (target.nextAction?.type === "store-to-warehouse") {
        const warehouse = await this.tryWarehouseStore({ plan, state, execute, signal, actions });
        if (warehouse?.continue) continue;
        if (warehouse?.result) return warehouse.result;
      }
      const modeSwitch = await this.tryProductionModeSwitch({ target, state, plan, execute, signal, actions });
      if (modeSwitch?.continue) continue;
      if (modeSwitch?.result) return modeSwitch.result;
      const order = state.orders.find((item) => String(item.slot) === this.targetSlot);
      if (order?.ready || target.ready) {
        if (!execute) return { ok: true, executed: false, reason: "order-ready", targetSlot: this.targetSlot, nextAction: { type: "submit-order", slot: this.targetSlot }, actions, state, plan };
        const submitted = await this.submitOrder(this.targetSlot, { signal });
        actions.push({ step: actions.length + 1, type: "submit-order", slot: this.targetSlot, ok: submitted.ok, reason: submitted.reason, before: submitted.before, after: submitted.after, coinsBefore: submitted.coinsBefore, coinsAfter: submitted.coinsAfter });
        this.onEvent?.(actions.at(-1));
        return { ok: submitted.ok, executed: true, reason: submitted.reason, targetSlot: this.targetSlot, actions, submission: submitted };
      }
      const plannedAction = target.nextAction || null;
      const mergeAvailable = plannedAction?.type === "merge" || (state.board?.mergeCandidates || []).length > 0;
      const plannedSpaceSafe = !!plannedAction && target.boardSpaceFeasibility?.feasible === true;
      if (!mergeAvailable && !plannedSpaceSafe && Number(state.board?.empty ?? Infinity) <= this.minEmptySpaces) {
        const warehouse = await this.tryWarehouseStore({ plan, state, execute, signal, actions });
        if (warehouse?.continue) continue;
        if (warehouse?.result) return warehouse.result;
        return { ok: true, executed: execute, reason: "waiting-board-space", targetSlot: this.targetSlot, actions, state, plan };
      }
      const producer = plannedAction?.type === "produce" ? plannedAction.producer : target.producerSteps?.[0]?.gridIndex;
      if (producer == null && !mergeAvailable) {
        const boundary = target.blockingReason || plan.boundaryReason || "no-executable-action";
        const reason = String(boundary).startsWith("waiting-") ? boundary : `waiting-${boundary}`;
        return { ok: true, executed: execute, reason, targetSlot: this.targetSlot, actions, state, plan };
      }
      if (!execute) return { ok: true, executed: false, reason: "planned", targetSlot: this.targetSlot, nextAction: plannedAction || { type: state.board.mergeCandidates.length ? "merge" : "produce", producer }, actions, state, plan };
      const boardResult = await this.runBoardAction({ producer, merge: plannedAction?.type === "merge" ? plannedAction : null, plannedAction, signal });
      const verified = boardResult.ok && (boardResult.actions?.length > 0 || boardResult.stopReason === "order_ready");
      const diff = boardResult.actions?.[0] || boardResult.uncertainAction || null;
      const actualOutputs = (diff?.actualOutputItemIds || []).map(String).sort();
      const predictedBranches = plannedAction?.predictedBranches || [];
      const predictionDiverged = plannedAction?.type === "produce" && actualOutputs.length > 0 && predictedBranches.length > 0
        && !predictedBranches.some((branch) => JSON.stringify((branch.outcomeItemIds || []).map(String).sort()) === JSON.stringify(actualOutputs));
      actions.push({ step: actions.length + 1, type: diff?.type || "board-boundary", producer, ok: verified, reason: boardResult.stopReason || boardResult.reason, diff, predictionDiverged, ...(predictionDiverged ? { replanReason: "actual-production-outside-predicted-branches" } : {}) });
      this.onEvent?.(actions.at(-1));
      if (!verified) return { ok: false, executed: true, reason: boardResult.reason || boardResult.stopReason || "board-action-failed", targetSlot: this.targetSlot, actions, boardResult };
    }
    return { ok: true, executed: execute, reason: "max-actions-reached", targetSlot: this.targetSlot, actions };
  }
}

module.exports = { OrderCoinLoop, selectWarehouseCandidate };
