"use strict";

const MAX_ACTIVE_CATALOG_SCAN_TARGETS = 12;

function boardRuntimePrelude() {
  return `const cc=globalThis.cc,scene=cc?.director?.getScene?.(),entry=scene?.getChildByName?.("Entry")||scene?.children?.find?.(node=>node?.name==="Entry"),runtime=(entry?._components||[]).find(component=>Array.isArray(component?.mControllers)),controller=runtime?.mControllers?.find(item=>item?._controllerClazzName==="UserBoardViewController"),boardView=controller?.view?._boardView?._gameBoardView,grids=boardView?._boardStore?._state?._gameBoard?.__private_95_grids;`;
}

const READ_CATALOG_SCAN_SELECTION_EXPRESSION = `(() => {${boardRuntimePrelude()}return Array.isArray(grids)?boardView?._touchHandler?.currentSelectedBoardGrid?.index??null:null;})()`;

function buildActiveCatalogInspectExpression(gridIndex) {
  const index = Number(gridIndex);
  if (!Number.isInteger(index)) throw new TypeError("active catalog scan grid index must be an integer");
  return `(() => {${boardRuntimePrelude()}const grid=Array.isArray(grids)?grids[${index}]:null;if(!controller?.isViewVisible||!grid?.item)return{ok:false,reason:"scan-grid-unavailable"};if(Number(grid.item.produceCount||0)>0||Number(grid.item.itemConfig?.EnergyCost||0)>0)return{ok:false,reason:"scan-producer-selection-unsafe"};boardView.onTouch(grid.center);return{ok:true,index:grid.index,itemId:String(grid.itemId||"")};})()`;
}

function buildRestoreCatalogSelectionExpression(gridIndex) {
  const selection = gridIndex == null ? "null" : String(Number(gridIndex));
  return `(() => {${boardRuntimePrelude()}const wanted=${selection},handler=boardView?._touchHandler;if(!Array.isArray(grids)||!handler)return{ok:false,reason:"scan-restore-runtime-unavailable"};if(wanted!=null&&grids[wanted]){const item=grids[wanted].item;if(Number(item?.produceCount||0)>0||Number(item?.itemConfig?.EnergyCost||0)>0)return{ok:false,reason:"scan-producer-selection-restore-unsafe"};boardView.onTouch(grids[wanted].center);return{ok:true,index:wanted};}if(wanted==null&&handler.currentSelectedBoardGrid==null)return{ok:true,index:null};if(typeof globalThis.__miniGameCatalogRestoreSelection==="function")return globalThis.__miniGameCatalogRestoreSelection(wanted);const clear=handler.clearCurrentSelectedBoardGrid||handler.unselectCurrentGrid||handler.clearSelect;if(wanted==null&&typeof clear==="function"){clear.call(handler);return{ok:true,index:null};}return{ok:false,reason:"scan-selection-restore-unsupported"};})()`;
}

class ActiveCatalogScanner {
  constructor({ collectState, readSelection, inspectItem, restoreSelection, collectEvidence, commitEvidence, reevaluate, replan }) {
    this.collectState = collectState;
    this.readSelection = readSelection;
    this.inspectItem = inspectItem;
    this.restoreSelection = restoreSelection;
    this.collectEvidence = collectEvidence;
    this.commitEvidence = commitEvidence;
    this.reevaluate = reevaluate;
    this.replan = replan;
  }

  async run(itemIds, { before = null, initialSelection = undefined } = {}) {
    const initial = before || await this.collectState();
    const selection = initialSelection === undefined ? await this.readSelection() : initialSelection;
    const observedObjectIds = new Set();
    const captures = [];
    const stagedEvidence = [];
    let scanError = null;
    try {
      for (const itemId of [...new Set((itemIds || []).map(String))]) {
        const capture = await this.inspectItem(itemId);
        if (!capture) continue;
        captures.push(capture);
        const evidence = await this.collectEvidence(capture);
        if (evidence) stagedEvidence.push(evidence);
      }
    } catch (error) {
      scanError = error;
    } finally {
      try { await this.restoreSelection(selection); } catch (error) { scanError ||= error; }
    }
    const after = await this.collectState();
    const selectionAfter = await this.readSelection();
    const changes = [];
    if (after.scene !== initial.scene) changes.push({ field: "scene", before: initial.scene, after: after.scene });
    if (Number(after.resources?.energy) !== Number(initial.resources?.energy)) changes.push({ field: "energy", before: initial.resources?.energy, after: after.resources?.energy });
    if (String(after.board?.signature || "") !== String(initial.board?.signature || "")) changes.push({ field: "board.signature", before: initial.board?.signature, after: after.board?.signature });
    if (String(selectionAfter ?? "") !== String(selection ?? "")) changes.push({ field: "selection", before: selection, after: selectionAfter });
    if (changes.length) return { ok: false, reason: "active-catalog-scan-safety-verification-failed", changes, captures, observedObjectIds: [...observedObjectIds], error: scanError?.message };
    if (scanError) return { ok: false, reason: "active-catalog-scan-failed", error: scanError.message, changes: [], captures, observedObjectIds: [...observedObjectIds] };
    if (!captures.length) return { ok: false, reason: "active-catalog-scan-no-safe-target", changes: [], captures, observedObjectIds: [] };
    if (!stagedEvidence.length) return { ok: false, reason: "active-catalog-scan-no-evidence", changes: [], captures, observedObjectIds: [] };
    for (const objectId of await this.commitEvidence(stagedEvidence) || []) observedObjectIds.add(String(objectId));
    await this.reevaluate([...observedObjectIds]);
    return { ok: true, reason: "active-catalog-scan-complete", captures, observedObjectIds: [...observedObjectIds], plan: await this.replan() };
  }
}

module.exports = { ActiveCatalogScanner, MAX_ACTIVE_CATALOG_SCAN_TARGETS, READ_CATALOG_SCAN_SELECTION_EXPRESSION, buildActiveCatalogInspectExpression, buildRestoreCatalogSelectionExpression };
