"use strict";

const { waitForDelay } = require("./abortable-delay");
const { WAREHOUSE_REASONS, unknownWarehouseInventoryKnowledge, warehouseGridEligibility, warehouseInventoryKnowledgeFromNative } = require("./warehouse-domain");

function warehouseRuntimePrelude() {
  return `const cc=globalThis.cc||globalThis.GameGlobal?.cc,scene=cc?.director?.getScene?.(),entry=scene?.getChildByName?.("Entry")||scene?.children?.find?.(node=>node?.name==="Entry"),runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers)),controller=runtime?.mControllers?.find(item=>item?._controllerClazzName==="UserBoardViewController"),boardView=controller?.view?._boardView,gameBoardView=boardView?._gameBoardView,grids=gameBoardView?._boardStore?._state?._gameBoard?.__private_95_grids;`;
}

const OPEN_WAREHOUSE_EXPRESSION = `(() => {${warehouseRuntimePrelude()}const bottom=boardView?._bottomView;if(!controller?.isViewVisible||!bottom)return{ok:false,reason:"board_not_visible"};if(typeof bottom.checkWarehouseUnlock==="function"&&!bottom.checkWarehouseUnlock())return{ok:false,reason:"warehouse_locked"};if(typeof bottom.onWarehouseButtonHandle!=="function")return{ok:false,reason:"warehouse_open_handler_not_found"};bottom.onWarehouseButtonHandle();return{ok:true,type:"open-warehouse"};})()`;

function warehouseInventoryRuntimePrelude() {
  return `const cc=globalThis.cc||globalThis.GameGlobal?.cc,scene=cc?.director?.getScene?.(),entry=scene?.getChildByName?.("Entry")||scene?.children?.find?.(node=>node?.name==="Entry"),runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers)),warehouseController=runtime?.mControllers?.find(item=>item?._controllerClazzName==="WarehouseViewController"),warehouseView=warehouseController?.view,gridTypeMap=warehouseView?._warehouseData?._gridTypeMap,itemIdOf=data=>String(data?.itemId??data?.id??data?.itemConfig?.Id??data?.itemConfig?.ID??"");const slots=[];if(gridTypeMap instanceof Map)for(const[type,grids]of gridTypeMap.entries())for(const grid of Array.isArray(grids)?grids:[])slots.push({slotId:String(grid?.id??""),type:Number(type),unlocked:!!grid?.unlocked,occupied:grid?.itemData!=null,itemId:itemIdOf(grid?.itemData)});const revision=slots.map(slot=>slot.slotId+":"+slot.itemId+":"+Number(slot.unlocked)).join("|");`;
}

const WAREHOUSE_INVENTORY_EXPRESSION = `(() => {${warehouseInventoryRuntimePrelude()}if(!warehouseController?.isViewVisible||!(gridTypeMap instanceof Map))return{ok:false,reason:"warehouse-inventory-not-loaded"};return{ok:true,type:"native-warehouse-inventory",totalSlots:slots.length,unlockedSlots:slots.filter(slot=>slot.unlocked).length,occupiedSlots:slots.filter(slot=>slot.occupied).length,slots,revision,retrievalPath:{status:"trusted",type:"native-click"}};})()`;

const BOARD_AFTER_RETRIEVAL_EXPRESSION = `(() => {${warehouseRuntimePrelude()}if(!Array.isArray(grids))return{ok:false,reason:"board-state-unavailable"};const safe=(fn,fallback=null)=>{try{return fn()}catch(_){return fallback}},values=grids.map(grid=>({index:Number(grid.index),itemId:String(safe(()=>grid.itemId,"")),empty:!!safe(()=>grid.isEmpty,true),normal:!!safe(()=>grid.isNormal,false),moveable:!!safe(()=>grid.isMoveable,false),locked:!!grid.isLocking,frozen:!!safe(()=>grid.isFrozen,false),taskNeed:!!safe(()=>grid.item?.taskNeed,false),level:safe(()=>grid.item.itemConfig.Level,null),mergeTarget:safe(()=>grid.item.itemConfig.MergeTarget,null),produceCount:safe(()=>grid.item.produceCount,null),energyCost:safe(()=>grid.item.itemConfig.EnergyCost,null)}));return{ok:true,type:"board-after-warehouse-retrieval",signature:values.map(grid=>grid.itemId).join("|"),occupied:values.filter(grid=>!grid.empty).length,empty:values.filter(grid=>grid.empty).length,grids:values};})()`;

