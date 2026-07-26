"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");
const { CatalogReviewGate, buildPlanningCatalogFromRepository } = require("../src/catalog-review-gate");

function withDatabase(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-gate-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try { return run(database); }
  finally { database.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

function observe(database, objectType, objectId, payload, sourceType) {
  database.observeCatalogObject({ objectType, objectId, payload, sourceType, sourceRef: `${sourceType}.json`, countDuplicate: false });
}

test("Catalog Review Gate 按对象类型独立计算证据状态", () => withDatabase((database) => {
  observe(database, "item-identity", "i1", { id: "i1", chainId: "c", level: 1, iconResource: "leaf/1" }, "runtime-capture");
  observe(database, "merge-relation", "i1", { itemId: "i1", chainId: "c", level: 1, mergeTarget: "i2" }, "structural-inference");
  observe(database, "production-profile", "i1", { itemId: "i1", energyCost: 1 }, "visual-evidence");
  const gate = new CatalogReviewGate(database);

  const results = gate.evaluateAll();

  assert.deepEqual(results.map((result) => [result.objectType, result.status]), [
    ["item-identity", "active"],
    ["merge-relation", "provisional"],
    ["production-profile", "active"],
  ]);
  assert.match(database.getCatalogObject("item-identity", "i1").latestTransition.reason, /structured-runtime-consistent/);
  assert.match(database.getCatalogObject("merge-relation", "i1").latestTransition.reason, /provisional-only-source/);
}));

test("Production Profile 从旧配置只提取归属集合并与产出分布独立晋级", () => withDatabase((database) => {
  observe(database, "item-identity", "p", { id: "p", chainId: "producer", level: 1 }, "runtime-capture");
  observe(database, "item-identity", "d", { id: "d", chainId: "drop", level: 1 }, "runtime-capture");
  observe(database, "production-profile", "p", {
    itemId: "p", energyCost: 1, sampleSize: 2,
    drops: [{ itemId: "d", count: 1, probability: 0.5 }],
  }, "runtime-capture");
  const gate = new CatalogReviewGate(database);
  gate.evaluateAll();

  const profile = database.getCatalogObject("production-profile", "p");
  assert.equal(profile.status, "active");
  assert.deepEqual(profile.activeVersion.payload, {
    producerItemId: "p",
    candidateOutputs: ["d"],
    productionModes: [],
  });
  assert.equal(Object.hasOwn(profile.activeVersion.payload, "energyCost"), false);
  assert.equal(Object.hasOwn(profile.activeVersion.payload, "theoreticalDistribution"), false);
  assert.equal(profile.latestTransition.evidenceRevision >= 1, true);
  assert.ok(profile.latestTransition.createdAt);
}));

test("新的结构化证据会生成可解释的新生效版本", () => withDatabase((database) => {
  observe(database, "item-identity", "i1", { id: "i1", chainId: "c", level: 1 }, "runtime-capture");
  const gate = new CatalogReviewGate(database);
  gate.evaluateAll();
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { id: "i1", chainId: "c", level: 2 }, sourceType: "runtime-capture", sourceRef: "new-capture.json", countDuplicate: false });
  gate.evaluateObject("item-identity", "i1");
  const object = database.getCatalogObject("item-identity", "i1");
  assert.equal(object.activeVersion.payload.level, 2);
  assert.equal(object.latestTransition.reason, "structured-runtime-consistent:item-identity");
  assert.equal(object.activeVersion.origin, "inference-gate");
}));

test("格式无效的结构推断或视觉证据不会进入 Provisional", () => withDatabase((database) => {
  observe(database, "item-identity", "bad-item", { id: "bad-item", chainId: null, level: 0 }, "visual-evidence");
  observe(database, "merge-relation", "bad-relation", { itemId: "", chainId: null, level: 0 }, "structural-inference");
  observe(database, "production-profile", "bad-profile", { itemId: "other-profile", energyCost: 1, sampleSize: 2, drops: [{ itemId: "x", count: 1, probability: 0.2 }] }, "visual-evidence");
  const gate = new CatalogReviewGate(database);
  gate.evaluateAll();
  assert.equal(database.getCatalogObject("item-identity", "bad-item").status, "observed");
  assert.equal(database.getCatalogObject("merge-relation", "bad-relation").status, "observed");
  assert.equal(database.getCatalogObject("production-profile", "bad-profile").status, "observed");
}));

