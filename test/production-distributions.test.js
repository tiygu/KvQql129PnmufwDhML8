"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const {
  PRODUCTION_DISTRIBUTION_RULES,
  createDistributionState,
  updateDistributionState,
  projectPlanningDistribution,
} = require("../src/production-distributions");
const { AutomationDatabase } = require("../src/automation-database");
const { productionModeRuntimeHelpersPrelude } = require("../src/production-mode-runtime");

const theory = {
  configVersion: "cfg-17",
  extractionSource: "runtime:CreateData.17",
  outcomes: [
    { itemId: "apple", weight: 3 },
    { itemId: "pear", weight: 1 },
  ],
};

function createSeededRandom(seed) {
  let value = Number(seed) >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function sampleOutcome(distribution, random) {
  const draw = random();
  let cumulative = 0;
  for (const outcome of distribution.outcomes) {
    cumulative += outcome.probability;
    if (draw < cumulative) return outcome.itemId;
  }
  return distribution.outcomes.at(-1).itemId;
}

test("theoretical production distributions retain provenance and keep mode priors isolated", () => {
  const appleMode = createDistributionState({ producerItemId: "tree", modeId: "fruit", theoreticalDistribution: theory });
  const woodMode = createDistributionState({
    producerItemId: "tree",
    modeId: "wood",
    theoreticalDistribution: { configVersion: "cfg-18", extractionSource: "runtime:WoodData", outcomes: [{ itemId: "log", weight: 1 }] },
  });

  assert.equal(appleMode.theoreticalDistribution.configVersion, "cfg-17");
  assert.equal(appleMode.theoreticalDistribution.extractionSource, "runtime:CreateData.17");
  assert.deepEqual(appleMode.theoreticalDistribution.outcomes.map(({ itemId, weight }) => [itemId, weight]), [["apple", 3], ["pear", 1]]);
  assert.deepEqual(woodMode.posteriorDistribution.outcomes.map(({ itemId }) => itemId), ["log"]);
  assert.equal(appleMode.observedDistribution.sampleSize, 0);
});

test("runtime mode discovery extracts a versioned theoretical distribution for every mode", () => {
  const expression = productionModeRuntimeHelpersPrelude();
  assert.match(expression, /itemConfig\.CreateData/);
  assert.match(expression, /grid\.item\.itemConfig\.CreateData/);
  assert.match(expression, /theoreticalDistribution:productionTheoryFor\(grid,modeId\)/);
});

test("each attributable action updates the posterior immediately and unseen outcomes retain mass", () => {
  const initial = createDistributionState({ producerItemId: "tree", modeId: "fruit", theoreticalDistribution: theory });
  const fixtureRandom = createSeededRandom(14);
  const fixtureOutcome = sampleOutcome({ outcomes: [{ itemId: "apple", probability: 0.2 }, { itemId: "pear", probability: 0.8 }] }, fixtureRandom);
  const updated = updateDistributionState(initial, { actionId: "a-1", outcomeItemIds: [fixtureOutcome], attributable: true });

  assert.equal(updated.observedDistribution.sampleSize, 1);
  assert.equal(updated.observedDistribution.outcomes.find((entry) => entry.itemId === fixtureOutcome).count, 1);
  assert.notEqual(updated.posteriorDistribution.outcomes.find((entry) => entry.itemId === fixtureOutcome).probability, initial.posteriorDistribution.outcomes.find((entry) => entry.itemId === fixtureOutcome).probability);
  assert.ok(updated.posteriorDistribution.unseen.probability > 0);
  assert.equal(updated.posteriorDistribution.updatedByActionId, "a-1");
});

test("planning projections expose uncertainty, posterior expectation, and conservative feasibility", () => {
  let state = createDistributionState({ producerItemId: "tree", modeId: "fruit", theoreticalDistribution: theory });
  state = updateDistributionState(state, { actionId: "a-1", outcomeItemIds: ["apple"], attributable: true });
  const observation = projectPlanningDistribution(state, "observation");
  const assisted = projectPlanningDistribution(state, "assisted");
  const automatic = projectPlanningDistribution(state, "automatic");

  assert.ok(observation.outcomes.every((entry) => entry.uncertainty && entry.expectedProbability != null));
  assert.ok(observation.uncertaintyMass > 0);
  assert.equal(assisted.outcomes[0].probability, assisted.outcomes[0].expectedProbability);
  assert.ok(automatic.outcomes.every((entry, index) => entry.probability <= assisted.outcomes[index].probability));
  assert.equal(automatic.basis, "conservative-feasibility");
  assert.equal(automatic.rules.minimumReliableActions, PRODUCTION_DISTRIBUTION_RULES.minimumReliableActions);
  assert.equal(automatic.rules.automaticProbability, "lower-95-confidence-bound");
  assert.equal(automatic.stability, "low-sample");
});

test("posterior planning preserves per-mode output multiplicity", () => {
  let state = createDistributionState({
    producerItemId: "tree",
    modeId: "quad",
    theoreticalDistribution: { ...theory, outputsPerAction: 4 },
  });
  state = updateDistributionState(state, { actionId: "quad-1", outcomeItemIds: ["apple", "apple", "pear", "pear"], attributable: true });
  const planning = projectPlanningDistribution(state, "assisted");
  assert.equal(planning.expectedOutcomesPerAction, 4);
  assert.equal(planning.feasibilityOutcomesPerAction, 4);
  assert.ok(planning.outcomes.every((outcome) => outcome.count === 4));
});

test("fixed random fixtures are stable and posterior converges toward repeated observations", () => {
  const randomA = createSeededRandom(90210);
  const randomB = createSeededRandom(90210);
  const distribution = { outcomes: [{ itemId: "a", probability: 0.2 }, { itemId: "b", probability: 0.8 }] };
  assert.deepEqual(Array.from({ length: 20 }, () => sampleOutcome(distribution, randomA)), Array.from({ length: 20 }, () => sampleOutcome(distribution, randomB)));

  let state = createDistributionState({ producerItemId: "p", modeId: "m", theoreticalDistribution: theory });
  const convergenceRandom = createSeededRandom(90210);
  for (let index = 0; index < 500; index += 1) state = updateDistributionState(state, { actionId: `sample-${index}`, outcomeItemIds: [sampleOutcome(distribution, convergenceRandom) === "b" ? "pear" : "apple"], attributable: true });
  assert.ok(state.posteriorDistribution.outcomes.find((entry) => entry.itemId === "pear").probability > 0.75);
});

test("database stores uncertain actions separately and emits review events for significant conflict", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "production-distributions-"));
  const database = new AutomationDatabase(path.join(dir, "automation.db"));
  database.upsertTheoreticalProductionDistribution({ producerItemId: "tree", modeId: "fruit", theoreticalDistribution: theory });
  for (let index = 0; index < 12; index += 1) {
    database.recordProductionActionObservation({ actionId: `certain-${index}`, producerItemId: "tree", modeId: "fruit", outcomeItemIds: ["pear"], attributable: true });
  }
  const planningBeforeUncertain = database.getProductionDistribution("tree", "fruit", { executionMode: "automatic" }).planningDistribution;
  database.recordProductionActionObservation({ actionId: "uncertain-1", attributable: false, reason: "verification_read_error", outcomeItemIds: ["apple"] });
  const planningAfterUncertain = database.getProductionDistribution("tree", "fruit", { executionMode: "automatic" }).planningDistribution;
  const mode = database.observeCatalogObject({
    objectType: "production-mode",
    objectId: "tree:fruit",
    payload: {
      producerItemId: "tree",
      modeId: "fruit",
      energyCost: 1,
      outputs: [{ itemId: "apple", count: 1, probability: 1 }],
      unlocked: true,
      switchEntry: { status: "available", method: "fixture" },
    },
    sourceType: "production-attribution-conflict",
    sourceRef: "uncertain-1",
    countDuplicate: false,
  });
  const unreliableEvidence = database.getCatalogObject("production-mode", "tree:fruit").evidence[0];
  const rejectedMode = database.setCatalogEvidenceDisposition(
    "production-mode",
    "tree:fruit",
    unreliableEvidence.id,
    "rejected",
    {
      reason: "operator: sample attribution unresolved",
      actor: "operator",
      note: "sample attribution unresolved",
      action: "reject-evidence",
      expectedRevision: mode.revision,
    },
  );
  const planningAfterRejection = database.getProductionDistribution("tree", "fruit", { executionMode: "automatic" }).planningDistribution;

  const state = database.getProductionDistribution("tree", "fruit");
  assert.equal(state.observedDistribution.sampleSize, 12);
  assert.equal(database.listUncertainProductionActions().length, 1);
  assert.equal(database.listUncertainProductionActions()[0].assignedOutcomeItemIds.length, 0);
  assert.deepEqual(planningAfterUncertain, planningBeforeUncertain);
  assert.deepEqual(planningAfterRejection, planningBeforeUncertain);
  assert.equal(rejectedMode.catalogAuditSummary.action, "reject-evidence");
  assert.equal(state.confidence.level, "reduced");
  assert.ok(database.listProductionDistributionReviewEvents().some((event) => event.eventType === "theory-observation-conflict"));

  database.upsertTheoreticalProductionDistribution({ producerItemId: "tree", modeId: "wood", theoreticalDistribution: { configVersion: "wood-1", extractionSource: "fixture", outcomes: [{ itemId: "log", weight: 1 }] } });
  database.recordProductionActionObservation({ actionId: "wood-1", producerItemId: "tree", modeId: "wood", outcomeItemIds: ["log"], attributable: true });
  assert.equal(database.getProductionDistribution("tree", "wood").observedDistribution.sampleSize, 1);
  assert.equal(database.getProductionDistribution("tree", "fruit").observedDistribution.sampleSize, 12);
  database.close();
  const reopened = new AutomationDatabase(path.join(dir, "automation.db"));
  assert.equal(reopened.getProductionDistribution("tree", "fruit").observedDistribution.sampleSize, 12);
  assert.equal(reopened.listUncertainProductionActions()[0].reason, "verification_read_error");
  reopened.close();
});

