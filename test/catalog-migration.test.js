"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");
const { migrateLegacyCatalog, buildMigratedPlanningCatalog } = require("../src/catalog-migration");
const { buildOptimizationPlan } = require("../src/order-optimizer");

function fixtureCatalog() {
  return {
    rules: { mergeArity: 2, levelRule: "2 × level n -> 1 × level n+1" },
    coverage: { completeChains: ["c"], incompleteChains: [] },
    chains: [{ id: "c", minLevel: 1, maxLevel: 2, observedMaxLevel: 2, complete: true, itemIds: ["i1", "i2"], sourceFiles: ["capture.json"] }],
    items: [
      { id: "i1", chainId: "c", level: 1, baseUnits: 1, mergeTarget: "i2", iconResource: "leaf/icon_1", createData: ["i1", "i2", "i1"] },
      { id: "i2", chainId: "c", level: 2, baseUnits: 2, mergeTarget: null, iconResource: "leaf/icon_2", inferred: true, inferenceBasis: { type: "continuous-id", fromItemId: "i1" } },
    ],
    producers: [{ itemId: "i1", chainId: "c", level: 1, energyCost: 1, sampleSize: 3, drops: [
      { itemId: "i1", count: 2, probability: 2 / 3, chainId: "c", level: 1, baseUnits: 1 },
      { itemId: "i2", count: 1, probability: 1 / 3, chainId: "c", level: 2, baseUnits: 2 },
    ] }],
  };
}

