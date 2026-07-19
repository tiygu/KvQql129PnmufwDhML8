"use strict";

const { setTimeout: delay } = require("node:timers/promises");
const { WAREHOUSE_REASONS, unknownWarehouseInventoryKnowledge, warehouseGridEligibility } = require("./warehouse-domain");

function warehouseRuntimePrelude() {
  return `const cc=globalThis.cc||globalThis.GameGlobal?.cc,scene=cc?.director?.getScene?.(),entry=scene?.getChildByName?.("Entry")||scene?.children?.find?.(node=>node?.name==="Entry"),runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers)),controller=runtime?.mControllers?.find(item=>item?._controllerClazzName==="UserBoardViewController"),boardView=controller?.view?._boardView,gameBoardView=boardView?._gameBoardView,grids=gameBoardView?._boardStore?._state?._gameBoard?.__private_95_grids;`;
}

const OPEN_WAREHOUSE_EXPRESSION = `(() => {${warehouseRuntimePrelude()}const bottom=boardView?._bottomView;if(!controller?.isViewVisible||!bottom)return{ok:false,reason:"board_not_visible"};if(typeof bottom.checkWarehouseUnlock==="function"&&!bottom.checkWarehouseUnlock())return{ok:false,reason:"warehouse_locked"};if(typeof bottom.onWarehouseButtonHandle!=="function")return{ok:false,reason:"warehouse_open_handler_not_found"};bottom.onWarehouseButtonHandle();return{ok:true,type:"open-warehouse"};})()`;

function sourceValidationExpression(gridIndex) {
  return `if(!controller?.isViewVisible||!boardView||!gameBoardView||!Array.isArray(grids))return{ok:false,reason:"board-not-visible"};const grid=grids[${gridIndex}];if(!grid||grid.isEmpty||!grid.isItemValid||!grid.item)return{ok:false,reason:"${WAREHOUSE_REASONS.invalidSource}",index:${gridIndex}};if(!grid.isNormal||!grid.isMoveable||grid.isLocking||grid.isFrozen)return{ok:false,reason:"${WAREHOUSE_REASONS.unavailableSource}",index:${gridIndex}};if(grid.item.taskNeed)return{ok:false,reason:"${WAREHOUSE_REASONS.reservedSource}",index:${gridIndex}};if(typeof grid.item.produceCount==="number")return{ok:false,reason:"${WAREHOUSE_REASONS.producerSource}",index:${gridIndex}};`;
}

function buildWarehouseStorePreflightExpression(index) {
  const gridIndex = Number(index);
  if (!Number.isInteger(gridIndex)) throw new Error("warehouse grid index must be an integer");
  return `(() => {${warehouseRuntimePrelude()}${sourceValidationExpression(gridIndex)}const warehouseGridId=boardView.verifySaveItemToWarehouse?.(grid);if(warehouseGridId==null||String(warehouseGridId)==="")return{ok:false,reason:"warehouse_full_or_unavailable",index:${gridIndex}};return{ok:true,type:"warehouse-store-preflight",index:${gridIndex},itemId:String(grid.itemId||""),warehouseGridId:String(warehouseGridId)};})()`;
}

function buildMoveToWarehouseExpression(index, expectedTargetSlotId = null, expectedItemId = null, expectedBoardSignature = null) {
  const gridIndex = Number(index);
  if (!Number.isInteger(gridIndex)) throw new Error("warehouse grid index must be an integer");
  const expected = JSON.stringify(expectedTargetSlotId == null ? null : String(expectedTargetSlotId));
  const expectedItem = JSON.stringify(expectedItemId == null ? null : String(expectedItemId));
  const expectedSignature = JSON.stringify(expectedBoardSignature == null ? null : String(expectedBoardSignature));
  return `(() => {${warehouseRuntimePrelude()}${sourceValidationExpression(gridIndex)}const entrance=boardView.getWarehouseEntranceWorldRect?.();if(!entrance?.center)return{ok:false,reason:"warehouse-entrance-not-found",index:${gridIndex}};const currentItemId=String(grid.itemId||""),currentSignature=grids.map(value=>String(value?.itemId||"")).join("|"),expectedItem=${expectedItem},expectedSignature=${expectedSignature};if(expectedItem!=null&&currentItemId!==expectedItem||expectedSignature!=null&&currentSignature!==expectedSignature)return{ok:false,reason:"warehouse-preflight-source-changed",index:${gridIndex},expectedItem,currentItemId,expectedSignature,currentSignature};const warehouseGridId=boardView.verifySaveItemToWarehouse?.(grid),expectedTarget=${expected};if(warehouseGridId==null||String(warehouseGridId)==="")return{ok:false,reason:"warehouse-full-or-unavailable",index:${gridIndex}};if(expectedTarget!=null&&String(warehouseGridId)!==expectedTarget)return{ok:false,reason:"warehouse-preflight-changed",index:${gridIndex},expectedTarget,actualTarget:String(warehouseGridId)};if(typeof gameBoardView.tryAddItemToWarehouse!=="function")return{ok:false,reason:"warehouse-store-handler-not-found",index:${gridIndex}};const ok=!!gameBoardView.tryAddItemToWarehouse(grid,entrance.center);return{ok,type:"move-to-warehouse",reason:ok?null:"warehouse-store-rejected",index:${gridIndex},itemId:currentItemId,warehouseGridId:String(warehouseGridId)};})()`;
}

