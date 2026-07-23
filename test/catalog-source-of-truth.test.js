"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");
const { AutomationRuntime } = require("../src/automation-runtime");
const { migrateLegacyCatalog } = require("../src/catalog-migration");

function catalogFixture() {
  return {
    rules: {}, coverage: { completeChains: ["c"], incompleteChains: [] },
    chains: [{ id: "c", complete: true, minLevel: 1, maxLevel: 2, itemIds: ["i1", "i2"] }],
    items: [
      { id: "i1", chainId: "c", level: 1, baseUnits: 1, mergeTarget: "i2", iconResource: "leaf/1" },
      { id: "i2", chainId: "c", level: 2, baseUnits: 2, mergeTarget: null, iconResource: "leaf/2" },
    ],
    producers: [{ itemId: "i1", chainId: "c", level: 1, energyCost: 1, sampleSize: 1, drops: [{ itemId: "i1", count: 1, probability: 1 }] }],
  };
}

function withDatabase(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-truth-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try { return run(database, dir); }
  finally { database.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("SQLite 投影独立生成规划图鉴且 revision 随 Repository 变化", () => withDatabase((database) => {
  migrateLegacyCatalog(database, catalogFixture(), { sourceFile: "fixture.json" });
  const first = database.getCatalogProjection();
  assert.deepEqual(first.items.map((item) => item.id), ["i1", "i2"]);
  assert.deepEqual(first.producers.map((producer) => producer.itemId), ["i1"]);
  assert.equal(first.chains[0].id, "c");
  assert.match(first.revision, /^[a-f0-9]{64}$/);

  const identity = database.getCatalogObject("item-identity", "i1");
  database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "level", decision: "modify", value: 3, actor: "tester", note: "verify revision", expectedRevision: identity.revision, baseRulingId: null });
  const second = database.getCatalogProjection();
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.items.find((item) => item.id === "i1").level, 3);
}));

test("SQLite 投影优先使用已存储的 Planning Production Distribution", () => withDatabase((database) => {
  migrateLegacyCatalog(database, catalogFixture(), { sourceFile: "fixture.json" });
  const profile = database.getCatalogObject("production-profile", "i1");
  database.applyCatalogRuling({
    objectType: "production-profile", objectId: "i1", fieldPath: "planningDistribution", decision: "modify",
    value: { sampleSize: 1, outcomes: [{ itemId: "i2", count: 1, probability: 1 }] },
    actor: "tester", note: "planning posterior fixture", expectedRevision: profile.revision, baseRulingId: null,
  });
  const producer = database.getCatalogProjection().producers[0];
  assert.deepEqual(producer.drops.map((drop) => [drop.itemId, drop.count, drop.probability]), [["i2", 1, 1]]);
}));

test("Catalog JSON 导出保留来源、活动版本和审核历史并可重建空数据库", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-export-"));
  const source = new AutomationDatabase(path.join(dir, "source.db"));
  const restored = new AutomationDatabase(path.join(dir, "restored.db"));
  try {
    migrateLegacyCatalog(source, catalogFixture(), { sourceFile: "fixture.json" });
    let object = source.getCatalogObject("item-identity", "i1");
    source.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "descriptionKey", decision: "modify", value: "manual-name", actor: "operator-a", note: "人工命名", expectedRevision: object.revision, baseRulingId: null });
    source.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: catalogFixture().items[0], sourceType: "legacy-migration", sourceRef: "fixture.json" });
    object = source.getCatalogObject("item-identity", "i1");
    source.setCatalogObjectDisposition("item-identity", "i1", "paused", { reason: "backup-fixture-pause", expectedRevision: object.revision });
    object = source.getCatalogObject("item-identity", "i1");
    source.setCatalogObjectDisposition("item-identity", "i1", "enabled", { reason: "backup-fixture-resume", expectedRevision: object.revision });
    source.recordCatalogConflict({ objectType: "item-identity", objectId: "i1", conflictType: "test-conflict", details: { reason: "fixture" }, countDuplicate: false });
    source.recordCatalogConflict({ objectType: "item-identity", objectId: "i1", conflictType: "test-conflict", details: { reason: "fixture" } });

    const exported = source.exportCatalogSnapshot();
    assert.equal(exported.schemaVersion, 1);
    assert.equal(exported.source.type, "sqlite-catalog-repository");
    assert.equal(exported.projection.revision, source.getCatalogProjection().revision);
    const exportedIdentity = exported.objects.find((item) => item.objectType === "item-identity" && item.objectId === "i1");
    assert.equal(exportedIdentity.activeVersion.status, "active");
    assert.equal(exportedIdentity.evidence[0].sourceType, "legacy-migration");
    assert.equal(exportedIdentity.rulingHistory.at(-1).actor, "operator-a");

    restored.importCatalogSnapshot(exported, { sourceFile: "backup.json" });
    const rebuilt = restored.getCatalogObject("item-identity", "i1");
    assert.equal(restored.getCatalogRevision(), exported.source.revision);
    assert.equal(rebuilt.status, "active");
    assert.equal(rebuilt.effectiveValue.descriptionKey, "manual-name");
    assert.equal(rebuilt.versions.length, exportedIdentity.versions.length);
    const withoutId = ({ id, ...value }) => value;
    assert.deepEqual(rebuilt.evidence.map(withoutId), exportedIdentity.evidence.map(withoutId));
    assert.deepEqual(rebuilt.versions.map(withoutId), exportedIdentity.versions.map(withoutId));
    assert.deepEqual(rebuilt.transitions.map(withoutId), exportedIdentity.transitions.map(withoutId));
    assert.deepEqual(rebuilt.rulingHistory.map(withoutId), exportedIdentity.rulingHistory.map(withoutId));
    assert.deepEqual(restored.listCatalogConflicts().map(withoutId), exported.conflicts.map(withoutId));
    assert.equal(restored.getCatalogProjection().items.length, 2);
  } finally {
    source.close(); restored.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Catalog JSON 导入只补充证据而不覆盖较新的人工裁决", () => withDatabase((database) => {
  migrateLegacyCatalog(database, catalogFixture(), { sourceFile: "fixture.json" });
  let object = database.getCatalogObject("item-identity", "i1");
  database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "level", decision: "modify", value: 7, actor: "operator", note: "newer", expectedRevision: object.revision, baseRulingId: null });
  const backup = database.exportCatalogSnapshot();
  backup.objects.find((item) => item.objectType === "item-identity" && item.objectId === "i1").algorithmCandidate.level = 2;

  database.importCatalogSnapshot(backup, { sourceFile: "older-backup.json" });
  object = database.getCatalogObject("item-identity", "i1");
  assert.equal(object.effectiveValue.level, 7);
  assert.equal(object.humanValues.level.actor, "operator");
}));

