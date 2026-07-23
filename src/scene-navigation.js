"use strict";

const { waitForDelay } = require("./abortable-delay");

const SCENE_UI_STATE_EXPRESSION = `(() => {
  const cc = globalThis.cc || globalThis.GameGlobal?.cc;
  const scene = cc?.director?.getScene?.();
  const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
  const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
  const find = (name) => runtime?.mControllers?.find((item) => item?._controllerClazzName === name);
  const map = find("FieldMapMainViewController");
  const board = find("UserBoardViewController");
  const entrance = find("EntranceViewController");
  const mission = find("AreaMissionInfoViewController");
  return { ok: !!runtime, mapVisible: !!map?.isViewVisible, boardVisible: !!board?.isViewVisible, entranceVisible: !!entrance?.isViewVisible, mapMissionVisible: !!mission?.isViewVisible };
})()`;

const CLOSE_MAP_MISSION_EXPRESSION = `(() => {
  const cc = globalThis.cc || globalThis.GameGlobal?.cc;
  const scene = cc?.director?.getScene?.();
  const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
  const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
  const panel = runtime?.mControllers?.find((item) => item?._controllerClazzName === "AreaMissionInfoViewController");
  if (!panel?.isViewVisible) return { ok: true, type: "close-map-mission", alreadyClosed: true };
  if (typeof panel.hideByCloseBtn !== "function") return { ok: false, reason: "map_mission_close_handler_not_found" };
  panel.hideByCloseBtn();
  return { ok: true, type: "close-map-mission", alreadyClosed: false };
})()`;

const OPEN_BOARD_EXPRESSION = `(() => {
  const cc = globalThis.cc || globalThis.GameGlobal?.cc;
  const scene = cc?.director?.getScene?.();
  const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
  const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
  const entrance = runtime?.mControllers?.find((item) => item?._controllerClazzName === "EntranceViewController");
  if (!entrance?.isViewVisible) return { ok: false, reason: "entrance_not_visible" };
  if (typeof entrance.view?.onBoardClick !== "function") return { ok: false, reason: "open_board_handler_not_found" };
  entrance.view.onBoardClick();
  return { ok: true, type: "open-board" };
})()`;

const OPEN_MAP_EXPRESSION = `(() => {
  const cc = globalThis.cc || globalThis.GameGlobal?.cc;
  const scene = cc?.director?.getScene?.();
  const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
  const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
  const board = runtime?.mControllers?.find((item) => item?._controllerClazzName === "UserBoardViewController");
  const boardView = board?.view?._boardView;
  if (!board?.isViewVisible) return { ok: false, reason: "board_not_visible" };
  if (typeof boardView?.onMapButtonClick !== "function") return { ok: false, reason: "open_map_handler_not_found" };
  boardView.onMapButtonClick();
  return { ok: true, type: "open-map" };
})()`;

class SceneNavigator {
  constructor({ client, contextId, settleMs = 1600, evaluateTimeoutMs = 10000, verificationAttempts = 5 }) {
    this.client = client;
    this.contextId = contextId;
    this.settleMs = Math.max(300, Number(settleMs));
    this.evaluateTimeoutMs = Math.max(5000, Number(evaluateTimeoutMs));
    this.verificationAttempts = Math.max(1, Math.min(10, Math.floor(Number(verificationAttempts) || 5)));
  }

  evaluate(expression, signal = null) {
    return this.client.evaluate(expression, this.contextId, { timeoutMs: this.evaluateTimeoutMs, signal });
  }

  readState(signal = null) { return this.evaluate(SCENE_UI_STATE_EXPRESSION, signal); }

  async go(target, { execute = false, signal = null } = {}) {
    if (target !== "board" && target !== "map") throw new Error("navigation target must be board or map");
    let before = await this.readState(signal);
    const alreadyThere = target === "board" ? before.boardVisible : before.mapVisible && !before.boardVisible;
    if (alreadyThere) return { ok: true, executed: false, reason: "already-there", target, before, after: before, actions: [] };
    if (!execute) return { ok: true, executed: false, reason: "ready-to-navigate", target, before, actions: [] };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", target, before, actions: [] };
    const actions = [];
    if (target === "board" && before.mapMissionVisible) {
      const close = await this.evaluate(CLOSE_MAP_MISSION_EXPRESSION, signal);
      actions.push(close);
      if (!close?.ok) return { ok: false, executed: true, reason: close?.reason || "close-overlay-failed", target, before, actions };
      if (!await waitForDelay(this.settleMs, signal)) return { ok: false, executed: true, reason: "aborted", target, before, actions };
      before = await this.readState(signal);
    }
    const acknowledgement = await this.evaluate(target === "board" ? OPEN_BOARD_EXPRESSION : OPEN_MAP_EXPRESSION, signal);
    actions.push(acknowledgement);
    if (!acknowledgement?.ok) return { ok: false, executed: true, reason: acknowledgement?.reason || "navigation-rejected", target, before, actions };
    let after = before;
    for (let attempt = 1; attempt <= this.verificationAttempts; attempt += 1) {
      if (!await waitForDelay(this.settleMs, signal)) return { ok: false, executed: true, reason: "aborted", target, before, after, actions };
      after = await this.readState(signal);
      const arrived = target === "board" ? after.boardVisible : after.mapVisible && !after.boardVisible;
      if (arrived) return { ok: true, executed: true, reason: "navigation-verified", target, before, after, actions, verificationAttempts: attempt };
    }
    return { ok: false, executed: true, reason: "navigation-not-observed", target, before, after, actions, verificationAttempts: this.verificationAttempts };
  }
}

module.exports = { SCENE_UI_STATE_EXPRESSION, CLOSE_MAP_MISSION_EXPRESSION, OPEN_BOARD_EXPRESSION, OPEN_MAP_EXPRESSION, SceneNavigator };
