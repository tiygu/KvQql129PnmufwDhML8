"use strict";

const { isGridExecutable } = require("./inventory-availability");
const { isPlanActionable } = require("./plan-actionability");

function selectWarehouseCandidate(state) {
  const requiredIds = new Set(Object.entries(state.board?.requiredItemCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([itemId]) => String(itemId)));
  const capacity = Number(state.warehouse?.unlockedSlots ?? state.warehouse?.totalSlots ?? Infinity);
  const occupied = Number(state.warehouse?.occupiedSlots ?? 0);
  if (Number.isFinite(capacity) && occupied >= capacity) return null;
  return (state.board?.grids || []).find((grid) => {
    if (!grid || grid.empty || !grid.itemId || grid.taskNeed) return false;
    if (requiredIds.has(String(grid.itemId))) return false;
    if (!isGridExecutable(grid)) return false;
    if (grid.produceCount != null && Number(grid.energyCost) > 0) return false;
    return true;
  }) || null;
}

class OrderCoinLoop {
  constructor({ collectState, planOrders, runBoardAction, submitOrder, storeBoardItem = null, minEnergy = 0, minEmptySpaces = 2, onEvent = null }) {
    this.collectState = collectState;
    this.planOrders = planOrders;
    this.runBoardAction = runBoardAction;
    this.submitOrder = submitOrder;
    this.storeBoardItem = storeBoardItem;
    this.onEvent = onEvent;
    this.minEnergy = Math.max(0, Number(minEnergy) || 0);
    this.minEmptySpaces = Math.max(0, Number(minEmptySpaces) || 0);
    this.targetSlot = null;
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
      const plan = await this.planOrders(state);
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
        if (boundary === "evidence-waiting") return { ok: true, executed: execute, status: "evidence-waiting", reason: "evidence-waiting", actions, state, plan };
        const reason = String(boundary).startsWith("waiting-") ? boundary : `waiting-${boundary}`;
        return { ok: true, executed: execute, reason, actions, state, plan };
      }
      const order = state.orders.find((item) => String(item.slot) === this.targetSlot);
      if (order?.ready || target.ready) {
        if (!execute) return { ok: true, executed: false, reason: "order-ready", targetSlot: this.targetSlot, nextAction: { type: "submit-order", slot: this.targetSlot }, actions, state, plan };
        const submitted = await this.submitOrder(this.targetSlot, { signal });
        actions.push({ step: actions.length + 1, type: "submit-order", slot: this.targetSlot, ok: submitted.ok, reason: submitted.reason, before: submitted.before, after: submitted.after, coinsBefore: submitted.coinsBefore, coinsAfter: submitted.coinsAfter });
        this.onEvent?.(actions.at(-1));
        return { ok: submitted.ok, executed: true, reason: submitted.reason, targetSlot: this.targetSlot, actions, submission: submitted };
      }
      const mergeAvailable = (state.board?.mergeCandidates || []).length > 0;
      if (!mergeAvailable && Number(state.board?.empty ?? Infinity) <= this.minEmptySpaces) {
        const warehouseCandidate = this.storeBoardItem ? selectWarehouseCandidate(state) : null;
        if (warehouseCandidate) {
          if (!execute) return { ok: true, executed: false, reason: "planned", targetSlot: this.targetSlot, nextAction: { type: "move-to-warehouse", index: warehouseCandidate.index, itemId: warehouseCandidate.itemId }, actions, state, plan };
          const stored = await this.storeBoardItem(warehouseCandidate.index, { signal });
          const action = { step: actions.length + 1, type: "move-to-warehouse", index: warehouseCandidate.index, itemId: warehouseCandidate.itemId, ok: stored.ok, reason: stored.reason, before: stored.before, after: stored.after };
          actions.push(action);
          this.onEvent?.(action);
          if (!stored.ok) return { ok: false, executed: true, reason: stored.reason || "warehouse-store-failed", targetSlot: this.targetSlot, actions, state, plan, warehouse: stored };
          continue;
        }
        return { ok: true, executed: execute, reason: "waiting-board-space", targetSlot: this.targetSlot, actions, state, plan };
      }
      const producer = target.producerSteps?.[0]?.gridIndex;
      if (producer == null && !mergeAvailable) {
        const boundary = target.blockingReason || plan.boundaryReason || "no-executable-action";
        const reason = String(boundary).startsWith("waiting-") ? boundary : `waiting-${boundary}`;
        return { ok: true, executed: execute, reason, targetSlot: this.targetSlot, actions, state, plan };
      }
      if (!execute) return { ok: true, executed: false, reason: "planned", targetSlot: this.targetSlot, nextAction: { type: state.board.mergeCandidates.length ? "merge" : "produce", producer }, actions, state, plan };
      const boardResult = await this.runBoardAction({ producer, signal });
      const verified = boardResult.ok && (boardResult.actions?.length > 0 || boardResult.stopReason === "order_ready");
      actions.push({ step: actions.length + 1, type: boardResult.actions?.[0]?.type || "board-boundary", producer, ok: verified, reason: boardResult.stopReason || boardResult.reason, diff: boardResult.actions?.[0] || null });
      this.onEvent?.(actions.at(-1));
      if (!verified) return { ok: false, executed: true, reason: boardResult.reason || boardResult.stopReason || "board-action-failed", targetSlot: this.targetSlot, actions, boardResult };
    }
    return { ok: true, executed: execute, reason: "max-actions-reached", targetSlot: this.targetSlot, actions };
  }
}

module.exports = { OrderCoinLoop, selectWarehouseCandidate };
