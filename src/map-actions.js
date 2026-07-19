"use strict";

const { waitForDelay } = require("./abortable-delay");

const MAP_MISSION_UI_STATE_EXPRESSION = `(() => {
  const cc = globalThis.cc || globalThis.GameGlobal?.cc;
  const scene = cc?.director?.getScene?.();
  const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
  const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
  const main = runtime?.mControllers?.find((item) => item?._controllerClazzName === "FieldMapMainViewController");
  const panel = runtime?.mControllers?.find((item) => item?._controllerClazzName === "AreaMissionInfoViewController");
  return { ok: !!main, mainVisible: !!main?.isViewVisible, panelVisible: !!panel?.isViewVisible, taskId: panel?.view?._taskId ?? panel?.mmTaskCfg?.id ?? null, canUpgrade: !!panel?.view?._canUpgrade, coinCost: panel?.view?.coinCostValue ?? panel?.mmTaskCfg?.NeedNum?.[0] ?? null, buttonClicked: !!panel?.view?._buttonClicked };
})()`;

const OPEN_MAP_MISSION_EXPRESSION = `(() => {
  const cc = globalThis.cc || globalThis.GameGlobal?.cc;
  const scene = cc?.director?.getScene?.();
  const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
  const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
  const main = runtime?.mControllers?.find((item) => item?._controllerClazzName === "FieldMapMainViewController");
  if (!main?.isViewVisible) return { ok: false, reason: "map_not_visible" };
  if (typeof main.lookAtMissionBubbleAndOpen !== "function") return { ok: false, reason: "map_mission_open_handler_not_found" };
  main.lookAtMissionBubbleAndOpen();
  return { ok: true, type: "open-map-mission" };
})()`;

const COMPLETE_MAP_MISSION_EXPRESSION = `(() => {
  const cc = globalThis.cc || globalThis.GameGlobal?.cc;
  const scene = cc?.director?.getScene?.();
  const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
  const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
  const panel = runtime?.mControllers?.find((item) => item?._controllerClazzName === "AreaMissionInfoViewController");
  if (!panel?.isViewVisible) return { ok: false, reason: "map_mission_panel_not_visible" };
  if (!panel.view?._canUpgrade) return { ok: false, reason: "map_mission_resources_insufficient", taskId: panel.view?._taskId ?? null };
  if (panel.view?._buttonClicked) return { ok: false, reason: "map_mission_already_submitting", taskId: panel.view?._taskId ?? null };
  if (typeof panel.upgrade !== "function") return { ok: false, reason: "map_mission_upgrade_handler_not_found" };
  const taskId = panel.view?._taskId ?? panel.mmTaskCfg?.id ?? null;
  panel.upgrade();
  return { ok: true, type: "complete-map-mission", taskId };
})()`;

class MapMissionCompleter {
  constructor({ client, contextId, collectState, settleMs = 2500, verifyTimeoutMs = 10000, verifyIntervalMs = 500, evaluateTimeoutMs = 10000 }) {
    this.client = client;
    this.contextId = contextId;
    this.collectState = collectState;
    this.settleMs = Math.max(300, Number(settleMs));
    this.verifyTimeoutMs = Math.max(this.settleMs, Number(verifyTimeoutMs));
    this.verifyIntervalMs = Math.max(100, Number(verifyIntervalMs));
    this.evaluateTimeoutMs = Math.max(5000, Number(evaluateTimeoutMs));
  }

  progressKey(state) {
    return String(state?.mapProgress?.currentTask ?? state?.mapMission?.id ?? "");
  }

  evaluate(expression, signal = null) {
    return this.client.evaluate(expression, this.contextId, { timeoutMs: this.evaluateTimeoutMs, signal });
  }

  async complete({ execute = false, signal = null } = {}) {
    const before = await this.collectState(signal);
    const uiBefore = await this.evaluate(MAP_MISSION_UI_STATE_EXPRESSION, signal);
    if (!before.mapMission) return { ok: false, executed: false, reason: "map_mission_not_found", before, uiBefore };
    if (!before.mapMission.canComplete) return { ok: false, executed: false, reason: "map_mission_resources_insufficient", before, uiBefore };
    if (!execute) return { ok: true, executed: false, reason: "ready-to-complete", before, uiBefore };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before, uiBefore };
    const acknowledgements = [];
    let ui = uiBefore;
    if (!ui.panelVisible) {
      const opened = await this.evaluate(OPEN_MAP_MISSION_EXPRESSION, signal);
      acknowledgements.push(opened);
      if (!opened?.ok) return { ok: false, executed: true, reason: opened?.reason || "map-mission-open-failed", acknowledgements, before };
      if (!await waitForDelay(this.settleMs, signal)) return { ok: false, executed: true, reason: "aborted", acknowledgements, before };
      ui = await this.evaluate(MAP_MISSION_UI_STATE_EXPRESSION, signal);
      if (!ui.panelVisible) return { ok: false, executed: true, reason: "map-mission-panel-not-observed", acknowledgements, before, ui };
    }
    if (signal?.aborted) return { ok: false, executed: true, reason: "aborted", acknowledgements, before, ui };
    const completed = await this.evaluate(COMPLETE_MAP_MISSION_EXPRESSION, signal);
    acknowledgements.push(completed);
    if (!completed?.ok) return { ok: false, executed: true, reason: completed?.reason || "map-mission-complete-failed", acknowledgements, before, ui };
    if (!await waitForDelay(this.settleMs, signal)) return { ok: false, executed: true, reason: "aborted", acknowledgements, before, ui };
    const progressBefore = this.progressKey(before);
    const deadline = Date.now() + this.verifyTimeoutMs;
    let after = await this.collectState(signal);
    let progressAfter = this.progressKey(after);
    let progressed = progressAfter !== progressBefore;
    let coinsSpent = Number(after.resources.coins) < Number(before.resources.coins);
    while ((!progressed || !coinsSpent) && Date.now() < deadline && !signal?.aborted) {
      if (!await waitForDelay(this.verifyIntervalMs, signal)) break;
      after = await this.collectState(signal);
      progressAfter = this.progressKey(after);
      progressed = progressAfter !== progressBefore;
      coinsSpent = Number(after.resources.coins) < Number(before.resources.coins);
    }
    const ok = progressed && coinsSpent;
    return { ok, executed: true, reason: ok ? "map-mission-completed" : signal?.aborted ? "aborted" : "map-mission-change-not-observed", acknowledgements, progressBefore, progressAfter, missionBefore: before.mapMission, missionAfter: after.mapMission, coinsBefore: before.resources.coins, coinsAfter: after.resources.coins, before, after };
  }
}

module.exports = { MAP_MISSION_UI_STATE_EXPRESSION, OPEN_MAP_MISSION_EXPRESSION, COMPLETE_MAP_MISSION_EXPRESSION, MapMissionCompleter };
