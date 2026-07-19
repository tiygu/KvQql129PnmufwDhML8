"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildOptimizationPlan } = require("../src/order-optimizer");
const { OrderCoinLoop } = require("../src/order-coin-loop");
const { AutomationDatabase } = require("../src/automation-database");
const { collectPassiveCatalogEvidence } = require("../src/catalog-evidence");
const { ActiveCatalogScanner, buildActiveCatalogInspectExpression, buildRestoreCatalogSelectionExpression } = require("../src/catalog-scan");

function catalog() {
  return {
    coverage: {},
    items: [
      { id: "a1", chainId: "a", level: 1, baseUnits: 1 },
      { id: "a2", chainId: "a", level: 2, baseUnits: 2 },
      { id: "p", chainId: "producer", level: 1, baseUnits: 1 },
    ],
    producers: [{ itemId: "p", energyCost: 1, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, probability: 1 }] }],
    evidence: { objects: [] },
  };
}

function state(orders) {
  return { schemaVersion: 1, scene: "board", resources: { energy: 10 }, board: { signature: "p", empty: 8, grids: [{ index: 1, itemId: "p", normal: true, moveable: true, produceCount: 3, energyCost: 1 }], mergeCandidates: [] }, orders };
}

test("an evidence-blocked order lists objects, fields, and required evidence while another order remains executable", () => {
  const current = state([
    { slot: "unknown", rewardCoins: 100, items: [{ itemId: "x9", complete: false }] },
    { slot: "known", rewardCoins: 10, items: [{ itemId: "a2", complete: false }] },
  ]);
  const result = buildOptimizationPlan({ catalog: catalog(), state: current });
  const blocked = result.plans.find((plan) => plan.slot === "unknown");
  assert.equal(result.recommended.slot, "known");
  assert.equal(blocked.blockingReason, "catalog-evidence-insufficient");
  assert.deepEqual(blocked.evidenceBlock.blockers.map((blocker) => blocker.objectType), ["item-identity", "merge-relation"]);
  assert.deepEqual(blocked.evidenceBlock.blockers[0].fields, ["itemId", "chainId", "level", "baseUnits"]);
  assert.ok(blocked.evidenceBlock.blockers[0].requiredEvidence.includes("structured-runtime"));
});

test("repository evidence pinpoints an inactive relation instead of blaming an Active identity", () => {
  const input = catalog();
  input.evidence.objects = [
    { objectType: "item-identity", objectId: "x2", status: "active", disposition: "enabled", effectiveValue: { itemId: "x2", chainId: "x", level: 2, baseUnits: 2 } },
    { objectType: "merge-relation", objectId: "x2", status: "observed", disposition: "enabled", effectiveValue: { itemId: "x2", chainId: "x", level: 2 } },
  ];
  const result = buildOptimizationPlan({ catalog: input, state: state([{ slot: "x", rewardCoins: 10, items: [{ itemId: "x2", complete: false }] }]) });
  assert.deepEqual(result.plans[0].evidenceBlock.blockers.map((blocker) => `${blocker.objectType}:${blocker.objectId}`), ["merge-relation:x2"]);
  assert.ok(result.plans[0].evidenceBlock.blockers[0].fields.includes("mergeTarget"));
});

test("all orders blocked by catalog evidence enter recoverable evidence-waiting", async () => {
  const current = state([{ slot: "x", rewardCoins: 10, items: [{ itemId: "x", complete: false }] }, { slot: "y", rewardCoins: 20, items: [{ itemId: "y", complete: false }] }]);
  const plan = buildOptimizationPlan({ catalog: catalog(), state: current });
  assert.equal(plan.status, "evidence-waiting");
  assert.equal(plan.boundaryReason, "evidence-waiting");
  assert.equal(plan.evidenceBlocks.length, 2);
  let boardActions = 0;
  const loop = new OrderCoinLoop({ collectState: async () => current, planOrders: async () => plan, runBoardAction: async () => { boardActions += 1; }, submitOrder: async () => ({ ok: true }) });
  const result = await loop.run({ execute: true, maxActions: 1 });
  assert.equal(result.reason, "evidence-waiting");
  assert.equal(result.status, "evidence-waiting");
  assert.equal(boardActions, 0);
});

test("passive collection records existing state and action diffs without an action callback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "passive-catalog-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  try {
    const observed = collectPassiveCatalogEvidence(database, {
      state: { board: { grids: [{ index: 2, itemId: "new-item", level: 3 }] }, orders: [{ items: [{ itemId: "order-item", complete: false }] }] },
      actionDiff: { type: "merge", itemId: "new-item", actualTarget: "merged-item" },
    });
    assert.ok(observed.length >= 3);
    assert.equal(database.getCatalogObject("item-identity", "new-item").status, "observed");
    assert.equal(
      database.getCatalogObject("merge-relation", "new-item").evidence.some(
        (entry) => entry.payload && entry.payload.mergeTarget === "merged-item"
      ),
      true
    );
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("active scan restores selection and rejects unexpected energy or board changes before reevaluation", async () => {
  const calls = [];
  let after = { scene: "board", resources: { energy: 10 }, board: { signature: "same" } };
  const scanner = new ActiveCatalogScanner({
    collectState: async () => after,
    readSelection: async () => 4,
    inspectItem: async (itemId) => { calls.push(`inspect:${itemId}`); return { itemId }; },
    restoreSelection: async (selection) => { calls.push(`restore:${selection}`); },
    collectEvidence: async (capture) => { calls.push(`evidence:${capture.itemId}`); return capture.itemId; },
    commitEvidence: async (staged) => { calls.push(`commit:${staged.join(",")}`); return staged; },
    reevaluate: async (objectIds) => { calls.push(`reevaluate:${objectIds.join(",")}`); },
    replan: async () => ({ recommended: { slot: "known" } }),
  });
  const ok = await scanner.run(["x"], { before: after });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, ["inspect:x", "evidence:x", "restore:4", "commit:x", "reevaluate:x"]);
  assert.equal(ok.plan.recommended.slot, "known");

  after = { scene: "board", resources: { energy: 9 }, board: { signature: "changed" } };
  const unsafe = await scanner.run(["x"], { before: { scene: "board", resources: { energy: 10 }, board: { signature: "same" } } });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.reason, "active-catalog-scan-safety-verification-failed");
  assert.equal(calls.filter((entry) => entry.startsWith("commit:")).length, 1);

  after = { scene: "board", resources: { energy: 10 }, board: { signature: "same" } };
  scanner.collectEvidence = async () => null;
  const noEvidence = await scanner.run(["x"], { before: after });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.reason, "active-catalog-scan-no-evidence");
  assert.equal(calls.filter((entry) => entry.startsWith("commit:")).length, 1);
});

test("active scan CDP expressions are atomic and reject producer selection", () => {
  const inspect = buildActiveCatalogInspectExpression(3);
  const restore = buildRestoreCatalogSelectionExpression(null);
  assert.match(inspect, /scan-producer-selection-unsafe/);
  assert.match(inspect, /grids\[3\]/);
  assert.doesNotMatch(inspect, /setTimeout|setInterval|while\s*\(/);
  assert.match(restore, /scan-selection-restore-unsupported/);
  assert.match(restore, /scan-producer-selection-restore-unsafe/);
  assert.doesNotMatch(restore, /setTimeout|setInterval|while\s*\(/);
});
