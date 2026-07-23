"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");
const { CatalogReviewGate } = require("../src/catalog-review-gate");
const { collectPassiveCatalogEvidence } = require("../src/catalog-evidence");
const { selectProductionMode } = require("../src/production-modes");
const { buildOptimizationPlan } = require("../src/order-optimizer");
const { buildAtomicProducerTouchExpression } = require("../src/board-runner");
const { buildProductionModeReadExpression, buildProductionModeSwitchExpression, ProductionModeExecutor } = require("../src/production-mode-actions");

function withDatabase(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "production-mode-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try { return run(database); }
  finally { database.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

function observe(database, objectType, objectId, payload, sourceType = "runtime-capture") {
  database.observeCatalogObject({ objectType, objectId, payload, sourceType, sourceRef: `${sourceType}:${objectId}`, countDuplicate: false });
}

test("Production Profile and each Production Mode have independent evidence lifecycle and projection", () => withDatabase((database) => {
  observe(database, "item-identity", "p", { id: "p", chainId: "producer", level: 1 });
  observe(database, "item-identity", "a1", { id: "a1", chainId: "a", level: 1 });
  observe(database, "merge-relation", "p", { itemId: "p", chainId: "producer", level: 1, mergeTarget: null });
  observe(database, "merge-relation", "a1", { itemId: "a1", chainId: "a", level: 1, mergeTarget: null });
  observe(database, "production-profile", "p", { producerItemId: "p", energyCost: 1, theoreticalDistribution: { sampleSpaceSize: 1, outcomes: [{ itemId: "a1", weight: 1, probability: 1 }] } });
  observe(database, "production-mode", "p:single", { producerItemId: "p", modeId: "single", energyCost: 1, unlocked: true, current: true, switchEntry: { status: "available", method: "setMultipleMode" }, outputs: [{ itemId: "a1", count: 1, probability: 1 }] });
  observe(database, "production-mode", "p:quad", { producerItemId: "p", modeId: "quad", energyCost: 4, unlocked: true, current: false, switchEntry: { status: "available", method: "setMultipleMode" }, outputs: [{ itemId: "a1", count: 4, probability: 1 }] }, "visual-evidence");
  new CatalogReviewGate(database).evaluateAll();

  assert.equal(database.getCatalogObject("production-profile", "p").status, "active");
  assert.equal(database.getCatalogObject("production-mode", "p:single").status, "active");
  assert.equal(database.getCatalogObject("production-mode", "p:quad").status, "provisional");
  assert.deepEqual(database.getCatalogProjection().producers[0].modes.map((mode) => mode.modeId), ["single"]);
  assert.deepEqual(database.getCatalogProjection({ includeProvisional: true }).producers[0].modes.map((mode) => mode.modeId).sort(), ["quad", "single"]);
  const mode = database.getCatalogObject("production-mode", "p:single");
  database.applyCatalogRuling({ objectType: "production-mode", objectId: "p:single", fieldPath: "humanLocked", decision: "modify", value: true, actor: "tester", note: "lock verified mode", expectedRevision: mode.revision });
  assert.equal(database.getCatalogProjection().producers[0].modes[0].humanLocked, true);

  collectPassiveCatalogEvidence(database, { state: { board: { grids: [] }, orders: [], producers: [{ index: 4, itemId: "p", energyCost: 2, currentProductionModeId: "double", availableProductionModes: [{ modeId: "double", unlocked: true }], productionModeSwitchEntry: { status: "available", method: "setMultipleMode" } }] } });
  new CatalogReviewGate(database).evaluateObject("production-mode", "p:double");
  const passive = database.getCatalogObject("production-mode", "p:double");
  assert.equal(passive.status, "observed");
  assert.deepEqual(passive.algorithmCandidate.outputs, []);
  const verifiedAction = { type: "produce", verified: true, producerItemId: "p", productionModeId: "double", actualOutputItemIds: ["a1", "a1"] };
  collectPassiveCatalogEvidence(database, { actionDiff: verifiedAction });
  new CatalogReviewGate(database).evaluateObject("production-mode", "p:double");
  assert.equal(database.getCatalogObject("production-mode", "p:double").status, "provisional");
  collectPassiveCatalogEvidence(database, { actionDiff: verifiedAction });
  new CatalogReviewGate(database).evaluateObject("production-mode", "p:double");
  assert.equal(database.getCatalogObject("production-mode", "p:double").status, "active");
}));

test("current production mode uses structured runtime distribution without requiring a production action first", () => withDatabase((database) => {
  observe(database, "item-identity", "p", { id: "p", chainId: "producer", level: 1 });
  observe(database, "item-identity", "a1", { id: "a1", chainId: "a", level: 1 });
  observe(database, "merge-relation", "p", { itemId: "p", chainId: "producer", level: 1, mergeTarget: null });
  observe(database, "merge-relation", "a1", { itemId: "a1", chainId: "a", level: 1, mergeTarget: null });
  observe(database, "production-profile", "p", { producerItemId: "p", energyCost: 1, theoreticalDistribution: { sampleSpaceSize: 1, outcomes: [{ itemId: "a1", weight: 1, probability: 1 }] } });
  new CatalogReviewGate(database).evaluateAll();

  collectPassiveCatalogEvidence(database, { state: { board: { grids: [] }, orders: [], producers: [{
    index: 4,
    itemId: "p",
    energyCost: 1,
    currentProductionModeId: "single",
    availableProductionModes: [
      { modeId: "single", unlocked: true, theoreticalDistribution: { sampleSpaceSize: 1, outputsPerAction: 1, outcomes: [{ itemId: "a1", weight: 1, probability: 1 }] } },
      { modeId: "double", unlocked: true, theoreticalDistribution: { sampleSpaceSize: 1, outputsPerAction: 2, outcomes: [{ itemId: "a1", weight: 1, probability: 1 }] } },
    ],
    productionModeSwitchEntry: { status: "available", method: "setMultipleMode" },
  }] } });
  new CatalogReviewGate(database).evaluateAll();

  const current = database.getCatalogObject("production-mode", "p:single");
  assert.equal(current.status, "active");
  assert.equal(current.evidence.some((entry) => entry.sourceType === "structured-runtime"), true);
  assert.deepEqual(current.algorithmCandidate.outputs, [{ itemId: "a1", count: 1, probability: 1 }]);
  assert.equal(database.getCatalogObject("production-mode", "p:double").status, "observed");
  assert.deepEqual(database.getCatalogProjection().producers[0].modes.map((mode) => mode.modeId), ["single"]);
}));

test("planner compares energy, peak space, merges, target level, and overshoot while avoiding useless switches", () => {
  const producer = { itemId: "p", modes: [
    { modeId: "single", energyCost: 1, unlocked: true, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, count: 1, probability: 1 }] },
    { modeId: "quad", energyCost: 3, unlocked: true, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, count: 4, probability: 1 }] },
  ] };
  const selected = selectProductionMode({ producer, currentModeId: "single", demands: [{ chainId: "a", deficitUnits: 4, maxTargetLevel: 2 }], board: { occupied: 5, capacity: 9 } });
  assert.equal(selected.mode.modeId, "quad");
  assert.deepEqual(Object.keys(selected.metrics).sort(), ["energy", "mergeCount", "overshootUnits", "peakOccupied", "targetLevelCoverage"]);

  const equal = selectProductionMode({ producer: { ...producer, modes: producer.modes.map((mode) => ({ ...mode, energyCost: 1, drops: [{ ...mode.drops[0], count: 1 }] })) }, currentModeId: "single", demands: [{ chainId: "a", deficitUnits: 1, maxTargetLevel: 1 }], board: { occupied: 1, capacity: 9 } });
  assert.equal(equal.mode.modeId, "single");

  producer.modes[0].humanLocked = true;
  assert.equal(selectProductionMode({ producer, currentModeId: "quad", demands: [{ chainId: "a", deficitUnits: 4, maxTargetLevel: 2 }], board: { occupied: 5, capacity: 9 } }).mode.modeId, "single");

  producer.modes[0].unlocked = false;
  const blockedLock = selectProductionMode({ producer, currentModeId: "quad", demands: [{ chainId: "other", deficitUnits: 1, maxTargetLevel: 1 }], board: { occupied: 1, capacity: 9 } });
  assert.equal(blockedLock.mode.modeId, "single");
  assert.equal(blockedLock.executable, false);
  assert.equal(blockedLock.shouldSwitch, false);

  const similar = { itemId: "p", modes: [
    { modeId: "current", energyCost: 1, unlocked: true, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, count: 1, probability: 1 }] },
    { modeId: "tiny-gain", energyCost: 0.9, unlocked: true, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, count: 1, probability: 1 }] },
  ] };
  const stable = selectProductionMode({ producer: similar, currentModeId: "current", demands: [{ chainId: "a", deficitUnits: 1, maxTargetLevel: 1 }], board: { occupied: 1, capacity: 9 } });
  assert.equal(stable.mode.modeId, "current");
  assert.equal(stable.reason, "current-mode-hysteresis");
});

