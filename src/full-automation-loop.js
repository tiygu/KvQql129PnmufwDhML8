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
      const state = await this.collectState();
      if (state.mapMission?.canComplete) {
        if (!this.autoMapUpgrade) return { ok: true, executed: execute, reason: "map-upgrade-awaiting-confirmation", nextAction: { type: "complete-map-mission", missionId: state.mapMission.id }, state, actions };
        if (state.scene === "board") {
          if (!execute) return { ok: true, executed: false, reason: "planned", nextAction: { type: "navigate", target: "map" }, state, actions };
          const result = await this.navigate("map", { signal });
          actions.push({ type: "navigate", target: "map", ok: result.ok, reason: result.reason });
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
        actions.push({ type: "navigate", target: "board", ok: result.ok, reason: result.reason });
        this.onEvent?.(actions.at(-1));
        if (!result.ok) return { ok: false, executed: true, reason: result.reason, actions, navigation: result };
        continue;
      }

      const result = await this.runOrderCycle({ execute, maxActions: 1, signal });
      if (!execute) return { ...result, state, actions, nextAction: result.nextAction };
      if (result.ok && (result.reason === "evidence-waiting" || String(result.reason || "").startsWith("waiting-"))) {
        return { ok: true, executed: true, reason: result.reason, state, actions, orderCycle: result };
      }
      const action = result.actions?.[0] || { type: "order-cycle", ok: result.ok, reason: result.reason };
      actions.push(action);
      this.onEvent?.(action);
      if (!result.ok) return { ok: false, executed: true, reason: result.reason, actions, orderCycle: result };
      if (action.type === "submit-order" && action.ok !== false) {
        return { ok: true, executed: true, reason: "order-completed", completedOrder: action.slot, actions, orderCycle: result };
      }
    }
    return { ok: true, executed: execute, reason: "max-actions-reached", actions };
  }
}

module.exports = { FullAutomationLoop };
