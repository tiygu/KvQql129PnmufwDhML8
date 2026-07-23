"use strict";

const { waitForDelay } = require("./abortable-delay");
const { productionModeRuntimeHelpersPrelude } = require("./production-mode-runtime");

const BOARD_CONTROL_STATE_EXPRESSION = `(() => {
  ${runtimePrelude(false)}
  const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };
  ${productionModeRuntimeHelpersPrelude()}
  const taskManager = (runtime?.mManagers || []).find((manager) => manager?.clientTaskDataMap instanceof Map);
  const orders = [];
  const requiredCounts = new Map();
  const root = taskManager?.clientTaskDataMap;
  if (root instanceof Map) {
    for (const nested of root.values()) {
      if (!(nested instanceof Map)) continue;
      for (const [slot, task] of nested.entries()) {
        const items = (Array.isArray(task?.itemInfos) ? task.itemInfos : []).map((item) => ({
          itemId: String(safe(() => item.itemId, "")),
          complete: !!safe(() => item.isComplete, false)
        }));
        for (const item of items) if (item.itemId) requiredCounts.set(item.itemId, (requiredCounts.get(item.itemId) || 0) + 1);
        orders.push({
          slot: String(slot),
          taskId: safe(() => task.taskId, null),
          rewardCoins: safe(() => task.rewards?.find?.((reward) => Number(reward.type) === 1)?.count, null),
          items,
          ready: items.length > 0 && items.every((item) => item.complete)
        });
      }
    }
  }
  const describe = (grid) => ({
    index: grid.index,
    itemId: String(safe(() => grid.itemId, "")),
    empty: !!safe(() => grid.isEmpty, true),
    normal: !!safe(() => grid.isNormal, false),
    moveable: !!safe(() => grid.isMoveable, false),
    locked: !!grid.isLocking,
    frozen: !!safe(() => grid.isFrozen, false),
    actionReady: !!safe(() => boardView.canBoardGridBeDragging(grid), false) && !safe(() => boardView.isBoardGridItemAnimating(grid), false),
    taskNeed: !!safe(() => grid.item?.taskNeed, false),
    level: safe(() => grid.item.itemConfig.Level, null),
    mergeTarget: safe(() => grid.item.itemConfig.MergeTarget, null),
    produceCount: safe(() => grid.item.produceCount, null),
    energyCost: safe(() => grid.item.itemConfig.EnergyCost, null),
    saleValue: safe(() => grid.item.itemConfig.Price, null),
    currentProductionModeId: productionModeCurrentFor(grid),
    availableProductionModes: productionModesFor(grid),
    productionModeSwitchEntry: { status: productionModeSwitchMethod ? "available" : "unavailable", method: productionModeSwitchMethod }
  });
  const boardGrids = grids.map(describe);
  const groups = new Map();
  for (const grid of grids) {
    const itemId = String(safe(() => grid.itemId, ""));
    if (!itemId || !safe(() => grid.isNormal, false) || !safe(() => grid.isMoveable, false) || grid.isLocking || safe(() => grid.isFrozen, false)) continue;
    if (typeof safe(() => grid.item?.produceCount) === "number" && Number(safe(() => grid.item?.itemConfig?.EnergyCost, 0)) > 0) continue;
    if (!groups.has(itemId)) groups.set(itemId, []);
    groups.get(itemId).push(grid);
  }
  const mergeCandidates = [];
  for (const [itemId, values] of groups) {
    values.sort((left, right) => Number(!!safe(() => left.item?.taskNeed, false)) - Number(!!safe(() => right.item?.taskNeed, false)));
    const usable = values.slice(0, Math.max(0, values.length - (requiredCounts.get(itemId) || 0)));
    for (let index = 0; index + 1 < usable.length; index += 2) {
      const source = usable[index], target = usable[index + 1];
      if (!safe(() => boardView._operatorCenter.itemCanMergeWith(source.item, target.item), false)) continue;
      mergeCandidates.push({
        itemId,
        from: source.index,
        to: target.index,
        mergeTarget: safe(() => source.item.itemConfig.MergeTarget, null),
        level: safe(() => source.item.itemConfig.Level, null),
        predictedResult: safe(() => boardView._dragHandler.predictDragResult(source, target), null)
      });
    }
  }
  const producers = grids.filter((grid) =>
    grid.item && typeof safe(() => grid.item.produceCount) === "number" &&
    Number(safe(() => grid.item.itemConfig.EnergyCost, 0)) > 0 &&
    Number(safe(() => grid.item.produceCount, 0)) > 0 && !grid.isLocking
  ).map(describe);
  return {
    ok: true,
    boardVisible: !!controller.isViewVisible,
    width: safe(() => gameBoard.size.width),
    height: safe(() => gameBoard.size.height),
    signature: boardGrids.map((grid) => grid.itemId).join("|"),
    occupied: boardGrids.filter((grid) => !grid.empty).length,
    empty: boardGrids.filter((grid) => grid.empty).length,
    grids: boardGrids,
    orders,
    readyOrders: orders.filter((order) => order.ready),
    requiredItemCounts: Object.fromEntries(requiredCounts),
    mergeCandidates,
    producers
  };
})()`;