test("证据载荷标识必须匹配 Repository 对象且畸形分布不会使 Gate 崩溃", () => withDatabase((database) => {
  observe(database, "item-identity", "identity-key", { id: "other", chainId: "c", level: 1 }, "runtime-capture");
  observe(database, "item-identity", "bad-units", { id: "bad-units", chainId: "c", level: 3, baseUnits: -5 }, "runtime-capture");
  observe(database, "merge-relation", "relation-key", { itemId: "other", chainId: "c", level: 1, mergeTarget: null }, "runtime-capture");
  observe(database, "production-profile", "profile-key", { producerItemId: "other", energyCost: 1, theoreticalDistribution: { sampleSpaceSize: 1, outcomes: {} } }, "runtime-capture");
  const gate = new CatalogReviewGate(database);
  assert.doesNotThrow(() => gate.evaluateAll());
  assert.equal(database.getCatalogObject("item-identity", "identity-key").status, "observed");
  assert.equal(database.getCatalogObject("item-identity", "bad-units").status, "observed");
  assert.equal(database.getCatalogObject("merge-relation", "relation-key").status, "observed");
  const profile = database.getCatalogObject("production-profile", "profile-key");
  assert.equal(profile.status, "observed");
  assert.match(profile.latestTransition.reason, /production-profile-identity-inconsistent/);
}));

test("Catalog Review Gate 只将 Active 字段交给真实规划，Provisional 仅进入预览", () => withDatabase((database) => {
  const legacy = {
    coverage: {}, chains: [{ id: "c", complete: false }],
    items: [{ id: "i1", chainId: "c", level: 1, baseUnits: 1, mergeTarget: null }], producers: [],
  };
  observe(database, "item-identity", "i1", { id: "i1", chainId: "c", level: 1, baseUnits: 1 }, "runtime-capture");
  observe(database, "merge-relation", "i1", { itemId: "i1", chainId: "c", level: 1, mergeTarget: null }, "structural-inference");
  const gate = new CatalogReviewGate(database);
  gate.evaluateAll();

  const active = buildPlanningCatalogFromRepository(database, legacy);
  const preview = buildPlanningCatalogFromRepository(database, legacy, { includeProvisional: true });
  assert.deepEqual(active.items, []);
  assert.deepEqual(preview.items.map((item) => item.id), ["i1"]);
}));

test("暂停、否决与证据降级会立即移出真实规划并留下转移原因", () => withDatabase((database) => {
  const legacy = {
    coverage: {}, chains: [{ id: "c", complete: true }],
    items: [{ id: "i1", chainId: "c", level: 1, baseUnits: 1, mergeTarget: null }], producers: [],
  };
  observe(database, "item-identity", "i1", { id: "i1", chainId: "c", level: 1, baseUnits: 1 }, "runtime-capture");
  observe(database, "merge-relation", "i1", { itemId: "i1", chainId: "c", level: 1, mergeTarget: null }, "runtime-capture");
  const gate = new CatalogReviewGate(database);
  gate.evaluateAll();
  assert.equal(buildPlanningCatalogFromRepository(database, legacy).items.length, 1);

  let identity = database.getCatalogObject("item-identity", "i1");
  gate.setObjectDisposition("item-identity", "i1", "paused", "operator-paused", identity.revision);
  assert.equal(buildPlanningCatalogFromRepository(database, legacy).items.length, 0);
  assert.throws(() => gate.setObjectDisposition("item-identity", "i1", "enabled", "stale-console", identity.revision), (error) => error.code === "CATALOG_REVISION_CONFLICT");
  identity = database.getCatalogObject("item-identity", "i1");
  gate.setObjectDisposition("item-identity", "i1", "enabled", "operator-resumed", identity.revision);
  identity = database.getCatalogObject("item-identity", "i1");
  const evidenceId = identity.evidence[0].id;
  gate.setEvidenceDisposition("item-identity", "i1", evidenceId, "rejected", "source-invalidated", identity.revision);
  const downgraded = database.getCatalogObject("item-identity", "i1");
  assert.equal(downgraded.status, "observed");
  assert.match(downgraded.latestTransition.reason, /no-eligible-evidence/);
  assert.equal(buildPlanningCatalogFromRepository(database, legacy).items.length, 0);
}));

test("产出结果身份被暂停后依赖它的 Active 产出配置不再进入真实规划", () => withDatabase((database) => {
  const legacy = {
    coverage: {}, chains: [{ id: "p", complete: true }, { id: "d", complete: true }],
    items: [
      { id: "producer", chainId: "p", level: 1, baseUnits: 1, mergeTarget: null },
      { id: "drop", chainId: "d", level: 1, baseUnits: 1, mergeTarget: null },
    ],
    producers: [{ itemId: "producer", energyCost: 1, drops: [{ itemId: "drop", count: 1, probability: 1 }] }],
  };
  for (const item of legacy.items) {
    observe(database, "item-identity", item.id, { id: item.id, chainId: item.chainId, level: 1, baseUnits: 1 }, "runtime-capture");
    observe(database, "merge-relation", item.id, { itemId: item.id, chainId: item.chainId, level: 1, mergeTarget: null }, "runtime-capture");
  }
  observe(database, "production-profile", "producer", { itemId: "producer", energyCost: 1, sampleSize: 1, drops: [{ itemId: "drop", count: 1, probability: 1 }] }, "runtime-capture");
  const gate = new CatalogReviewGate(database);
  gate.evaluateAll();
  assert.equal(buildPlanningCatalogFromRepository(database, legacy).producers.length, 1);
  const drop = database.getCatalogObject("item-identity", "drop");
  gate.setObjectDisposition("item-identity", "drop", "paused", "operator-paused", drop.revision);
  assert.equal(buildPlanningCatalogFromRepository(database, legacy).producers.length, 0);
}));

