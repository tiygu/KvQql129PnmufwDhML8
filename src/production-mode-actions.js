"use strict";

const { setTimeout: delay } = require("node:timers/promises");
const { productionModeRuntimeHelpersPrelude } = require("./production-mode-runtime");

function productionModePrelude(index) {
  return `const cc=globalThis.cc||globalThis.GameGlobal?.cc,scene=cc?.director?.getScene?.(),entry=scene?.getChildByName?.("Entry")||scene?.children?.find?.(node=>node?.name==="Entry"),runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers)),controller=runtime?.mControllers?.find(item=>item?._controllerClazzName==="UserBoardViewController"),gameBoardView=controller?.view?._boardView?._gameBoardView,grids=gameBoardView?._boardStore?._state?._gameBoard?.__private_95_grids,grid=grids?.[${Number(index)}];${productionModeRuntimeHelpersPrelude()}const producerItemId=String(grid?.itemId||""),currentModeId=productionModeCurrentFor(grid),switchMethod=productionModeSwitchMethod,availableModeIds=productionModesFor(grid).map(mode=>mode.modeId);`;
}

function buildProductionModeReadExpression(index) {
  const gridIndex = Number(index);
  if (!Number.isInteger(gridIndex)) throw new Error("producer index must be an integer");
  return `(() => {${productionModePrelude(gridIndex)}if(!controller?.isViewVisible||!grid?.item||!multipleModeManager)return{ok:false,reason:"production-mode-runtime-unavailable",index:${gridIndex}};return{ok:true,type:"production-mode-read",index:${gridIndex},producerItemId,currentModeId,availableModes:productionModesFor(grid),switchEntry:{status:switchMethod?"available":"unavailable",method:switchMethod}};})()`;
}

function buildProductionModeSwitchExpression(index, requestedModeId, expectedCurrentModeId) {
  const gridIndex = Number(index);
  if (!Number.isInteger(gridIndex)) throw new Error("producer index must be an integer");
  const requested = JSON.stringify(String(requestedModeId));
  const expected = JSON.stringify(String(expectedCurrentModeId));
  return `(() => {${productionModePrelude(gridIndex)}const requestedModeId=${requested},expectedCurrentModeId=${expected};if(!controller?.isViewVisible||!grid?.item||!multipleModeManager)return{ok:false,reason:"production-mode-runtime-unavailable",index:${gridIndex}};if(currentModeId!==expectedCurrentModeId)return{ok:false,reason:"production-mode-current-changed",expectedCurrentModeId,currentModeId};if(!availableModeIds.includes(requestedModeId))return{ok:false,reason:"production-mode-unavailable",requestedModeId};if(!switchMethod)return{ok:false,reason:"production-mode-switch-entry-unavailable"};multipleModeManager[switchMethod](producerItemId,requestedModeId);return{ok:true,type:"production-mode-switch",index:${gridIndex},producerItemId,previousModeId:currentModeId,requestedModeId,switchMethod};})()`;
}

class ProductionModeExecutor {
  constructor({ client, contextId, settleMs = 1200, evaluateTimeoutMs = 10000 }) {
    this.client = client;
    this.contextId = contextId;
    this.settleMs = Math.max(300, Number(settleMs));
    this.evaluateTimeoutMs = Math.max(5000, Number(evaluateTimeoutMs));
  }

  evaluate(expression) { return this.client.evaluate(expression, this.contextId, { timeoutMs: this.evaluateTimeoutMs }); }

  read(index) { return this.evaluate(buildProductionModeReadExpression(index)); }

  async switch(index, modeId, { execute = false, expectedCurrentModeId = null, signal = null } = {}) {
    const before = await this.read(index);
    if (!before?.ok) return { ok: false, executed: false, reason: before?.reason || "production-mode-read-failed", before };
    const expected = expectedCurrentModeId == null ? before.currentModeId : String(expectedCurrentModeId);
    if (String(before.currentModeId) !== expected) return { ok: false, executed: false, reason: "production-mode-current-changed", before };
    const available = before.availableModes?.find((mode) => String(mode.modeId) === String(modeId) && mode.unlocked !== false);
    if (!available || before.switchEntry?.status !== "available") return { ok: false, executed: false, reason: "production-mode-unavailable", before };
    if (!execute) return { ok: true, executed: false, reason: "ready-to-switch-production-mode", before, nextAction: { type: "switch-production-mode", producer: Number(index), currentModeId: expected, productionModeId: String(modeId) } };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before };
    const acknowledgement = await this.evaluate(buildProductionModeSwitchExpression(index, modeId, expected));
    if (!acknowledgement?.ok) return { ok: false, executed: true, reason: acknowledgement?.reason || "production-mode-switch-failed", acknowledgement, before };
    await delay(this.settleMs);
    const after = await this.read(index);
    const ok = !!after?.ok && String(after.currentModeId) === String(modeId);
    return { ok, executed: true, reason: ok ? "production-mode-switched" : "production-mode-switch-not-observed", acknowledgement, before, after };
  }
}

module.exports = { buildProductionModeReadExpression, buildProductionModeSwitchExpression, ProductionModeExecutor };