function runtimePrelude(requireVisible = true) {
  return `
    const G = globalThis;
    const cc = G.cc || G.GameGlobal?.cc;
    const scene = cc?.director?.getScene?.();
    const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
    const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
    const controller = runtime?.mControllers?.find((item) => item?._controllerClazzName === "UserBoardViewController");
    const boardView = controller?.view?._boardView?._gameBoardView;
    const gameBoard = boardView?._boardStore?._state?._gameBoard;
    const grids = gameBoard?.__private_95_grids;
    if (!controller || !boardView || !Array.isArray(grids)) return { ok: false, reason: "board_runtime_not_found" };
    ${requireVisible ? "if (!controller.isViewVisible) return { ok: false, reason: \"board_not_visible\" };" : ""}
  `;
}

function buildAtomicProducerTouchExpression(index, expectedProductionModeId = null) {
  const gridIndex = Number(index);
  if (!Number.isInteger(gridIndex)) throw new Error("producer index must be an integer");
  const expectedMode = JSON.stringify(expectedProductionModeId == null ? null : String(expectedProductionModeId));
  return `(() => {${runtimePrelude()}
    const grid = grids[${gridIndex}];
    if (!grid?.item || typeof grid.item.produceCount !== "number" || Number(grid.item.itemConfig?.EnergyCost || 0) <= 0) {
      return { ok: false, reason: "selected_grid_is_not_producer", index: ${gridIndex} };
    }
    ${productionModeRuntimeHelpersPrelude()}
    const expectedModeId=${expectedMode},currentModeId=productionModeCurrentFor(grid);
    if(expectedModeId!=null&&currentModeId!==expectedModeId)return{ok:false,reason:"production_mode_mismatch",index:${gridIndex},expectedModeId,currentModeId};
    const selectedBefore = boardView._touchHandler?.currentSelectedBoardGrid?.index ?? null;
    boardView.onTouch(grid.center);
    return { ok: true, type: "producer-touch", index: grid.index, itemId: String(grid.itemId || ""), selectedBefore };
  })()`;
}