test("多级关系的末端失效时会迭代移除所有悬空的上游合成目标", () => withDatabase((database) => {
  const legacy = {
    coverage: {}, chains: [{ id: "c", complete: true }], producers: [],
    items: [
      { id: "a", chainId: "c", level: 1, baseUnits: 1, mergeTarget: "b" },
      { id: "b", chainId: "c", level: 2, baseUnits: 2, mergeTarget: "c" },
      { id: "c", chainId: "c", level: 3, baseUnits: 4, mergeTarget: null },
    ],
  };
  for (const item of legacy.items) {
    observe(database, "item-identity", item.id, { id: item.id, chainId: "c", level: item.level, baseUnits: item.baseUnits }, "runtime-capture");
    observe(database, "merge-relation", item.id, { itemId: item.id, chainId: "c", level: item.level, mergeTarget: item.mergeTarget }, "runtime-capture");
  }
  const gate = new CatalogReviewGate(database);
  gate.evaluateAll();
  const terminal = database.getCatalogObject("item-identity", "c");
  gate.setObjectDisposition("item-identity", "c", "paused", "terminal-paused", terminal.revision);
  assert.deepEqual(buildPlanningCatalogFromRepository(database, legacy).items, []);
}));

test("证据处置与 Gate 重评在同一事务中失败回滚", () => withDatabase((database) => {
  observe(database, "item-identity", "i1", { id: "i1", chainId: "c", level: 1 }, "runtime-capture");
  const gate = new CatalogReviewGate(database);
  gate.evaluateAll();
  const before = database.getCatalogObject("item-identity", "i1");
  const originalTransition = database.transitionCatalogObject.bind(database);
  database.transitionCatalogObject = () => { throw new Error("gate transition failed"); };
  assert.throws(() => gate.setEvidenceDisposition("item-identity", "i1", before.evidence[0].id, "rejected", "invalid", before.revision), /gate transition failed/);
  database.transitionCatalogObject = originalTransition;
  const after = database.getCatalogObject("item-identity", "i1");
  assert.equal(after.status, "active");
  assert.equal(after.evidence[0].disposition, "eligible");
  assert.equal(after.revision, before.revision);
}));

test("人工 Active 对象处置冲突证据后关闭冲突且不改人工版本", () => withDatabase((database) => {
  observe(database, "item-identity", "i1", { id: "i1", chainId: "c", level: 1, baseUnits: 1, descriptionKey: "runtime" }, "runtime-capture");
  const gate = new CatalogReviewGate(database);
  gate.evaluateObject("item-identity", "i1");
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "i1",
    payload: { id: "i1", chainId: "c", level: 2, baseUnits: 2, descriptionKey: "structured" },
    sourceType: "structured-runtime",
    sourceRef: "structured-runtime.json",
    countDuplicate: false,
  });
  const conflicted = gate.evaluateObject("item-identity", "i1");
  assert.equal(database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1" && conflict.conflictType === "evidence-conflict"), true);

  const humanPayload = { ...conflicted.algorithmCandidate, descriptionKey: "人工确认版本" };
  const human = database.completeCatalogReview({
    objectType: "item-identity",
    objectId: "i1",
    decision: "modify",
    payload: humanPayload,
    actor: "operator",
    note: "采用人工核对结果",
    expectedRevision: conflicted.revision,
  });
  const humanVersionId = human.activeVersion.id;
  const versionCount = human.versions.length;
  const rejectedEvidence = human.evidence.find((evidence) => evidence.sourceType === "runtime-capture");

  const resolved = gate.setEvidenceDisposition("item-identity", "i1", rejectedEvidence.id, "rejected", "人工确认另一证据", human.revision);

  assert.equal(database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1" && conflict.conflictType === "evidence-conflict"), false);
  assert.equal(resolved.status, "active");
  assert.equal(resolved.activeVersion.id, humanVersionId);
  assert.deepEqual(resolved.activeVersion.payload, humanPayload);
  assert.deepEqual(resolved.effectiveValue, humanPayload);
  assert.equal(resolved.versions.length, versionCount);
  assert.equal(resolved.evidence.find((evidence) => evidence.id === rejectedEvidence.id).disposition, "rejected");
}));