test("非空 Repository 导入按 fingerprint 保留同类冲突的独立状态", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-conflict-restore-"));
  const source = new AutomationDatabase(path.join(dir, "source.db"));
  const target = new AutomationDatabase(path.join(dir, "target.db"));
  try {
    migrateLegacyCatalog(source, catalogFixture(), { sourceFile: "fixture.json" });
    source.recordCatalogConflict({ objectType: "item-identity", objectId: "i1", conflictType: "same-type", details: { variant: "open" }, countDuplicate: false });
    const resolved = source.recordCatalogConflict({ objectType: "item-identity", objectId: "i1", conflictType: "same-type", details: { variant: "resolved" }, countDuplicate: false });
    source.resolveCatalogConflictFingerprint("item-identity", "i1", "same-type", resolved.fingerprint);
    target.observeCatalogObject({ objectType: "item-identity", objectId: "existing", payload: { itemId: "existing" }, sourceType: "runtime" });

    target.importCatalogSnapshot(source.exportCatalogSnapshot(), { sourceFile: "mixed.json" });
    const conflicts = target.listCatalogConflicts({ status: null }).filter((conflict) => conflict.conflictType === "same-type");
    assert.deepEqual(conflicts.map((conflict) => [conflict.details.variant, conflict.status]).sort(), [["open", "open"], ["resolved", "resolved"]]);
  } finally {
    source.close(); target.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("后续 legacy JSON 导入不覆盖已有 Active 版本", () => withDatabase((database) => {
  const original = catalogFixture();
  migrateLegacyCatalog(database, original, { sourceFile: "first.json" });
  const activeBefore = database.getCatalogObject("item-identity", "i1").activeVersion;
  const changed = catalogFixture();
  changed.items[0] = { ...changed.items[0], descriptionKey: "older-import-change" };
  migrateLegacyCatalog(database, changed, { sourceFile: "later.json" });
  const after = database.getCatalogObject("item-identity", "i1");
  assert.equal(after.activeVersion.id, activeBefore.id);
  assert.equal(after.activeVersion.payload.descriptionKey, null);
  assert.equal(database.listCatalogConflicts().some((conflict) => conflict.conflictType === "migration-existing-version"), true);
}));

test("运行时迁移后只从 SQLite 读取，刷新不再覆盖可变 JSON", async () => {
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-sqlite-truth-"));
  const legacyPath = path.join(dataDir, "item-catalog.json");
  fs.writeFileSync(legacyPath, JSON.stringify(catalogFixture()), "utf8");
  const backend = new AutomationRuntime({ rootDir, dataDir, manageConnectionRoute: false });
  try {
    const originalJson = fs.readFileSync(legacyPath, "utf8");
    fs.writeFileSync(legacyPath, JSON.stringify({ chains: [], items: [], producers: [] }), "utf8");
    assert.deepEqual(backend.getPlanningCatalog().items.map((item) => item.id), ["i1", "i2"]);
    assert.equal(backend.getCatalogView().revision, backend.getPlanningCatalog().revision);

    backend.connect = async () => ({ probe: { context: { id: 1 } } });
    backend.lab = { snapshot: async () => ({ fixture: true, focusedControllers: { selectedItem: { itemId: "n1" } } }) };
    backend.buildCatalog = () => ({ rules: {}, coverage: {}, chains: [{ id: "n", complete: true }], items: [{ id: "n1", chainId: "n", level: 1, baseUnits: 1, mergeTarget: null }], producers: [] });
    const refreshed = await backend.refreshCatalogFromRuntime();
    assert.equal(refreshed.ok, true);
    assert.equal(backend.getCatalogView().items.some((item) => item.id === "n1"), true);
    assert.notEqual(fs.readFileSync(legacyPath, "utf8"), originalJson);
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath, "utf8")), { chains: [], items: [], producers: [] });
  } finally {
    await backend.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("状态栏扫描在游戏未选中物品时返回可操作的前置条件错误", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-selection-required-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  try {
    backend.connect = async () => ({ probe: { context: { id: 1 } } });
    backend.lab = { snapshot: async () => ({
      focusedControllers: { selectedItem: null },
      gameplayState: { selectedItemUi: { selected: false, emptyContainerActive: true, prompt: "点击选中物品后查看详情" } },
    }) };
    backend.buildCatalog = () => ({ chains: [], items: [], producers: [] });

    const result = await backend.captureCatalogFromRuntime();

    assert.equal(result.ok, false);
    assert.equal(result.reason, "catalog-scan-selection-required");
    assert.match(result.captureFile, /^catalog-rescan-/);
  } finally {
    await backend.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("首次迁移失败返回明确错误且修复输入后可重试", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-migration-retry-"));
  fs.mkdirSync(path.join(root, "captures"));
  fs.writeFileSync(path.join(root, "captures", "item-catalog.json"), "{broken", "utf8");
  const dataDir = path.join(root, "data");
  assert.throws(() => new AutomationRuntime({ rootDir: root, dataDir, manageConnectionRoute: false }), (error) => error.code === "CATALOG_MIGRATION_FAILED");
  fs.writeFileSync(path.join(root, "captures", "item-catalog.json"), JSON.stringify(catalogFixture()), "utf8");
  const backend = new AutomationRuntime({ rootDir: root, dataDir, manageConnectionRoute: false });
  try {
    assert.equal(backend.getCatalogView().items.length, 2);
    assert.equal(backend.database.getSetting("catalog-system-of-record-migration").schemaVersion, 1);
  } finally {
    backend.database.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("空 Catalog 迁移不记录成功标记并可在修复后重试", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-empty-migration-retry-"));
  fs.mkdirSync(path.join(root, "captures"));
  fs.writeFileSync(path.join(root, "captures", "item-catalog.json"), JSON.stringify({ chains: [], items: [], producers: [] }), "utf8");
  const dataDir = path.join(root, "data");
  assert.throws(() => new AutomationRuntime({ rootDir: root, dataDir, manageConnectionRoute: false }), (error) => error.code === "CATALOG_REPOSITORY_EMPTY");
  const database = new AutomationDatabase(path.join(dataDir, "automation.db"));
  assert.equal(database.getSetting("catalog-system-of-record-migration"), null);
  database.close();
  fs.writeFileSync(path.join(root, "captures", "item-catalog.json"), JSON.stringify(catalogFixture()), "utf8");
  const backend = new AutomationRuntime({ rootDir: root, dataDir, manageConnectionRoute: false });
  try { assert.equal(backend.getCatalogView().items.length, 2); }
  finally { backend.database.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("baseUnits 与等级不一致的结构化条目不会迁移为 Active", () => withDatabase((database) => {
  const invalid = catalogFixture();
  invalid.items[0] = { ...invalid.items[0], baseUnits: "bad" };
  migrateLegacyCatalog(database, invalid, { sourceFile: "invalid.json" });
  const object = database.getCatalogObject("item-identity", "i1");
  assert.equal(object.status, "observed");
  assert.equal(database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1" && conflict.details.reasons.includes("invalid-base-units")), true);
}));

test("数据库不可用时返回明确 Catalog 错误而不退回 JSON", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-db-unavailable-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "automation.db"), { recursive: true });
  assert.throws(() => new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false }), (error) => {
    assert.equal(error.code, "CATALOG_DATABASE_UNAVAILABLE");
    assert.match(error.message, /catalog database unavailable/);
    return true;
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("诊断包包含 SQLite 图鉴摘要、活动版本和审核历史导出", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-catalog-diagnostic-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const target = path.join(dataDir, "diagnostic.zip");
  backend.collectState = async () => ({ fixture: true });
  try {
    await backend.exportDiagnostic(target);
    const zip = fs.readFileSync(target).toString("latin1");
    assert.match(zip, /diagnostic\.json/);
    assert.match(zip, /catalog-repository\.json/);
    assert.match(zip, /item-catalog\.json/);
    const snapshot = backend.exportCatalog();
    assert.equal(snapshot.objects.some((object) => object.activeVersion), true);
    assert.equal(Array.isArray(snapshot.objects[0].rulingHistory), true);
  } finally {
    await backend.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