function buildAtomicMergeExpression(from, to) {
  const sourceIndex = Number(from);
  const targetIndex = Number(to);
  if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex) || sourceIndex === targetIndex) throw new Error("merge indexes must be distinct integers");
  return `(async () => {${runtimePrelude()}
    const source = grids[${sourceIndex}], target = grids[${targetIndex}];
    if (!source || !target) return { ok: false, reason: "grid_not_found", from: ${sourceIndex}, to: ${targetIndex} };
    const canMerge = !!boardView._operatorCenter.itemCanMergeWith(source.item, target.item);
    if (!canMerge) return { ok: false, reason: "pair_not_mergeable", from: ${sourceIndex}, to: ${targetIndex} };
    const before = { sourceItemId: String(source.itemId || ""), targetItemId: String(target.itemId || ""), expectedTarget: source.item?.itemConfig?.MergeTarget ?? null };
    boardView.onDragStart(source.center);
    boardView.onDragMove(source.center, target.center);
    await Promise.resolve(boardView.onDragEnd(source.center, target.center));
    return { ok: true, type: "merge", from: source.index, to: target.index, before };
  })()`;
}

class BoardAutomationRunner {
  constructor(options) {
    this.client = options.client;
    this.contextId = options.contextId;
    this.delayMs = Math.max(50, Math.min(250, Number(options.pollIntervalMs ?? options.delayMs ?? 100)));
    this.pollIntervalMs = this.delayMs;
    this.confirmationTimeoutMs = Math.max(300, Math.min(5000, Number(options.confirmationTimeoutMs ?? 1000)));
    this.evaluateTimeoutMs = Math.max(5000, Number(options.evaluateTimeoutMs ?? 10000));
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.wait = typeof options.wait === "function" ? options.wait : waitForDelay;
  }

  evaluate(expression, signal = null, timeoutMs = this.evaluateTimeoutMs) {
    return this.client.evaluate(expression, this.contextId, { timeoutMs: Math.max(50, Math.min(this.evaluateTimeoutMs, Number(timeoutMs) || this.evaluateTimeoutMs)), signal });
  }

  readState(signal = null, timeoutMs = this.evaluateTimeoutMs) {
    return this.evaluate(BOARD_CONTROL_STATE_EXPRESSION, signal, timeoutMs);
  }

  async waitForSettle(signal = null) {
    return this.wait(this.pollIntervalMs, signal);
  }

  async readUntilConfirmed(beforeSignature, { signal = null, requireChange = true } = {}) {
    const startedAt = this.now();
    const maximumPolls = Math.ceil(this.confirmationTimeoutMs / this.pollIntervalMs) + 1;
    let state = null;
    for (let poll = 0; poll < maximumPolls; poll += 1) {
      const elapsed = this.now() - startedAt;
      if (requireChange && elapsed >= this.confirmationTimeoutMs) break;
      if (await this.waitForSettle(signal) === false) return { ok: false, reason: "aborted", elapsedMs: this.now() - startedAt };
      const remaining = Math.max(50, this.confirmationTimeoutMs - (this.now() - startedAt));
      try {
        state = await this.readState(signal, requireChange ? remaining : Math.min(remaining, this.confirmationTimeoutMs));
      } catch (error) {
        if (requireChange && this.now() - startedAt >= this.confirmationTimeoutMs) break;
        return { ok: false, reason: "verification_read_error", error: error.message, elapsedMs: this.now() - startedAt };
      }
      if (!state?.ok || state.signature !== beforeSignature || !requireChange) return { ok: true, state, elapsedMs: this.now() - startedAt };
    }
    return { ok: false, reason: "action_confirmation_timeout", state, elapsedMs: Math.min(this.confirmationTimeoutMs, this.now() - startedAt), pauseRequested: true };
  }

