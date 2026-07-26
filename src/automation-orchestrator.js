"use strict";

const { isPlanActionable } = require("./plan-actionability");

const AUTOMATION_STATES = Object.freeze({
  observing: "observing",
  planning: "planning",
  producing: "producing",
  merging: "merging",
  orderReady: "order-ready",
  submitting: "submitting",
  waitingEnergy: "waiting-energy",
  paused: "paused",
});

/**
 * Rolling, one-action-at-a-time coordinator. Runtime collection, planning and
 * execution are injected so this module stays testable and reusable by CLI and the control server.
 */
class AutomationOrchestrator {
  constructor({ collectState, planOrders, executeAction = null, minimumEnergy = 1, autoSubmitOrders = false, onEvent = null }) {
    if (typeof collectState !== "function") throw new Error("collectState must be a function");
    if (typeof planOrders !== "function") throw new Error("planOrders must be a function");
    this.collectState = collectState;
    this.planOrders = planOrders;
    this.executeAction = executeAction;
    this.minimumEnergy = Math.max(0, Number(minimumEnergy));
    this.autoSubmitOrders = !!autoSubmitOrders;
    this.onEvent = onEvent;
    this.targetOrderSlot = null;
    this.status = AUTOMATION_STATES.observing;
    this.sequence = 0;
  }

  emit(type, details = {}) {
    const event = { sequence: ++this.sequence, at: new Date().toISOString(), type, status: this.status, ...details };
    this.onEvent?.(event);
    return event;
  }

  setTargetOrder(slot) {
    this.targetOrderSlot = slot == null || slot === "" ? null : String(slot);
    this.emit("target-order-changed", { targetOrderSlot: this.targetOrderSlot });
  }

  selectTarget(plan, state) {
    const actionContext = { hasMergeCandidate: (state.board?.mergeCandidates || []).length > 0 };
    const actionable = (candidate) => isPlanActionable(candidate, actionContext);
    if (this.targetOrderSlot) {
      const locked = plan.plans?.find((item) => String(item.slot) === this.targetOrderSlot);
      if (actionable(locked)) return locked;
      this.emit("target-order-released", {
        previousTargetOrderSlot: this.targetOrderSlot,
        reason: locked ? (locked.blockingReason || "order-has-no-next-action") : "order-disappeared",
      });
      this.targetOrderSlot = null;
    }
    const selected = actionable(plan.recommended)
      ? plan.recommended
      : plan.plans?.find(actionable) || null;
    if (selected) {
      this.targetOrderSlot = String(selected.slot);
      this.emit("target-order-locked", { targetOrderSlot: this.targetOrderSlot });
    }
    return selected;
  }

  decide(state, plan, target) {
    if (!target) return { status: AUTOMATION_STATES.paused, reason: plan.boundaryReason || "no-feasible-order", action: null };
    const liveOrder = state.orders?.find((order) => String(order.slot) === String(target.slot));
    if (liveOrder?.ready || target.ready) return this.autoSubmitOrders
      ? { status: AUTOMATION_STATES.submitting, reason: "target-order-ready", action: { type: "submit-order", slot: String(target.slot), taskId: liveOrder?.taskId ?? target.taskId ?? null } }
      : { status: AUTOMATION_STATES.orderReady, reason: "target-order-ready", action: null };
    if (Number(state.resources?.energy ?? 0) < this.minimumEnergy) return { status: AUTOMATION_STATES.waitingEnergy, reason: "energy-below-threshold", action: null };
    const merge = state.board?.mergeCandidates?.[0];
    if (merge) return {
      status: AUTOMATION_STATES.merging,
      reason: "safe-merge-available",
      action: { type: "merge", from: merge.from, to: merge.to, itemId: String(merge.itemId), expectedTarget: merge.mergeTarget ?? null },
    };
    const producerStep = target.producerSteps?.[0];
    if (producerStep) return {
      status: AUTOMATION_STATES.producing,
      reason: "target-needs-production",
      action: { type: "produce", producer: producerStep.gridIndex, producerItemId: String(producerStep.producerItemId), plannedClicks: producerStep.clicks },
    };
    return { status: AUTOMATION_STATES.paused, reason: "target-has-no-next-action", action: null };
  }

  async step({ execute = false, signal = null } = {}) {
    if (signal?.aborted) return { ok: false, executed: false, status: AUTOMATION_STATES.paused, reason: "aborted" };
    this.status = AUTOMATION_STATES.observing;
    const before = await this.collectState();
    this.status = AUTOMATION_STATES.planning;
    const plan = await this.planOrders(before);
    const target = this.selectTarget(plan, before);
    const decision = this.decide(before, plan, target);
    this.status = decision.status;
    this.emit("decision", { targetOrderSlot: this.targetOrderSlot, reason: decision.reason, action: decision.action });
    if (!execute || !decision.action) return { ok: true, executed: false, state: before, plan, target, ...decision };
    if (typeof this.executeAction !== "function") throw new Error("executeAction is required when execute=true");
    if (signal?.aborted) return { ok: false, executed: false, status: AUTOMATION_STATES.paused, reason: "aborted" };
    const acknowledgement = await this.executeAction(decision.action, { signal });
    const after = await this.collectState();
    const changed = before.board?.signature !== after.board?.signature
      || before.resources?.energy !== after.resources?.energy
      || JSON.stringify(before.orders) !== JSON.stringify(after.orders);
    const result = { ok: !!acknowledgement?.ok && changed, executed: true, status: decision.status, reason: changed ? "action-verified" : "no-state-change", action: decision.action, acknowledgement, before, after, target, plan };
    this.emit("action-result", { ok: result.ok, reason: result.reason, action: decision.action });
    if (!result.ok) this.status = AUTOMATION_STATES.paused;
    return result;
  }
}

module.exports = { AutomationOrchestrator, AUTOMATION_STATES };