function sourcePreflightFailure(before, gridIndex) {
  const source = before.board?.grids?.find((grid) => Number(grid.index) === gridIndex);
  if (before.scene !== "board" || !before.board?.visible) return { reason: "board-not-visible", source };
  const eligibility = warehouseGridEligibility(source);
  return { reason: eligibility.reason, unavailable: eligibility.unavailableReasons, source };
}

function unexpectedSideEffects(before, after, sourceIndex) {
  const changes = [];
  for (const field of ["coins", "energy", "diamonds"]) {
    const previous = before.resources?.[field], current = after.resources?.[field];
    if (previous != null && current != null && Number(previous) !== Number(current)) changes.push({ field: `resources.${field}`, before: previous, after: current });
  }
  if (before.scene !== after.scene) changes.push({ field: "scene", before: before.scene, after: after.scene });
  if (JSON.stringify(before.orders || []) !== JSON.stringify(after.orders || [])) changes.push({ field: "orders", before: before.orders || [], after: after.orders || [] });
  const stableGridValue = (grid) => {
    if (!grid) return null;
    const value = { itemId: String(grid.itemId || ""), empty: !!grid.empty };
    for (const field of ["normal", "moveable", "locked", "frozen", "taskNeed", "level", "mergeTarget", "produceCount", "energyCost", "protected", "executable", "unavailableReasons"]) {
      if (Object.hasOwn(grid, field)) value[field] = grid[field];
    }
    return value;
  };
  const afterByIndex = new Map((after.board?.grids || []).map((grid) => [Number(grid.index), grid]));
  for (const grid of before.board?.grids || []) {
    if (Number(grid.index) === Number(sourceIndex)) continue;
    const current = afterByIndex.get(Number(grid.index));
    const previousValue = stableGridValue(grid);
    const currentValue = stableGridValue(current);
    if (JSON.stringify(previousValue) !== JSON.stringify(currentValue)) changes.push({ field: `board.grid[${grid.index}]`, before: previousValue, after: currentValue });
  }
  return changes;
}

class WarehouseActionExecutor {
  constructor({ client, contextId, collectState, settleMs = 1500, evaluateTimeoutMs = 10000, onInventoryKnowledgeInvalidated = null }) {
    this.client = client;
    this.contextId = contextId;
    this.collectState = collectState;
    this.settleMs = Math.max(300, Number(settleMs));
    this.evaluateTimeoutMs = Math.max(5000, Number(evaluateTimeoutMs));
    this.onInventoryKnowledgeInvalidated = onInventoryKnowledgeInvalidated;
  }

  evaluate(expression) { return this.client.evaluate(expression, this.contextId, { timeoutMs: this.evaluateTimeoutMs }); }

  invalidate(reason) { this.onInventoryKnowledgeInvalidated?.(reason); }