  async waitUntilMergeReady(state, candidate, signal = null) {
    const startedAt = this.now();
    const maximumPolls = Math.ceil(this.confirmationTimeoutMs / this.pollIntervalMs) + 1;
    let current = state;
    for (let poll = 0; poll < maximumPolls; poll += 1) {
      const source = current.grids.find((grid) => Number(grid.index) === Number(candidate.from));
      const target = current.grids.find((grid) => Number(grid.index) === Number(candidate.to));
      if (source?.actionReady !== false && target?.actionReady !== false) return { ok: true, state: current };
      if (this.now() - startedAt >= this.confirmationTimeoutMs) break;
      if (await this.waitForSettle(signal) === false) return { ok: false, reason: "aborted", state: current };
      try {
        current = await this.readState(signal, Math.max(50, this.confirmationTimeoutMs - (this.now() - startedAt)));
      } catch (error) {
        return { ok: false, reason: "verification_read_error", error: error.message, state: current };
      }
      const stillAvailable = current?.mergeCandidates?.some((entry) => Number(entry.from) === Number(candidate.from) && Number(entry.to) === Number(candidate.to));
      if (!current?.ok || !stillAvailable) return { ok: false, reason: "planned_merge_not_available", state: current };
    }
    return { ok: false, reason: "merge_not_ready_timeout", state: current, timing: { stage: "action-readiness", elapsedMs: this.now() - startedAt, budgetMs: this.confirmationTimeoutMs } };
  }

  async executeAtomicAndRead(expression, uncertainAction, rejectedReason, signal = null, confirmation = {}) {
    let acknowledgement;
    try {
      acknowledgement = await this.evaluate(expression, signal);
    } catch (error) {
      return { ok: false, failure: { ok: false, executed: true, reason: "atomic_action_error", error: error.message, uncertainAction } };
    }
    if (!acknowledgement?.ok) return { ok: false, failure: { ok: false, executed: true, reason: acknowledgement?.reason || rejectedReason, failedAction: acknowledgement } };
    const confirmed = await this.readUntilConfirmed(confirmation.beforeSignature, { signal, requireChange: confirmation.requireChange !== false });
    if (!confirmed.ok) return { ok: false, failure: { ok: false, executed: true, reason: confirmed.reason, error: confirmed.error, uncertainAction, pauseRequested: !!confirmed.pauseRequested, timing: { stage: "action-confirmation", elapsedMs: confirmed.elapsedMs, budgetMs: this.confirmationTimeoutMs } } };
    return { ok: true, acknowledgement, state: confirmed.state, timing: { stage: "action-confirmation", elapsedMs: confirmed.elapsedMs, budgetMs: this.confirmationTimeoutMs } };
  }

