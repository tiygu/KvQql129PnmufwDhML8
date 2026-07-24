"use strict";

const UNSEEN_OUTCOME = "__unseen__";
const DEFAULT_PRIOR_STRENGTH = 4;
const DEFAULT_UNSEEN_ALPHA = 1;
const CONFLICT_MINIMUM_ACTIONS = 8;
const CONFLICT_DISTANCE_THRESHOLD = 0.35;
const PRODUCTION_DISTRIBUTION_RULES = Object.freeze({
  priorStrength: DEFAULT_PRIOR_STRENGTH,
  unseenOutcomeAlpha: DEFAULT_UNSEEN_ALPHA,
  minimumReliableActions: CONFLICT_MINIMUM_ACTIONS,
  conflictDistanceThreshold: CONFLICT_DISTANCE_THRESHOLD,
  automaticProbability: "lower-95-confidence-bound",
  unresolvedAttribution: "excluded",
});

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeTheoreticalDistribution(distribution = {}) {
  const weights = new Map();
  for (const outcome of distribution.outcomes || []) {
    const itemId = String(outcome?.itemId || "");
    const weight = finiteNonNegative(outcome?.weight ?? outcome?.probability);
    if (itemId && weight > 0) weights.set(itemId, (weights.get(itemId) || 0) + weight);
  }
  const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
  if (!(totalWeight > 0)) throw new TypeError("theoretical production distribution requires positive outcome weights");
  return {
    configVersion: String(distribution.configVersion || "unknown"),
    extractionSource: String(distribution.extractionSource || distribution.source || "unknown"),
    outputsPerAction: Math.max(1, finiteNonNegative(distribution.outputsPerAction, 1)),
    totalWeight,
    outcomes: [...weights].map(([itemId, weight]) => ({ itemId, weight, probability: weight / totalWeight })),
  };
}

function posteriorFrom(theoreticalDistribution, counts = {}, sampleSize = 0, options = {}) {
  const priorStrength = finiteNonNegative(options.priorStrength, DEFAULT_PRIOR_STRENGTH) || DEFAULT_PRIOR_STRENGTH;
  const unseenAlpha = finiteNonNegative(options.unseenAlpha, DEFAULT_UNSEEN_ALPHA) || DEFAULT_UNSEEN_ALPHA;
  const theoryByItem = new Map(theoreticalDistribution.outcomes.map((entry) => [entry.itemId, entry.probability]));
  const itemIds = [...theoryByItem.keys()];
  for (const itemId of Object.keys(counts)) if (!theoryByItem.has(itemId)) itemIds.push(itemId);
  const outcomes = itemIds.map((itemId) => ({
    itemId,
    alpha: priorStrength * (theoryByItem.get(itemId) || 0) + finiteNonNegative(counts[itemId]),
  }));
  const totalAlpha = unseenAlpha + outcomes.reduce((sum, entry) => sum + entry.alpha, 0);
  for (const entry of outcomes) {
    entry.probability = entry.alpha / totalAlpha;
    entry.uncertainty = probabilityInterval(entry.probability, totalAlpha);
  }
  return {
    sampleSize,
    priorStrength,
    totalAlpha,
    outcomes,
    unseen: { itemId: UNSEEN_OUTCOME, alpha: unseenAlpha, probability: unseenAlpha / totalAlpha },
  };
}

function probabilityInterval(probability, effectiveSamples) {
  const standardError = Math.sqrt(Math.max(0, probability * (1 - probability) / Math.max(1, effectiveSamples + 1)));
  return { lower: Math.max(0, probability - 1.96 * standardError), upper: Math.min(1, probability + 1.96 * standardError) };
}

function conflictAssessment(theory, observed) {
  if (observed.sampleSize < CONFLICT_MINIMUM_ACTIONS) return { level: "developing", score: 1, distance: 0, reviewRequired: false };
  const empirical = new Map(observed.outcomes.map((entry) => [entry.itemId, entry.probability]));
  const theoretical = new Map(theory.outcomes.map((entry) => [entry.itemId, entry.probability]));
  const itemIds = new Set([...empirical.keys(), ...theoretical.keys()]);
  let distance = 0;
  for (const itemId of itemIds) distance += Math.abs((empirical.get(itemId) || 0) - (theoretical.get(itemId) || 0));
  distance /= 2;
  const reviewRequired = distance >= CONFLICT_DISTANCE_THRESHOLD;
  return { level: reviewRequired ? "reduced" : "established", score: Math.max(0, 1 - distance), distance, reviewRequired };
}