test("order planning exposes a verified mode switch before production", () => {
  const planningCatalog = {
    coverage: {}, evidence: { objects: [] },
    items: [
      { id: "p", chainId: "p", level: 1, baseUnits: 1 },
      { id: "a1", chainId: "a", level: 1, baseUnits: 1, mergeTarget: "a2" },
      { id: "a2", chainId: "a", level: 2, baseUnits: 2, mergeTarget: "a3" },
      { id: "a3", chainId: "a", level: 3, baseUnits: 4 },
    ],
    producers: [{ itemId: "p", energyCost: 1, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, count: 1, probability: 1 }], modes: [
      { modeId: "single", energyCost: 1, unlocked: true, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, count: 1, probability: 1 }] },
      { modeId: "quad", energyCost: 3, unlocked: true, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, count: 4, probability: 1 }] },
    ] }],
  };
  const state = {
    schemaVersion: 1, scene: "board", resources: { coins: 0, energy: 10 },
    board: { width: 7, height: 1, occupied: 1, empty: 6, requiredItemCounts: { a3: 1 }, mergeCandidates: [], grids: [{ index: 0, itemId: "p", normal: true, moveable: true, produceCount: 5, energyCost: 1, currentProductionModeId: "single", availableProductionModes: [{ modeId: "single", unlocked: true }, { modeId: "quad", unlocked: true }], productionModeSwitchEntry: { status: "available", method: "setMultipleMode" } }] },
    orders: [{ slot: "o", rewardCoins: 10, ready: false, items: [{ itemId: "a3", complete: false }] }], warehouse: null,
  };
  const plan = buildOptimizationPlan({ catalog: planningCatalog, state });
  assert.equal(plan.recommended.nextAction.type, "switch-production-mode");
  assert.equal(plan.recommended.nextAction.productionModeId, "quad");
  assert.equal(plan.recommended.producerSteps[0].productionModeDecision.metrics.energy, 3);
  assert.equal(plan.recommended.producerSteps[0].clicks, 1);
  assert.equal(plan.recommended.estimatedEnergy, 3);

  const modeBlockedCatalog = JSON.parse(JSON.stringify(planningCatalog));
  modeBlockedCatalog.producers[0].modes = [];
  modeBlockedCatalog.evidence.objects = [{ objectType: "production-mode", objectId: "p:single", status: "observed", disposition: "enabled" }];
  const blocked = buildOptimizationPlan({ catalog: modeBlockedCatalog, state });
  assert.equal(blocked.recommended, null);
  assert.equal(blocked.plans[0].blockingReason, "catalog-evidence-insufficient");
  assert.equal(blocked.plans[0].evidenceBlock.blockers[0].objectType, "production-mode");
  assert.equal(blocked.plans[0].evidenceBlock.blockers[0].objectId, "p:single");

  const lockedCatalog = JSON.parse(JSON.stringify(planningCatalog));
  lockedCatalog.producers[0].modes[1].humanLocked = true;
  const lockedState = JSON.parse(JSON.stringify(state));
  lockedState.board.grids[0].availableProductionModes = [{ modeId: "single", unlocked: true }];
  lockedState.board.grids[0].productionModeSwitchEntry = { status: "unavailable", method: null };
  const lockedPlan = buildOptimizationPlan({ catalog: lockedCatalog, state: lockedState });
  assert.equal(lockedPlan.recommended, null);
  assert.notEqual(lockedPlan.plans[0].nextAction?.type, "produce");
  assert.notEqual(lockedPlan.plans[0].nextAction?.type, "switch-production-mode");
});

