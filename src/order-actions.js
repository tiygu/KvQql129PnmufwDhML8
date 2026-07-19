"use strict";

const { waitForDelay } = require("./abortable-delay");

function buildAtomicSubmitOrderExpression(slot) {
  const slotLiteral = JSON.stringify(String(slot));
  return `(() => {
    const G = globalThis;
    const cc = G.cc || G.GameGlobal?.cc;
    const scene = cc?.director?.getScene?.();
    const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
    const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
    const controller = runtime?.mControllers?.find((item) => item?._controllerClazzName === "UserBoardViewController");
    const taskView = controller?.view?._boardView?._taskView;
    if (!controller || !taskView) return { ok: false, reason: "order_runtime_not_found" };
    if (!controller.isViewVisible) return { ok: false, reason: "board_not_visible" };
    const slot = ${slotLiteral};
    const taskItemData = taskView._taskItemDataMap?.get?.(slot);
    const task = taskItemData?.task;
    const items = Array.isArray(task?.itemInfos) ? task.itemInfos : [];
    if (!task) return { ok: false, reason: "order_slot_not_found", slot };
    if (!items.length || !items.every((item) => !!item.isComplete)) return { ok: false, reason: "order_not_ready", slot, taskId: task.taskId ?? null };
    if (task._inSubmit) return { ok: false, reason: "order_already_submitting", slot, taskId: task.taskId ?? null };
    const buttonLayer = (taskView.childViews || []).find((layer) => layer?.type === 6 && layer?.taskItemMap instanceof Map);
    const buttonView = buttonLayer?.taskItemMap?.get?.(slot);
    if (!buttonView || typeof buttonView.submitTask !== "function") return { ok: false, reason: "order_submit_handler_not_found", slot };
    buttonView.submitTask();
    return { ok: true, type: "submit-order", slot, taskId: task.taskId ?? null };
  })()`;
}

class OrderSubmitter {
  constructor({ client, contextId, collectState, settleMs = 2500, evaluateTimeoutMs = 10000 }) {
    this.client = client;
    this.contextId = contextId;
    this.collectState = collectState;
    this.settleMs = Math.max(300, Number(settleMs));
    this.evaluateTimeoutMs = Math.max(5000, Number(evaluateTimeoutMs));
  }

  async submit(slot, { execute = false, signal = null } = {}) {
    const before = await this.collectState(signal);
    const order = before.orders.find((item) => String(item.slot) === String(slot));
    if (!order) return { ok: false, executed: false, reason: "order_slot_not_found", slot: String(slot), before };
    if (!order.ready) return { ok: false, executed: false, reason: "order_not_ready", order, before };
    if (!execute) return { ok: true, executed: false, reason: "ready-to-submit", order, before };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", order, before };
    const acknowledgement = await this.client.evaluate(buildAtomicSubmitOrderExpression(slot), this.contextId, { timeoutMs: this.evaluateTimeoutMs, signal });
    if (!acknowledgement?.ok) return { ok: false, executed: true, reason: acknowledgement?.reason || "submit-rejected", acknowledgement, before };
    if (!await waitForDelay(this.settleMs, signal)) return { ok: false, executed: true, reason: "aborted", acknowledgement, before };
    const after = await this.collectState(signal);
    const replacement = after.orders.find((item) => String(item.slot) === String(slot));
    const orderChanged = !replacement || String(replacement.taskId) !== String(order.taskId);
    const coinsGained = Number(after.resources.coins) > Number(before.resources.coins);
    return {
      ok: orderChanged && coinsGained,
      executed: true,
      reason: orderChanged && coinsGained ? "order-submitted-and-coins-received" : orderChanged ? "order-replaced-but-coins-not-observed" : "order-submit-not-observed",
      acknowledgement,
      orderBefore: order,
      orderAfter: replacement || null,
      coinsBefore: before.resources.coins,
      coinsAfter: after.resources.coins,
      before,
      after,
    };
  }
}

module.exports = { buildAtomicSubmitOrderExpression, OrderSubmitter };