  async run(options = {}) {
    const maxActions = Math.max(1, Math.min(100, Number(options.maxActions ?? 10)));
    const requestedProducer = options.producer == null || options.producer === "" ? null : Number(options.producer);
    if (requestedProducer != null && !Number.isInteger(requestedProducer)) throw new Error("board-auto requires an integer --producer index");
    const requestedMerge = options.merge == null ? null : { from: Number(options.merge.from), to: Number(options.merge.to) };
    if (requestedMerge && (!Number.isInteger(requestedMerge.from) || !Number.isInteger(requestedMerge.to) || requestedMerge.from === requestedMerge.to)) throw new Error("board-auto requires distinct integer merge indexes");
    const targetOrderSlot = options.plannedAction?.targetOrderSlot == null ? null : String(options.plannedAction.targetOrderSlot);
    const boundaryOrders = (current) => {
      const readyOrders = Array.isArray(current?.readyOrders) ? current.readyOrders : [];
      return targetOrderSlot == null
        ? readyOrders
        : readyOrders.filter((order) => String(order.slot) === targetOrderSlot);
    };
    const execute = !!options.execute;
    let state;
    try {
      state = await this.readState(options.signal);
    } catch (error) {
      return { ok: false, executed: false, reason: "state_read_error", error: error.message };
    }
    if (!state?.ok) return { ok: false, executed: false, reason: state?.reason || "state_read_failed" };
    const selectedProducer = requestedProducer == null ? state.producers[0] : state.producers.find((item) => item.index === requestedProducer);
    const preview = { candidates: state.mergeCandidates, producers: state.producers, selectedProducer: selectedProducer || null, empty: state.empty };
    if (!execute) return { ok: true, executed: false, maxActions, delayMs: this.delayMs, preview };
    if (!state.boardVisible) return { ok: false, executed: false, reason: "board_not_visible", preview };
    if (!selectedProducer && (!state.mergeCandidates.length || options.plannedAction?.type === "produce")) return { ok: false, executed: false, reason: "producer_not_found", preview };
    if (requestedMerge && !state.mergeCandidates.some((candidate) => Number(candidate.from) === requestedMerge.from && Number(candidate.to) === requestedMerge.to)) return { ok: false, executed: false, reason: "planned_merge_not_available", preview, requestedMerge };

    const actions = [];
    let stopReason = "max_actions_reached";
    for (let step = 0; step < maxActions; step += 1) {
      if (options.signal?.aborted) { stopReason = "aborted"; break; }
      if (!state.boardVisible) { stopReason = "board_not_visible"; break; }
      if (boundaryOrders(state).length) { stopReason = "order_ready"; break; }
      let before = state;
      if (state.mergeCandidates.length && options.plannedAction?.type !== "produce") {
        let candidate = requestedMerge
          ? state.mergeCandidates.find((entry) => Number(entry.from) === requestedMerge.from && Number(entry.to) === requestedMerge.to)
          : state.mergeCandidates[0];
        const readiness = await this.waitUntilMergeReady(state, candidate, options.signal);
        if (!readiness.ok) return { ok: false, executed: false, reason: readiness.reason, error: readiness.error, timing: readiness.timing, actions };
        state = readiness.state;
        before = state;
        candidate = state.mergeCandidates.find((entry) => Number(entry.from) === Number(candidate.from) && Number(entry.to) === Number(candidate.to));
        if (!candidate) return { ok: false, executed: false, reason: "planned_merge_not_available", actions };
        const execution = await this.executeAtomicAndRead(buildAtomicMergeExpression(candidate.from, candidate.to), { type: "merge", from: candidate.from, to: candidate.to }, "merge_rejected", options.signal, { beforeSignature: before.signature, requireChange: true });
        if (!execution.ok) return { ...execution.failure, actions };
        state = execution.state;
        const source = state.grids.find((grid) => grid.index === candidate.from), target = state.grids.find((grid) => grid.index === candidate.to);
        const changed = state.signature !== before.signature;
        const verified = changed && source?.empty && (!candidate.mergeTarget || String(target?.itemId) === String(candidate.mergeTarget));
        actions.push({ step: step + 1, type: "merge", from: candidate.from, to: candidate.to, itemId: candidate.itemId, expectedTarget: candidate.mergeTarget, actualTarget: target?.itemId ?? null, verified });
        if (!verified) { stopReason = changed ? "merge_verification_failed" : "no_state_change"; break; }
      } else {
        if (state.empty <= 0) { stopReason = "board_full"; break; }
        let touches = 1;
        const expectedModeId = options.plannedAction?.productionModeId ?? null;
        const uncertainAction = { type: "producer-touch", producer: selectedProducer.index, producerItemId: selectedProducer.itemId, productionModeId: expectedModeId ?? selectedProducer.currentProductionModeId ?? null, attributable: false, uncertain: true };
        if (expectedModeId != null && String(selectedProducer.currentProductionModeId) !== String(expectedModeId)) return { ok: false, executed: false, reason: "production_mode_mismatch", expectedModeId: String(expectedModeId), currentModeId: selectedProducer.currentProductionModeId, actions };
        const firstExecution = await this.executeAtomicAndRead(buildAtomicProducerTouchExpression(selectedProducer.index, expectedModeId), uncertainAction, "producer_touch_rejected", options.signal, { beforeSignature: before.signature, requireChange: false });
        if (!firstExecution.ok) return { ...firstExecution.failure, actions };
        state = firstExecution.state;
        if (state.signature === before.signature) {
          touches = 2;
          const secondExecution = await this.executeAtomicAndRead(buildAtomicProducerTouchExpression(selectedProducer.index, expectedModeId), uncertainAction, "producer_touch_rejected", options.signal, { beforeSignature: before.signature, requireChange: true });
          if (!secondExecution.ok) return { ...secondExecution.failure, actions };
          state = secondExecution.state;
        }
        const verified = state.signature !== before.signature;
        const previousItems = new Map(before.grids.map((grid) => [grid.index, String(grid.itemId || "")]));
        const actualOutputItemIds = state.grids.filter((grid) => grid.index !== selectedProducer.index && grid.itemId && previousItems.get(grid.index) !== String(grid.itemId)).map((grid) => String(grid.itemId));
        actions.push({ step: step + 1, type: "produce", producer: selectedProducer.index, producerItemId: selectedProducer.itemId, productionModeId: expectedModeId ?? selectedProducer.currentProductionModeId ?? null, actualOutputItemIds, touches, emptyBefore: before.empty, emptyAfter: state.empty, verified });
        if (!verified) { stopReason = "no_state_change"; break; }
      }
      if (!state?.ok) { stopReason = state?.reason || "state_read_failed"; break; }
      if (boundaryOrders(state).length) { stopReason = "order_ready"; break; }
    }
    return {
      ok: actions.every((action) => action.verified),
      executed: true,
      producer: selectedProducer,
      actions,
      stopReason,
      completedBoundary: boundaryOrders(state),
      observedState: state,
      final: { empty: state.empty, remainingCandidates: state.mergeCandidates.length, signature: state.signature }
    };
  }
}

