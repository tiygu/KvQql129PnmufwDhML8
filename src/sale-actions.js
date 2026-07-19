"use strict";

const { setTimeout: delay } = require("node:timers/promises");

function buildAtomicSaleExpression(index, itemId) {
  const gridIndex = Number(index);
  if (!Number.isInteger(gridIndex)) throw new TypeError("sale source index must be an integer");
  const expectedItemId = JSON.stringify(String(itemId));
  return `(() => {
    const G=globalThis,cc=G.cc||G.GameGlobal?.cc,scene=cc?.director?.getScene?.(),entry=scene?.getChildByName?.("Entry")||scene?.children?.find?.(node=>node?.name==="Entry"),runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers)),controller=runtime?.mControllers?.find(item=>item?._controllerClazzName==="UserBoardViewController"),boardView=controller?.view?._boardView?._gameBoardView,grids=boardView?._boardStore?._state?._gameBoard?.__private_95_grids;
    if(!controller||!boardView||!Array.isArray(grids)||!controller.isViewVisible)return{ok:false,reason:"board_runtime_not_found"};
    const grid=grids[${gridIndex}],expectedItemId=${expectedItemId};
    if(!grid?.item||String(grid.itemId||"")!==expectedItemId)return{ok:false,reason:"sale_target_mismatch",index:${gridIndex},expectedItemId,actualItemId:String(grid?.itemId||"")};
    const names=["onSellBtnClick","onSellClick","sellItem","onSellItem","sell"],targets=[controller,controller.view,boardView,boardView._operatorCenter],entryPoint=targets.flatMap(target=>names.map(name=>({target,name}))).find(candidate=>typeof candidate.target?.[candidate.name]==="function");
    if(!entryPoint)return{ok:false,reason:"native_sell_entry_unavailable",index:${gridIndex},itemId:expectedItemId};
    boardView.onTouch?.(grid.center);
    entryPoint.target[entryPoint.name](grid,grid.item);
    return{ok:true,type:"sell-item",index:${gridIndex},itemId:expectedItemId,entry:entryPoint.name};
  })()`;
}

class SaleActionExecutor {
  constructor({ client, contextId, collectState, settleMs = 1200, evaluateTimeoutMs = 10000 }) {
    this.client = client;
    this.contextId = contextId;
    this.collectState = collectState;
    this.settleMs = Math.max(0, Number(settleMs) || 0);
    this.evaluateTimeoutMs = Math.max(1000, Number(evaluateTimeoutMs) || 10000);
  }

  async execute(suggestion, { confirmed = false, signal = null } = {}) {
    if (!confirmed) return { ok: false, executed: false, reason: "sale-confirmation-required" };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted" };
    const before = await this.collectState();
    const source = before.board?.grids?.find((grid) => Number(grid.index) === Number(suggestion.sourceIndex));
    if (before.scene !== "board" || String(source?.itemId || "") !== String(suggestion.itemId)) return { ok: false, executed: false, reason: "sale-preflight-target-mismatch", before };
    const acknowledgement = await this.client.evaluate(buildAtomicSaleExpression(suggestion.sourceIndex, suggestion.itemId), this.contextId, { timeoutMs: this.evaluateTimeoutMs });
    if (!acknowledgement?.ok || Number(acknowledgement.index) !== Number(suggestion.sourceIndex) || String(acknowledgement.itemId) !== String(suggestion.itemId)) return { ok: false, executed: true, reason: acknowledgement?.reason || "sale-acknowledgement-mismatch", acknowledgement, before };
    if (this.settleMs) await delay(this.settleMs, null, signal ? { signal } : undefined);
    const after = await this.collectState();
    const afterSource = after.board?.grids?.find((grid) => Number(grid.index) === Number(suggestion.sourceIndex));
    const failures = [];
    if (String(afterSource?.itemId || "") === String(suggestion.itemId)) failures.push("target-item-still-present");
    const beforeOther = new Map((before.board?.grids || []).filter((grid) => Number(grid.index) !== Number(suggestion.sourceIndex)).map((grid) => [Number(grid.index), String(grid.itemId || "")]));
    if ((after.board?.grids || []).some((grid) => Number(grid.index) !== Number(suggestion.sourceIndex) && beforeOther.get(Number(grid.index)) !== String(grid.itemId || ""))) failures.push("non-target-grid-changed");
    const coinsBefore = Number(before.resources?.coins), coinsAfter = Number(after.resources?.coins), expectedCoins = Number(suggestion.expectedCoins);
    if (!Number.isFinite(coinsBefore) || !Number.isFinite(coinsAfter) || coinsAfter - coinsBefore !== expectedCoins) failures.push("coin-delta-mismatch");
    return { ok: failures.length === 0, executed: true, reason: failures.length ? "sale-verification-failed" : "sale-verified", before, after, acknowledgement, coinsBefore, coinsAfter, verification: { failures, targetIndex: Number(suggestion.sourceIndex), itemId: String(suggestion.itemId), expectedCoins } };
  }
}

module.exports = { buildAtomicSaleExpression, SaleActionExecutor };
