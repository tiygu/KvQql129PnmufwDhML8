"use strict";

const MODE_SCORE_DIMENSIONS = Object.freeze([
  { field: "targetLevelCoverage", direction: -1 },
  { field: "energy", direction: 1 },
  { field: "peakOccupied", direction: 1 },
  { field: "mergeCount", direction: 1 },
  { field: "overshootUnits", direction: 1 },
]);

function modeMetrics(mode, demands, board) {
  const relevant = new Map((demands || []).filter((demand) => Number(demand.deficitUnits) > 0).map((demand) => [String(demand.chainId), demand]));
  let usefulUnitsPerClick = 0;
  const projectedOutputCount = Number(mode.planningDistribution?.feasibilityOutcomesPerAction);
  let outputCountPerClick = Number.isFinite(projectedOutputCount) && projectedOutputCount > 0 ? projectedOutputCount : 0;
  const targetLevelHits = new Set();
  for (const drop of mode.drops || []) {
    const probability = Number(drop.probability ?? 1), count = Number(drop.count ?? drop.weight ?? 1);
    if (!(Number.isFinite(projectedOutputCount) && projectedOutputCount > 0)) outputCountPerClick += probability * count;
    const demand = relevant.get(String(drop.chainId));
    if (!demand || Number(drop.level || 0) > Number(demand.maxTargetLevel || Infinity)) continue;
    usefulUnitsPerClick += probability * count * Number(drop.baseUnits || 0);
    targetLevelHits.add(String(drop.chainId));
  }
  const deficitUnits = [...relevant.values()].reduce((sum, demand) => sum + Number(demand.deficitUnits || 0), 0);
  const clicks = usefulUnitsPerClick > 0 ? Math.ceil(deficitUnits / usefulUnitsPerClick) : Infinity;
  const producedUnits = Number.isFinite(clicks) ? clicks * usefulUnitsPerClick : 0;
  const producedItems = Number.isFinite(clicks) ? Math.ceil(clicks * outputCountPerClick) : Infinity;
  return {
    targetLevelCoverage: relevant.size ? targetLevelHits.size / relevant.size : 0,
    energy: Number.isFinite(clicks) ? clicks * Number(mode.energyCost || 0) : Infinity,
    peakOccupied: Number.isFinite(producedItems) ? Number(board?.occupied || 0) + Math.ceil(outputCountPerClick) : Infinity,
    mergeCount: Number.isFinite(producedItems) ? Math.max(0, producedItems - 1) : Infinity,
    overshootUnits: Math.max(0, producedUnits - deficitUnits),
  };
}

function compareModeMetrics(left, right) {
  for (const dimension of MODE_SCORE_DIMENSIONS) {
    const difference = (Number(left[dimension.field]) - Number(right[dimension.field])) * dimension.direction;
    if (difference) return difference;
  }
  return 0;
}

function compareModeScores(left, right) {
  return compareModeMetrics(left.metrics, right.metrics) || String(left.mode.modeId).localeCompare(String(right.mode.modeId));
}

function hasMaterialSwitchBenefit(current, selected) {
  return selected.metrics.targetLevelCoverage - current.metrics.targetLevelCoverage >= 0.25
    || current.metrics.energy - selected.metrics.energy >= 1
    || current.metrics.peakOccupied - selected.metrics.peakOccupied >= 1
    || current.metrics.mergeCount - selected.metrics.mergeCount >= 1
    || current.metrics.overshootUnits - selected.metrics.overshootUnits >= 1;
}

function selectProductionMode({ producer, currentModeId = null, demands = [], board = {} }) {
  const modes = (producer?.modes || []).filter((mode) => !mode.inferred);
  const locked = modes.filter((mode) => mode.humanLocked);
  if (locked.length) {
    const mode = locked.find((candidate) => String(candidate.modeId) === String(currentModeId)) || [...locked].sort((left, right) => String(left.modeId).localeCompare(String(right.modeId)))[0];
    const metrics = modeMetrics(mode, demands, board);
    const capacityFeasible = !Number.isFinite(Number(board?.capacity)) || metrics.peakOccupied <= Number(board.capacity);
    const executable = mode.unlocked !== false && Number.isFinite(metrics.energy) && metrics.targetLevelCoverage > 0 && capacityFeasible;
    return { mode, metrics, executable, shouldSwitch: executable && String(mode.modeId) !== String(currentModeId), reason: executable ? "human-mode-lock" : "human-mode-lock-infeasible" };
  }
  const scored = modes.filter((mode) => mode.unlocked !== false)
    .map((mode) => ({ mode, metrics: modeMetrics(mode, demands, board) }))
    .filter((candidate) => Number.isFinite(candidate.metrics.energy) && candidate.metrics.targetLevelCoverage > 0);
  const capacityFeasible = (candidate) => !Number.isFinite(Number(board?.capacity)) || candidate.metrics.peakOccupied <= Number(board.capacity);
  const candidates = scored.filter(capacityFeasible);
  if (!candidates.length) return null;
  candidates.sort(compareModeScores);
  const selected = candidates[0];
  const current = candidates.find((candidate) => String(candidate.mode.modeId) === String(currentModeId));
  if (current && compareModeMetrics(current.metrics, selected.metrics) === 0) return { ...current, executable: true, shouldSwitch: false, reason: "current-mode-equivalent" };
  if (current && String(selected.mode.modeId) !== String(currentModeId) && !hasMaterialSwitchBenefit(current, selected)) return { ...current, executable: true, shouldSwitch: false, reason: "current-mode-hysteresis" };
  return {
    ...selected,
    executable: true,
    shouldSwitch: String(selected.mode.modeId) !== String(currentModeId),
    reason: String(selected.mode.modeId) === String(currentModeId) ? "current-mode-best" : "mode-benefit-verified",
  };
}

module.exports = { MODE_SCORE_DIMENSIONS, modeMetrics, compareModeMetrics, compareModeScores, hasMaterialSwitchBenefit, selectProductionMode };