  async open({ execute = false, signal = null } = {}) {
    const before = await this.collectState();
    if (before.scene === "warehouse" || before.warehouse?.visible) return { ok: true, executed: false, reason: "warehouse-already-open", before };
    if (before.scene !== "board") return { ok: false, executed: false, reason: "board-not-visible", before };
    if (!execute) return { ok: true, executed: false, reason: "ready-to-open-warehouse", before };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before };
    const acknowledgement = await this.evaluate(OPEN_WAREHOUSE_EXPRESSION);
    if (!acknowledgement?.ok) return { ok: false, executed: true, reason: acknowledgement?.reason || "warehouse-open-failed", acknowledgement, before };
    await delay(this.settleMs);
    const after = await this.collectState();
    const ok = after.scene === "warehouse" || !!after.warehouse?.visible;
    return { ok, executed: true, reason: ok ? "warehouse-opened" : "warehouse-open-not-observed", acknowledgement, before, after };
  }

  async preflight(index, { signal = null } = {}) {
    const gridIndex = Number(index);
    if (!Number.isInteger(gridIndex)) return { ok: false, executed: false, reason: "warehouse-index-invalid" };
    const before = await this.collectState();
    const validation = sourcePreflightFailure(before, gridIndex);
    if (validation.reason) return { ok: false, executed: false, reason: validation.reason, unavailable: validation.unavailable, source: validation.source, before, storeAvailability: { status: "unavailable", reason: validation.reason } };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before };
    const acknowledgement = await this.evaluate(buildWarehouseStorePreflightExpression(gridIndex));
    if (!acknowledgement?.ok) return { ok: false, executed: false, reason: acknowledgement?.reason || "warehouse-store-preflight-failed", acknowledgement, source: validation.source, before, storeAvailability: { status: "unavailable", reason: acknowledgement?.reason || "warehouse-store-preflight-failed" } };
    return {
      ok: true, executed: false, reason: "warehouse-store-available", acknowledgement, source: validation.source, before,
      storeAvailability: { status: "available", sourceIndex: gridIndex, itemId: String(validation.source.itemId), targetSlotId: String(acknowledgement.warehouseGridId), boardSignature: before.board?.signature || "" },
    };
  }

  async move(index, { execute = false, signal = null, preflight = null } = {}) {
    const gridIndex = Number(index);
    const checked = preflight?.ok ? preflight : await this.preflight(gridIndex, { signal });
    if (!checked.ok) return checked;
    if (!execute) return { ...checked, reason: "ready-to-move-to-warehouse", nextAction: { type: "store-to-warehouse", sourceIndex: gridIndex, itemId: checked.source.itemId, storeAvailability: checked.storeAvailability } };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before: checked.before };
    const acknowledgement = await this.evaluate(buildMoveToWarehouseExpression(gridIndex, checked.storeAvailability.targetSlotId, checked.storeAvailability.itemId, checked.storeAvailability.boardSignature));
    if (!acknowledgement?.ok) {
      this.invalidate("warehouse-store-failed");
      return { ok: false, executed: true, reason: acknowledgement?.reason || "warehouse-store-failed", acknowledgement, before: checked.before, storeAvailability: checked.storeAvailability, warehouseInventoryKnowledge: unknownWarehouseInventoryKnowledge("warehouse-store-failed") };
    }
    await delay(this.settleMs);
    const after = await this.collectState();
    const before = checked.before;
    const next = after.board?.grids?.find((grid) => Number(grid.index) === gridIndex);
    const sourceCleared = !!next?.empty;
    const signatureChanged = after.board?.signature !== before.board?.signature;
    const occupiedChanged = before.board?.occupied == null || after.board?.occupied == null || Number(after.board.occupied) === Number(before.board.occupied) - 1;
    const emptyChanged = before.board?.empty == null || after.board?.empty == null || Number(after.board.empty) === Number(before.board.empty) + 1;
    const sideEffects = unexpectedSideEffects(before, after, gridIndex);
    const ok = sourceCleared && signatureChanged && occupiedChanged && emptyChanged && sideEffects.length === 0;
    const reason = sideEffects.length ? "warehouse-store-unexpected-side-effect" : ok ? "item-moved-to-warehouse" : "warehouse-store-not-observed";
    this.invalidate(ok ? "warehouse-store-succeeded" : "warehouse-store-failed");
    return { ok, executed: true, reason, acknowledgement, source: checked.source, storeAvailability: checked.storeAvailability, warehouseInventoryKnowledge: unknownWarehouseInventoryKnowledge(ok ? "warehouse-store-succeeded" : "warehouse-store-failed"), sideEffects, before, after };
  }
}

module.exports = { OPEN_WAREHOUSE_EXPRESSION, buildWarehouseStorePreflightExpression, buildMoveToWarehouseExpression, WarehouseActionExecutor };