test("旧图鉴按结构配置和推断来源分别迁移为 Active 与 Provisional", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-migration-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try {
    const result = migrateLegacyCatalog(database, fixtureCatalog(), {
      sourceFile: "catalog.json",
      historicActions: [
        { id: "action-1", producerItemId: "i1", outputItemId: "i2", attributable: true },
        { id: "action-2", producerItemId: "i1", outputItemId: "i1", attributable: false },
      ],
    });

    assert.equal(result.conflicts, 0);
    const structuredIdentity = database.getCatalogObject("item-identity", "i1");
    const inferredIdentity = database.getCatalogObject("item-identity", "i2");
    assert.equal(structuredIdentity.status, "active");
    assert.equal(inferredIdentity.status, "provisional");
    assert.deepEqual(inferredIdentity.candidateVersion.payload.inferenceBasis, { type: "continuous-id", fromItemId: "i1" });
    assert.equal(structuredIdentity.activeVersion.payload.iconResourceIdentifier, "leaf/icon_1");
    assert.equal(structuredIdentity.activeVersion.payload.iconEvidenceStatus, "missing");

    const relation = database.getCatalogObject("merge-relation", "i1");
    assert.equal(relation.status, "active");
    assert.equal(relation.activeVersion.payload.mergeTarget, "i2");

    const profile = database.getCatalogObject("production-profile", "i1");
    assert.equal(profile.status, "active");
    assert.equal(profile.activeVersion.payload.theoreticalDistribution.source, "CreateData");
    assert.equal(profile.activeVersion.payload.theoreticalDistribution.sampleSpaceSize, 3);
    assert.equal(profile.activeVersion.payload.observedDistribution.sampleSize, 1);
    assert.deepEqual(profile.activeVersion.payload.observedDistribution.outcomes, [{ itemId: "i2", count: 1, probability: 1 }]);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移异常记入冲突且不阻断其他条目", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-migration-conflict-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try {
    const catalog = fixtureCatalog();
    catalog.items.push({ id: "broken", chainId: "missing-chain", level: 0, mergeTarget: "unknown" });
    catalog.producers.push({ itemId: "i2", chainId: "c", level: 2, energyCost: 1, sampleSize: 2, drops: [{ itemId: "unknown", count: 1, probability: 0.5 }] });
    const result = migrateLegacyCatalog(database, catalog, { sourceFile: "catalog.json" });
    assert.ok(result.conflicts >= 1);
    assert.equal(database.getCatalogObject("item-identity", "i1").status, "active");
    const conflicts = database.listCatalogConflicts();
    assert.ok(conflicts.some((conflict) => conflict.objectId === "broken" && conflict.status === "open"));
    assert.ok(conflicts.some((conflict) => conflict.objectType === "production-profile" && conflict.objectId === "i2" && conflict.details.reasons.includes("drop-probability-sum-mismatch")));
    assert.equal(database.getCatalogObject("production-profile", "i2").status, "provisional");
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移可重入且不覆盖已有人工生效版本", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-migration-idempotent-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try {
    const observed = database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1" }, sourceType: "manual" });
    database.saveCatalogVersion({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1", displayName: "Human name" }, status: "active", expectedRevision: observed.revision });
    migrateLegacyCatalog(database, fixtureCatalog(), { sourceFile: "catalog.json" });
    const afterFirst = database.getCatalogObject("item-identity", "i2");
    const versionsAfterFirst = database.getCatalogRepositorySummary().versions;
    migrateLegacyCatalog(database, fixtureCatalog(), { sourceFile: "catalog.json" });
    const afterSecond = database.getCatalogObject("item-identity", "i2");

    assert.equal(afterSecond.revision, afterFirst.revision);
    assert.equal(database.getCatalogRepositorySummary().versions, versionsAfterFirst);
    assert.equal(database.getCatalogObject("item-identity", "i1").activeVersion.payload.displayName, "Human name");
    const humanConflict = database.listCatalogConflicts().find((conflict) => conflict.objectId === "i1" && conflict.conflictType === "migration-existing-version");
    assert.equal(humanConflict.occurrenceCount, 1);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移前后 JSON 规划知识覆盖和订单结果保持一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-migration-planning-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  const catalog = fixtureCatalog();
  const state = {
    schemaVersion: 1,
    resources: { energy: 10 },
    board: { grids: [{ index: 1, itemId: "i1", normal: true, moveable: true }], mergeCandidates: [] },
    orders: [{ slot: "o", rewardCoins: 10, items: [{ itemId: "i2", complete: false }] }],
  };
  try {
    const before = buildOptimizationPlan({ catalog, state });
    migrateLegacyCatalog(database, catalog, { sourceFile: "catalog.json" });
    const migratedCatalog = buildMigratedPlanningCatalog(database, catalog);
    const after = buildOptimizationPlan({ catalog: migratedCatalog, state });
    assert.equal(after.recommended.slot, before.recommended.slot);
    assert.equal(after.recommended.estimatedEnergy, before.recommended.estimatedEnergy);
    assert.deepEqual(after.catalogCoverage, before.catalogCoverage);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("数据库中可明确归因的历史产出动作可在后续迁移中累计", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-migration-actions-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try {
    migrateLegacyCatalog(database, fixtureCatalog(), { sourceFile: "catalog.json" });
    database.logAction({ type: "produce", ok: true, details: { producerItemId: "i1", outputItemId: "i2" } });
    database.logAction({ type: "produce", ok: true, details: { producerItemId: "i1" } });
    migrateLegacyCatalog(database, fixtureCatalog(), {
      sourceFile: "catalog.json",
      historicActions: database.listAttributableProductionActions(),
    });
    const profile = database.getCatalogObject("production-profile", "i1");
    assert.equal(profile.activeVersion.payload.observedDistribution.sampleSize, 1);
    assert.deepEqual(profile.activeVersion.payload.observedDistribution.outcomes, [{ itemId: "i2", count: 1, probability: 1 }]);
    database.logAction({ type: "produce", ok: true, details: { producerItemId: "i1", outputItemId: "i1" } });
    migrateLegacyCatalog(database, fixtureCatalog(), {
      sourceFile: "catalog.json",
      historicActions: database.listAttributableProductionActions(),
    });
    const updatedProfile = database.getCatalogObject("production-profile", "i1");
    assert.equal(updatedProfile.activeVersion.payload.observedDistribution.sampleSize, 2);
    assert.deepEqual(updatedProfile.activeVersion.payload.observedDistribution.outcomes, [
      { itemId: "i2", count: 1, probability: 0.5 },
      { itemId: "i1", count: 1, probability: 0.5 },
    ]);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移后创建的人工版本不会被后续变更的旧图鉴覆盖", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-migration-human-after-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try {
    const catalog = fixtureCatalog();
    migrateLegacyCatalog(database, catalog, { sourceFile: "catalog.json" });
    const migrated = database.getCatalogObject("item-identity", "i1");
    database.saveCatalogVersion({
      objectType: "item-identity", objectId: "i1", status: "active", expectedRevision: migrated.revision,
      payload: { ...migrated.activeVersion.payload, displayName: "Human after migration" },
    });
    catalog.items[0].descriptionKey = "changed_legacy_description";
    migrateLegacyCatalog(database, catalog, { sourceFile: "catalog.json" });
    const after = database.getCatalogObject("item-identity", "i1");
    assert.equal(after.activeVersion.origin, "user");
    assert.equal(after.activeVersion.payload.displayName, "Human after migration");
    assert.ok(database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1" && conflict.conflictType === "migration-existing-version"));
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移内部异常时整个 Catalog Repository 事务回滚", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-migration-atomic-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  const originalSave = database.saveCatalogVersion.bind(database);
  let saves = 0;
  database.saveCatalogVersion = (input) => {
    saves += 1;
    if (saves === 2) throw new Error("migration fixture failure");
    return originalSave(input);
  };
  try {
    assert.throws(() => migrateLegacyCatalog(database, fixtureCatalog(), { sourceFile: "catalog.json" }), /migration fixture failure/);
    assert.deepEqual(database.listCatalogObjects(), []);
    assert.deepEqual(database.listCatalogConflicts(), []);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