function printBoardRunnerResult(result, output = console) {
  if (!result?.ok) {
    output.log(`链式自动化未完成：${result?.reason || result?.stopReason || "unknown"}`);
    if (result?.actions?.length) output.table(formatActions(result.actions));
    return;
  }
  if (!result.executed) {
    output.log(`链式预检：空格 ${result.preview.empty}，安全合成组合 ${result.preview.candidates.length}，可用产出物 ${result.preview.producers.length}`);
    output.table(result.preview.producers.map((item) => ({ 格子: item.index, 物品ID: item.itemId, 剩余产出: item.produceCount, 体力消耗: item.energyCost })));
    if (result.preview.selectedProducer) output.log(`默认产出物：格 ${result.preview.selectedProducer.index}（${result.preview.selectedProducer.itemId}）`);
    output.log("加入 --execute true 后开始Node侧单步循环。");
    return;
  }
  output.log(`链式自动化完成：执行 ${result.actions.length} 步，停止原因 ${result.stopReason}`);
  output.table(formatActions(result.actions));
  output.log(`最终空格：${result.final.empty}；剩余安全合成组合：${result.final.remainingCandidates}`);
  if (result.completedBoundary?.length) {
    output.log("已达到订单边界（订单物品全部满足，等待提交）：");
    output.table(result.completedBoundary.map((order) => ({ 槽位: order.slot, 订单ID: order.taskId, 奖励金币: order.rewardCoins, 物品ID: order.items.map((item) => item.itemId).join(", ") })));
  }
}

function formatActions(actions) {
  return actions.map((action) => action.type === "merge" ? {
    步骤: action.step,
    操作: "合成",
    来源: `${action.from}:${action.itemId}`,
    结果: `${action.to}:${action.actualTarget ?? "unknown"}`,
    验证: action.verified ? "通过" : "失败",
  } : {
    步骤: action.step,
    操作: "点击产出物",
    来源: `${action.producer}:${action.producerItemId}`,
    结果: `触摸${action.touches}次，空格 ${action.emptyBefore}→${action.emptyAfter}`,
    验证: action.verified ? "通过" : "失败",
  });
}

module.exports = {
  BOARD_CONTROL_STATE_EXPRESSION,
  buildAtomicProducerTouchExpression,
  buildAtomicMergeExpression,
  BoardAutomationRunner,
  printBoardRunnerResult,
};
