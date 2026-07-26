"use strict";

const {
  BOARD_CONTROL_STATE_EXPRESSION,
  buildAtomicMergeExpression,
} = require("./board-runner");

// board-scan 和 Node 侧编排器共享同一份只读状态，避免两套候选算法产生差异。
const BOARD_SCAN_EXPRESSION = BOARD_CONTROL_STATE_EXPRESSION;

function printBoardScan(scan, output = console) {
  if (!scan?.ok) {
    output.log(`棋盘扫描失败：${scan?.reason || "unknown"}`);
    return;
  }
  output.log(`棋盘：${scan.width}×${scan.height}，已占用 ${scan.occupied}，空格 ${scan.empty}，界面${scan.boardVisible ? "已打开" : "未打开"}`);
  output.log("\n安全合成候选（已扣除订单保留数量）：");
  output.table(scan.mergeCandidates.map((item) => ({
    物品ID: item.itemId,
    来源格: item.from,
    目标格: item.to,
    等级: item.level,
    合成结果ID: item.mergeTarget,
    预测结果码: item.predictedResult,
  })));
}

function buildBoardMergeExpression(from, to, execute = false) {
  const sourceIndex = Number(from);
  const targetIndex = Number(to);
  if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) throw new Error("board-merge requires integer --from and --to indexes");
  if (sourceIndex === targetIndex) throw new Error("board-merge source and target must differ");
  if (execute) return buildAtomicMergeExpression(sourceIndex, targetIndex);
  return `(() => {
    const G = globalThis;
    const cc = G.cc || G.GameGlobal?.cc;
    const scene = cc?.director?.getScene?.();
    const entry = scene?.getChildByName?.("Entry") || scene?.children?.find?.((node) => node?.name === "Entry");
    const runtime = (entry?._components || []).find((component) => Array.isArray(component?.mControllers));
    const controller = runtime?.mControllers?.find((item) => item?._controllerClazzName === "UserBoardViewController");
    const boardView = controller?.view?._boardView?._gameBoardView;
    const grids = boardView?._boardStore?._state?._gameBoard?.__private_95_grids;
    if (!controller || !boardView || !Array.isArray(grids)) return { ok: false, reason: "board_runtime_not_found" };
    if (!controller.isViewVisible) return { ok: false, reason: "board_not_visible" };
    const source = grids[${sourceIndex}], target = grids[${targetIndex}];
    if (!source || !target) return { ok: false, reason: "grid_not_found" };
    const canMerge = !!boardView._operatorCenter.itemCanMergeWith(source.item, target.item);
    return {
      ok: canMerge,
      executed: false,
      reason: canMerge ? null : "pair_not_mergeable",
      predictedResult: boardView._dragHandler.predictDragResult(source, target),
      before: {
        source: { index: source.index, itemId: String(source.itemId || ""), mergeTarget: source.item?.itemConfig?.MergeTarget ?? null },
        target: { index: target.index, itemId: String(target.itemId || "") }
      }
    };
  })()`;
}

function printBoardMerge(result, output = console) {
  if (!result?.ok) {
    output.log(`合成${result?.executed ? "执行" : "预检"}未完成：${result?.reason || "unknown"}`);
    return;
  }
  if (!result.executed && result.before) {
    output.log(`合成预检通过：格 ${result.before.source.index}（${result.before.source.itemId}）→ 格 ${result.before.target.index}，预测结果码 ${result.predictedResult}`);
    output.log("加入 --execute true 后发送一个原子拖拽动作。");
    return;
  }
  output.log(`原子合成动作已发送：格 ${result.from} → 格 ${result.to}；下一次状态读取将验证结果。`);
}

module.exports = {
  BOARD_SCAN_EXPRESSION,
  printBoardScan,
  buildBoardMergeExpression,
  printBoardMerge,
};