function createDistributionState({ producerItemId, modeId, theoreticalDistribution, priorStrength = DEFAULT_PRIOR_STRENGTH, unseenAlpha = DEFAULT_UNSEEN_ALPHA }) {
  const theory = normalizeTheoreticalDistribution(theoreticalDistribution);
  const observedDistribution = { sampleSize: 0, totalOutcomeCount: 0, meanOutcomesPerAction: 0, outcomes: [] };
  return {
    producerItemId: String(producerItemId),
    modeId: String(modeId),
    theoreticalDistribution: theory,
    theoreticalHistory: [theory],
    observedDistribution,
    posteriorDistribution: posteriorFrom(theory, {}, 0, { priorStrength, unseenAlpha }),
    confidence: conflictAssessment(theory, observedDistribution),
  };
}

function updateDistributionState(state, observation) {
  if (observation?.attributable !== true) throw new TypeError("only attributable production actions can update an observed distribution");
  const outcomeItemIds = (observation.outcomeItemIds || []).map(String).filter(Boolean);
  if (!outcomeItemIds.length) throw new TypeError("an attributable production action requires at least one observed outcome");
  const counts = Object.fromEntries((state.observedDistribution.outcomes || []).map((entry) => [entry.itemId, entry.count]));
  for (const itemId of outcomeItemIds) counts[itemId] = (counts[itemId] || 0) + 1;
  const totalOutcomeCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const sampleSize = Number(state.observedDistribution.sampleSize || 0) + 1;
  const observedDistribution = {
    sampleSize,
    totalOutcomeCount,
    meanOutcomesPerAction: totalOutcomeCount / sampleSize,
    outcomes: Object.entries(counts).map(([itemId, count]) => ({ itemId, count, probability: count / totalOutcomeCount })),
  };
  const posteriorDistribution = posteriorFrom(state.theoreticalDistribution, counts, sampleSize, state.posteriorDistribution);
  posteriorDistribution.updatedByActionId = String(observation.actionId || "unknown");
  const confidence = conflictAssessment(state.theoreticalDistribution, observedDistribution);
  return { ...structuredClone(state), observedDistribution, posteriorDistribution, confidence };
}

function replaceTheory(state, theoreticalDistribution) {
  const theory = normalizeTheoreticalDistribution(theoreticalDistribution);
  const counts = Object.fromEntries((state.observedDistribution.outcomes || []).map((entry) => [entry.itemId, entry.count]));
  const history = [...(state.theoreticalHistory || [state.theoreticalDistribution])];
  if (!history.some((entry) => JSON.stringify(entry) === JSON.stringify(theory))) history.push(theory);
  return {
    ...structuredClone(state),
    theoreticalDistribution: theory,
    theoreticalHistory: history,
    posteriorDistribution: posteriorFrom(theory, counts, state.observedDistribution.sampleSize, state.posteriorDistribution),
    confidence: conflictAssessment(theory, state.observedDistribution),
  };
}

function projectPlanningDistribution(state, executionMode = "assisted") {
  const normalizedMode = ["observation", "assisted", "automatic"].includes(executionMode) ? executionMode : "assisted";
  const priorStrength = Number(state.posteriorDistribution.priorStrength || DEFAULT_PRIOR_STRENGTH);
  const expectedOutcomesPerAction = (priorStrength * Number(state.theoreticalDistribution.outputsPerAction || 1) + Number(state.observedDistribution.totalOutcomeCount || 0))
    / (priorStrength + Number(state.observedDistribution.sampleSize || 0));
  const outcomes = state.posteriorDistribution.outcomes.map((entry) => {
    const expectedProbability = entry.probability;
    const probability = normalizedMode === "automatic" ? entry.uncertainty.lower : expectedProbability;
    return {
      itemId: entry.itemId,
      probability,
      expectedProbability,
      count: expectedOutcomesPerAction,
      ...(normalizedMode === "observation" ? { uncertainty: entry.uncertainty } : {}),
    };
  });
  return {
    source: "planning-posterior",
    mode: normalizedMode,
    basis: normalizedMode === "automatic" ? "conservative-feasibility" : "posterior-expectation",
    stability: state.observedDistribution.sampleSize < PRODUCTION_DISTRIBUTION_RULES.minimumReliableActions
      ? "low-sample"
      : state.confidence.reviewRequired ? "conflicted" : "established",
    sampleSize: state.observedDistribution.sampleSize,
    expectedOutcomesPerAction,
    feasibilityOutcomesPerAction: Math.max(expectedOutcomesPerAction, Number(state.theoreticalDistribution.outputsPerAction || 1)),
    confidence: state.confidence,
    rules: PRODUCTION_DISTRIBUTION_RULES,
    uncertaintyMass: Math.max(state.posteriorDistribution.unseen.probability, 1 - outcomes.reduce((sum, entry) => sum + entry.probability, 0)),
    outcomes,
  };
}

module.exports = {
  UNSEEN_OUTCOME,
  PRODUCTION_DISTRIBUTION_RULES,
  normalizeTheoreticalDistribution,
  createDistributionState,
  updateDistributionState,
  replaceTheory,
  projectPlanningDistribution,
};