function buildWarehouseRetrieveExpression(slotId, expectedItemId, expectedRevision) {
  const targetSlot = JSON.stringify(String(slotId));
  const targetItem = JSON.stringify(String(expectedItemId));
  const targetRevision = JSON.stringify(String(expectedRevision));
  return `(() => {${warehouseInventoryRuntimePrelude()}if(!warehouseController?.isViewVisible)return{ok:false,reason:"warehouse-not-visible"};const expectedRevision=${targetRevision};if(revision!==expectedRevision)return{ok:false,reason:"warehouse-revision-changed",expectedRevision,actualRevision:revision};const slotId=${targetSlot},expectedItemId=${targetItem},slot=slots.find(value=>value.slotId===slotId),grid=[...gridTypeMap.values()].flat().find(value=>String(value?.id??"")===slotId);if(!slot||!grid||!slot.occupied||slot.itemId!==expectedItemId)return{ok:false,reason:"warehouse-slot-item-changed",slotId,expectedItemId,actualItemId:slot?.itemId??null};const entries=warehouseView?._itemViewMap instanceof Map?[...warehouseView._itemViewMap.entries()]:[],itemView=entries.find(([key,value])=>key===grid||key===grid.itemData||String(key?.id??key??"")===slotId||String(value?.grid?.id??value?.data?.id??value?.itemData?.id??"")===slotId)?.[1]||warehouseView?._gridViewMap?.get?.(grid),node=itemView?.mNode||itemView?.node;if(!node||typeof node.emit!=="function")return{ok:false,reason:"warehouse-native-click-path-not-found",slotId};node.emit("click");return{ok:true,type:"native-warehouse-retrieve",slotId,itemId:expectedItemId};})()`;
}

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

  evaluate(expression, signal = null) { return this.client.evaluate(expression, this.contextId, { timeoutMs: this.evaluateTimeoutMs, signal }); }

  invalidate(reason) { this.onInventoryKnowledgeInvalidated?.(reason); }

  async open({ execute = false, signal = null } = {}) {
    const before = await this.collectState(signal);
    if (before.scene === "warehouse" || before.warehouse?.visible) return { ok: true, executed: false, reason: "warehouse-already-open", before };
    if (before.scene !== "board") return { ok: false, executed: false, reason: "board-not-visible", before };
    if (!execute) return { ok: true, executed: false, reason: "ready-to-open-warehouse", before };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before };
    const acknowledgement = await this.evaluate(OPEN_WAREHOUSE_EXPRESSION, signal);
    if (!acknowledgement?.ok) return { ok: false, executed: true, reason: acknowledgement?.reason || "warehouse-open-failed", acknowledgement, before };
    if (!await waitForDelay(this.settleMs, signal)) return { ok: false, executed: true, reason: "aborted", acknowledgement, before };
    const after = await this.collectState(signal);
    const ok = after.scene === "warehouse" || !!after.warehouse?.visible;
    return { ok, executed: true, reason: ok ? "warehouse-opened" : "warehouse-open-not-observed", acknowledgement, before, after };
  }

  async loadInventory({ execute = false, signal = null } = {}) {
    const before = await this.collectState(signal);
    let visibleState = before;
    if (before.scene !== "warehouse" && !before.warehouse?.visible) {
      if (!execute) return { ok: true, executed: false, reason: "warehouse-inventory-load-required", before, nextAction: { type: "load-warehouse-inventory" } };
      const opened = await this.open({ execute: true, signal });
      if (!opened.ok) return opened;
      visibleState = opened.after || before;
    }
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before };
    const acknowledgement = await this.evaluate(WAREHOUSE_INVENTORY_EXPRESSION, signal);
    if (!acknowledgement?.ok) return { ok: false, executed: true, reason: acknowledgement?.reason || "warehouse-inventory-load-failed", acknowledgement, before, after: visibleState };
    const inventoryKnowledge = warehouseInventoryKnowledgeFromNative(acknowledgement);
    const state = JSON.parse(JSON.stringify(visibleState));
    state.scene = before.scene;
    state.board = before.board;
    state.orders = before.orders;
    state.resources = before.resources;
    state.warehouse = { ...(state.warehouse || {}), visible: true, inventoryKnowledge };
    return { ok: true, executed: execute, reason: "warehouse-inventory-loaded", acknowledgement, before, after: visibleState, state, inventoryKnowledge };
  }

  async retrieve(action, { execute = false, signal = null, inventory = null, before = null } = {}) {
    const checkedBefore = before || await this.collectState(signal);
    const knowledge = inventory?.status === "loaded" ? inventory : warehouseInventoryKnowledgeFromNative(inventory);
    if (knowledge.status !== "loaded" || knowledge.retrievalPath?.status !== "trusted") return { ok: false, executed: false, reason: "warehouse-retrieval-path-untrusted", before: checkedBefore };
    if (String(knowledge.revision) !== String(action.inventoryRevision)) return { ok: false, executed: false, reason: "warehouse-revision-changed", before: checkedBefore, inventoryKnowledge: knowledge };
    const target = knowledge.slots.find((slot) => String(slot.slotId) === String(action.warehouseSlotId));
    if (!target?.occupied || String(target.itemId) !== String(action.itemId)) return { ok: false, executed: false, reason: "warehouse-slot-item-changed", before: checkedBefore, inventoryKnowledge: knowledge };
    if (!execute) return { ok: true, executed: false, reason: "ready-to-retrieve-warehouse-item", before: checkedBefore, inventoryKnowledge: knowledge, nextAction: action };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before: checkedBefore };
    let acknowledgement;
    try {
      acknowledgement = await this.evaluate(buildWarehouseRetrieveExpression(action.warehouseSlotId, action.itemId, action.inventoryRevision), signal);
    } catch (error) {
      this.invalidate("warehouse-retrieval-outcome-unknown");
      return { ok: false, executed: true, reason: "warehouse-retrieval-outcome-unknown", error: error.message, before: checkedBefore, uncertainAction: true, resyncRequired: true, inventoryKnowledge: unknownWarehouseInventoryKnowledge("warehouse-retrieval-outcome-unknown") };
    }
    if (!acknowledgement?.ok) return { ok: false, executed: true, reason: acknowledgement?.reason || "warehouse-retrieval-failed", acknowledgement, before: checkedBefore };
    if (!await waitForDelay(this.settleMs, signal)) {
      this.invalidate("warehouse-retrieval-pending-resynchronization");
      return { ok: false, executed: true, reason: "aborted", acknowledgement, before: checkedBefore, uncertainAction: true, resyncRequired: true, inventoryKnowledge: unknownWarehouseInventoryKnowledge("warehouse-retrieval-aborted-after-acknowledgement") };
    }
    const after = await this.collectState(signal);
    if (!(after.board?.grids || []).length && (checkedBefore.board?.grids || []).length) {
      const boardAcknowledgement = await this.evaluate(BOARD_AFTER_RETRIEVAL_EXPRESSION, signal);
      if (boardAcknowledgement?.ok) after.board = { ...(after.board || {}), ...boardAcknowledgement };
    }
    const inventoryAcknowledgement = await this.evaluate(WAREHOUSE_INVENTORY_EXPRESSION, signal);
    const afterKnowledge = warehouseInventoryKnowledgeFromNative(inventoryAcknowledgement);
    const beforeItemCount = (checkedBefore.board?.grids || []).filter((grid) => String(grid.itemId) === String(action.itemId) && !grid.empty).length;
    const afterItems = (after.board?.grids || []).filter((grid) => String(grid.itemId) === String(action.itemId) && !grid.empty);
    const beforeByIndex = new Map((checkedBefore.board?.grids || []).map((grid) => [Number(grid.index), grid]));
    const landing = afterItems.find((grid) => String(beforeByIndex.get(Number(grid.index))?.itemId || "") !== String(action.itemId));
    const targetAfter = afterKnowledge.slots.find((slot) => String(slot.slotId) === String(action.warehouseSlotId));
    const slotCleared = !!targetAfter && !targetAfter.occupied;
    const itemAdded = afterItems.length === beforeItemCount + 1 && !!landing;
    const emptyReduced = Number(after.board?.empty) === Number(checkedBefore.board?.empty) - 1;
    const occupiedIncreased = Number(after.board?.occupied) === Number(checkedBefore.board?.occupied) + 1;
    const signatureChanged = after.board?.signature !== checkedBefore.board?.signature;
    const revisionChanged = afterKnowledge.status === "loaded" && afterKnowledge.revision !== knowledge.revision;
    const resourcesStable = JSON.stringify(after.resources || {}) === JSON.stringify(checkedBefore.resources || {});
    const ordersStable = JSON.stringify(after.orders || []) === JSON.stringify(checkedBefore.orders || []);
    const ok = slotCleared && itemAdded && emptyReduced && occupiedIncreased && signatureChanged && revisionChanged && resourcesStable && ordersStable;
    const resynchronized = { board: after.board, warehouse: afterKnowledge };
    return {
      ok, executed: true, reason: ok ? "warehouse-item-retrieved" : "warehouse-retrieval-not-observed", acknowledgement,
      actualBoardIndex: landing?.index ?? null, inventoryKnowledge: afterKnowledge, before: checkedBefore, after, resynchronized,
      verification: { slotCleared, itemAdded, emptyReduced, occupiedIncreased, signatureChanged, revisionChanged, resourcesStable, ordersStable },
    };
  }

  async preflight(index, { signal = null } = {}) {
    const gridIndex = Number(index);
    if (!Number.isInteger(gridIndex)) return { ok: false, executed: false, reason: "warehouse-index-invalid" };
    const before = await this.collectState(signal);
    const validation = sourcePreflightFailure(before, gridIndex);
    if (validation.reason) return { ok: false, executed: false, reason: validation.reason, unavailable: validation.unavailable, source: validation.source, before, storeAvailability: { status: "unavailable", reason: validation.reason } };
    if (signal?.aborted) return { ok: false, executed: false, reason: "aborted", before };
    const acknowledgement = await this.evaluate(buildWarehouseStorePreflightExpression(gridIndex), signal);
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
    let acknowledgement;
    try {
      acknowledgement = await this.evaluate(buildMoveToWarehouseExpression(gridIndex, checked.storeAvailability.targetSlotId, checked.storeAvailability.itemId, checked.storeAvailability.boardSignature), signal);
    } catch (error) {
      this.invalidate("warehouse-store-outcome-unknown");
      return { ok: false, executed: true, reason: "warehouse-store-outcome-unknown", error: error.message, before: checked.before, uncertainAction: true, resyncRequired: true, warehouseInventoryKnowledge: unknownWarehouseInventoryKnowledge("warehouse-store-outcome-unknown") };
    }
    if (!acknowledgement?.ok) {
      this.invalidate("warehouse-store-failed");
      return { ok: false, executed: true, reason: acknowledgement?.reason || "warehouse-store-failed", acknowledgement, before: checked.before, storeAvailability: checked.storeAvailability, warehouseInventoryKnowledge: unknownWarehouseInventoryKnowledge("warehouse-store-failed") };
    }
    if (!await waitForDelay(this.settleMs, signal)) {
      this.invalidate("warehouse-store-pending-resynchronization");
      return { ok: false, executed: true, reason: "aborted", acknowledgement, before: checked.before, uncertainAction: true, resyncRequired: true, warehouseInventoryKnowledge: unknownWarehouseInventoryKnowledge("warehouse-store-aborted-after-acknowledgement") };
    }
    const after = await this.collectState(signal);
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

module.exports = { OPEN_WAREHOUSE_EXPRESSION, WAREHOUSE_INVENTORY_EXPRESSION, buildWarehouseStorePreflightExpression, buildMoveToWarehouseExpression, buildWarehouseRetrieveExpression, WarehouseActionExecutor };
