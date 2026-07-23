"use strict";

class FullAutomationLoop {
  constructor({ collectState, navigate, runOrderCycle, completeMapMission, autoMapUpgrade = false, onEvent = null, waitIfPaused = null }) {
    this.collectState = collectState;
    this.navigate = navigate;
    this.runOrderCycle = runOrderCycle;
    this.completeMapMission = completeMapMission;
    this.autoMapUpgrade = !!autoMapUpgrade;
    this.onEvent = onEvent;
    this.waitIfPaused = waitIfPaused;
  }

  async run({ execute = false, maxActions = null, signal = null } = {}) {
    const requestedLimit = Number(maxActions);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.max(1, Math.floor(requestedLimit))
      : Infinity;
    const actions = [];
    for (let index = 0; index < limit; index += 1) {
      if (signal?.aborted) return { ok: false, executed: execute, reason: "aborted", actions };
      await this.waitIfPaused?.(signal);
      const state = await this.collectState(signal);
      if (state.mapMission?.canComplete) {
        if (!this.autoMapUpgrade) return { ok: true, executed: execute, reason: "map-upgrade-awaiting-confirmation", nextAction: { type: "complete-map-mission", missionId: state.mapMission.id }, state, actions };
        if (state.scene === "board") {
          if (!execute) return { ok: true, executed: false, reason: "planned", nextAction: { type: "navigate", target: "map" }, state, actions };
          const result = await this.navigate("map", { signal });
          actions.push({ type: "navigate", target: "map", ok: result.ok, reason: result.reason, before: result.before, after: result.after, navigationActions: result.actions || [], verificationAttempts: result.verificationAttempts ?? null });
          this.onEvent?.(actions.at(-1));
          if (!result.ok) return { ok: false, executed: true, reason: result.reason, actions, navigation: result };
          continue;
        }
        if (!execute) return { ok: true, executed: false, reason: "planned", nextAction: { type: "complete-map-mission", missionId: state.mapMission.id }, state, actions };
        const result = await this.completeMapMission({ signal });
        actions.push({ type: "complete-map-mission", missionId: state.mapMission.id, ok: result.ok, reason: result.reason, before: result.before, after: result.after, coinsBefore: result.coinsBefore, coinsAfter: result.coinsAfter });
        this.onEvent?.(actions.at(-1));
        if (!result.ok) return { ok: false, executed: true, reason: result.reason, actions, mapCompletion: result };
        continue;
      }

      if (state.scene !== "board") {
        if (!execute) return { ok: true, executed: false, reason: "planned", nextAction: { type: "navigate", target: "board" }, state, actions };
        const result = await this.navigate("board", { signal });
        actions.push({ type: "navigate", target: "board", ok: result.ok, reason: result.reason, before: result.before, after: result.after, navigationActions: result.actions || [], verificationAttempts: result.verificationAttempts ?? null });
        this.onEvent?.(actions.at(-1));
        if (!result.ok) {
          if (result.replanRequested && result.replanState) {
            // Navigation failed due to stale state; retry with the fresh state it returned.
            state = result.replanState;
            continue;
          }
          return { ok: false, executed: true, reason: result.reason, actions, navigation: result };
        }
        continue;
      }

      const remainingActions = Number.isFinite(limit) ? Math.max(1, limit - actions.length) : null;
      const result = await this.runOrderCycle({ execute, maxActions: remainingActions, signal, initialState: state });
      if (!execute) return { ...result, state, actions, nextAction: result.nextAction };
      if (result.ok && (result.reason === "evidence-waiting" || String(result.reason || "").startsWith("waiting-"))) {
        return { ok: true, executed: true, reason: result.reason, state, actions, orderCycle: result };
      }
      if (result.ok && result.reason === "energy-depleted") return { ok: true, executed: true, reason: "energy-depleted", state, actions, orderCycle: result };
      const cycleActions = result.actions?.length ? result.actions : [{ type: "order-cycle", ok: result.ok, reason: result.reason }];
      actions.push(...cycleActions);
      for (const action of cycleActions) this.onEvent?.(action);
      if (!result.ok) return { ok: false, executed: true, reason: result.reason, actions, orderCycle: result };
      const submitted = cycleActions.find((action) => action.type === "submit-order" && action.ok !== false);
      if (submitted) {
        return { ok: true, executed: true, reason: "order-completed", completedOrder: submitted.slot, actions, orderCycle: result };
      }
      if (Number.isFinite(limit) && actions.length >= limit) return { ok: true, executed: true, reason: "max-actions-reached", actions, orderCycle: result };
    }
    return { ok: true, executed: execute, reason: "max-actions-reached", actions };
  }
}

module.exports = { FullAutomationLoop };