test("attributable outcomes survive before theory extraction and are replayed into the mode posterior", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "production-pending-theory-"));
  const database = new AutomationDatabase(path.join(dir, "automation.db"));
  const pending = database.recordProductionActionObservation({ actionId: "early-1", producerItemId: "tree", modeId: "fruit", outcomeItemIds: ["pear"], attributable: true });
  assert.equal(pending.pendingTheory, true);
  assert.equal(database.listUncertainProductionActions().length, 0);
  database.upsertTheoreticalProductionDistribution({ producerItemId: "tree", modeId: "fruit", theoreticalDistribution: theory });
  assert.equal(database.getProductionDistribution("tree", "fruit").observedDistribution.sampleSize, 1);
  assert.equal(database.getProductionDistribution("tree", "fruit").observedDistribution.outcomes[0].itemId, "pear");
  database.close();
});

test("replacing theory with a materially conflicting version creates a review event immediately", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "production-replaced-theory-"));
  const database = new AutomationDatabase(path.join(dir, "automation.db"));
  database.upsertTheoreticalProductionDistribution({ producerItemId: "tree", modeId: "fruit", theoreticalDistribution: theory });
  for (let index = 0; index < 10; index += 1) database.recordProductionActionObservation({ actionId: `apple-${index}`, producerItemId: "tree", modeId: "fruit", outcomeItemIds: ["apple"], attributable: true });
  database.upsertTheoreticalProductionDistribution({ producerItemId: "tree", modeId: "fruit", theoreticalDistribution: { configVersion: "cfg-conflict", extractionSource: "runtime:new", outcomes: [{ itemId: "pear", weight: 1 }] } });
  assert.equal(database.getProductionDistribution("tree", "fruit").confidence.level, "reduced");
  assert.ok(database.listProductionDistributionReviewEvents().some((event) => event.details.theoreticalDistribution.configVersion === "cfg-conflict"));
  database.close();
});