test("native mode read and switch are atomic and production touch guards the planned mode", async () => {
  const read = buildProductionModeReadExpression(4);
  const change = buildProductionModeSwitchExpression(4, "quad", "single");
  assert.match(read, /_multipleModeMap/);
  assert.match(change, /production-mode-switch/);
  assert.match(change, /expectedCurrentModeId/);
  assert.doesNotMatch(change, /onTouch/);
  const touch = buildAtomicProducerTouchExpression(4, "quad");
  assert.match(touch, /production_mode_mismatch/);
  assert.match(touch, /expectedModeId="quad"/);

  let reads = 0;
  const executor = new ProductionModeExecutor({
    client: { evaluate: async (expression) => expression.includes("production-mode-switch")
      ? { ok: true, type: "production-mode-switch", index: 4, previousModeId: "single", requestedModeId: "quad" }
      : { ok: true, index: 4, producerItemId: "p", currentModeId: reads++ ? "quad" : "single", availableModes: [{ modeId: "single", unlocked: true }, { modeId: "quad", unlocked: true }], switchEntry: { status: "available", method: "setMultipleMode" } } },
    contextId: 7, settleMs: 1,
  });
  const result = await executor.switch(4, "quad", { execute: true, expectedCurrentModeId: "single" });
  assert.equal(result.ok, true);
  assert.equal(result.after.currentModeId, "quad");
});

test("failed mode verification blocks production", async () => {
  const executor = new ProductionModeExecutor({
    client: { evaluate: async (expression) => expression.includes("production-mode-switch")
      ? { ok: true, type: "production-mode-switch" }
      : { ok: true, index: 4, producerItemId: "p", currentModeId: "single", availableModes: [{ modeId: "single", unlocked: true }, { modeId: "quad", unlocked: true }], switchEntry: { status: "available", method: "setMultipleMode" } } },
    contextId: 7, settleMs: 1,
  });
  const result = await executor.switch(4, "quad", { execute: true, expectedCurrentModeId: "single" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "production-mode-switch-not-observed");
});
