"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationRuntime } = require("../src/automation-runtime");
const { AutomationDatabase } = require("../src/automation-database");

function persistedCatalogFixture() {
  return {
    rules: {}, coverage: { completeChains: ["c"], incompleteChains: [] },
    chains: [{ id: "c", complete: true, minLevel: 1, maxLevel: 2, itemIds: ["i1", "i2"] }],
    items: [
      { id: "i1", chainId: "c", level: 1, baseUnits: 1, mergeTarget: "i2", iconResource: "leaf/1" },
      { id: "i2", chainId: "c", level: 2, baseUnits: 2, mergeTarget: null, iconResource: "leaf/2" },
    ],
    producers: [{ itemId: "i1", chainId: "c", level: 1, energyCost: 1, sampleSize: 2, drops: [
      { itemId: "i1", count: 1, probability: 0.5 }, { itemId: "i2", count: 1, probability: 0.5 },
    ] }],
  };
}

test("CDP WebSocket关闭时仪表盘返回可渲染的重连状态而不是导致控制请求失败", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-disconnected-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir });
  let starts = 0;
  backend.collectState = async () => { throw new Error("CDP WebSocket closed"); };
  backend.connectionService.status = async () => ({ listening: false, starting: false, managed: false, cdpPort: 62000 });
  backend.connectionService.start = async () => { starts += 1; return { ok: true, reason: "route-started" }; };
  const dashboard = await backend.dashboard();
  assert.equal(dashboard.connected, false);
  assert.equal(dashboard.connectionError, "CDP WebSocket closed");
  assert.equal(dashboard.state.schemaVersion, 1);
  assert.ok(dashboard.catalogView.repository.summary.objects > 0);
  assert.equal(dashboard.catalogView.repository.objects, undefined);
  assert.equal(starts, 1);
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("字体缩放默认加大并持久化在允许范围内", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-font-scale-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir });
  assert.equal(backend.getSettings().fontScale, 1.1);
  assert.equal(backend.saveSettings({ fontScale: 1.3 }).fontScale, 1.3);
  assert.equal(backend.saveSettings({ fontScale: 9 }).fontScale, 1.4);
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("运行时刷新后重启不把持久化 JSON 投影重复记为新证据", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-catalog-restart-"));
  let backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const scannedObject = backend.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const scannedPayload = backend.database.getCatalogObject(scannedObject.objectType, scannedObject.objectId).algorithmCandidate;
  backend.database.observeCatalogObject({ objectType: scannedObject.objectType, objectId: scannedObject.objectId, payload: scannedPayload, sourceRef: path.join(dataDir, "catalog-captures", "capture-1.json"), sourceType: "runtime-capture", countDuplicate: false });
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify({ chains: [], items: [], producers: [] }), "utf8");
  const beforeSummary = backend.database.getCatalogRepositorySummary();
  const beforeObject = backend.database.listCatalogObjects()[0];
  backend.database.close();

  backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const afterSummary = backend.database.getCatalogRepositorySummary();
  const afterObject = backend.database.getCatalogObject(beforeObject.objectType, beforeObject.objectId);
  assert.deepEqual(afterSummary, beforeSummary);
  assert.equal(afterObject.revision, beforeObject.revision);
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Catalog Repository 写入失败时事务回滚且不写可变 JSON 真相", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-catalog-rollback-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const beforeCatalog = backend.exportCatalog();
  const persistedPath = path.join(dataDir, "item-catalog.json");
  backend.connect = async () => ({ probe: { context: { id: 1 } } });
  backend.lab = { snapshot: async () => ({ fixture: true }) };
  backend.buildCatalog = () => ({
    rules: {}, coverage: {}, chains: [{ id: "new-chain", complete: false }],
    items: [{ id: "new-item", chainId: "new-chain", level: 1 }], producers: [],
  });
  const originalImport = backend.database.importCatalog.bind(backend.database);
  backend.database.importCatalog = () => { throw new Error("catalog repository write failed"); };

  await assert.rejects(() => backend.refreshCatalogFromRuntime(), /catalog repository write failed/);
  assert.equal(backend.exportCatalog().source.revision, beforeCatalog.source.revision);
  assert.equal(fs.existsSync(persistedPath), false);

  backend.database.importCatalog = originalImport;
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("升级工作区已有部分 Repository 对象时仍补齐持久化旧图鉴", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-catalog-partial-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(persistedCatalogFixture()), "utf8");
  const database = new AutomationDatabase(path.join(dataDir, "automation.db"));
  const observed = database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1" }, sourceType: "manual" });
  database.saveCatalogVersion({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1", displayName: "Human" }, status: "active", expectedRevision: observed.revision });
  database.close();

  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  assert.equal(backend.database.getCatalogObject("item-identity", "i1").activeVersion.payload.displayName, "Human");
  assert.equal(backend.database.getCatalogObject("item-identity", "i2").status, "active");
  assert.equal(backend.database.getCatalogObject("merge-relation", "i2").status, "active");
  assert.equal(backend.database.getCatalogObject("production-profile", "i1").status, "active");
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("运行时迁移入口仅导入数据库中可明确归因的历史产出", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-catalog-actions-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(persistedCatalogFixture()), "utf8");
  const database = new AutomationDatabase(path.join(dataDir, "automation.db"));
  database.logAction({ type: "produce", ok: true, details: { producerItemId: "i1", outputItemId: "i2" } });
  database.logAction({ type: "produce", ok: true, details: { producerItemId: "i1" } });
  database.close();

  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const profile = backend.database.getCatalogObject("production-profile", "i1").activeVersion.payload;
  assert.equal(profile.observedDistribution.sampleSize, 1);
  assert.deepEqual(profile.observedDistribution.outcomes, [{ count: 1, itemId: "i2", probability: 1 }]);
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Runtime Catalog Review Gate 独立降级关系对象并隔离真实规划", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-catalog-gate-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(persistedCatalogFixture()), "utf8");
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  backend.database.observeCatalogObject({
    objectType: "merge-relation", objectId: "i1",
    payload: { itemId: "i1", chainId: "c", level: 1, mergeTarget: "i2" },
    sourceType: "structural-inference", sourceRef: "rule-1", countDuplicate: false,
  });
  const relation = backend.database.getCatalogObject("merge-relation", "i1");
  const legacyEvidence = relation.evidence.find((evidence) => evidence.sourceType === "legacy-migration");
  backend.setCatalogEvidenceDisposition("merge-relation", "i1", legacyEvidence.id, "rejected", "structured-source-withdrawn", relation.revision);

  assert.equal(backend.database.getCatalogObject("item-identity", "i1").status, "active");
  assert.equal(backend.database.getCatalogObject("merge-relation", "i1").status, "provisional");
  assert.equal(backend.getPlanningCatalog().items.some((item) => item.id === "i1"), false);
  assert.equal(backend.getPlanningCatalog({ includeProvisional: true }).items.some((item) => item.id === "i1"), true);
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
