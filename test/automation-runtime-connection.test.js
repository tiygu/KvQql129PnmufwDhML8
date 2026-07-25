"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationRuntime, buildOptimizationPlanInWorker } = require("../src/automation-runtime");
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

test("规划 Worker 不会因为动作间隔预算到期而中止", async () => {
  const plan = await buildOptimizationPlanInWorker({
    catalog: { rules: {}, chains: [], items: [], producers: [] },
    state: { schemaVersion: 1, resources: { energy: 10 }, board: { grids: [], mergeCandidates: [], empty: 4 }, orders: [] },
  }, { timeoutMs: 0 });

  assert.equal(plan.boundaryReason, "no-feasible-order");
});

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
  backend.lab = { snapshot: async () => ({ fixture: true, focusedControllers: { selectedItem: { itemId: "new-item" } } }) };
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

test("规划图鉴按仓库 revision 复用并在证据变化后立即失效", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-planning-cache-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  try {
    const first = backend.getPlanningCatalog({ executionMode: "automatic" });
    const second = backend.getPlanningCatalog({ executionMode: "automatic" });
    assert.strictEqual(second, first);
    backend.database.observeCatalogObject({
      objectType: "item-identity",
      objectId: "cache-invalidation-item",
      payload: { itemId: "cache-invalidation-item" },
      sourceType: "runtime",
    });
    const third = backend.getPlanningCatalog({ executionMode: "automatic" });
    assert.notStrictEqual(third, first);
    assert.notEqual(third.revision, first.revision);
  } finally {
    backend.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("仪表盘图鉴视图按仓库 revision 复用并在对象变化后失效", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-catalog-view-cache-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  try {
    const first = backend.getCatalogView({ includeRepositoryObjects: false });
    const second = backend.getCatalogView({ includeRepositoryObjects: false });
    assert.strictEqual(second, first);
    backend.database.observeCatalogObject({ objectType: "item-identity", objectId: "view-cache-item", payload: { itemId: "view-cache-item" }, sourceType: "runtime" });
    const third = backend.getCatalogView({ includeRepositoryObjects: false });
    assert.notStrictEqual(third, first);
    assert.notEqual(third.revision, first.revision);
  } finally {
    backend.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("完整图鉴视图忽略重复证据计数但在有效对象变化后失效", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-full-catalog-view-cache-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  try {
    const observation = { objectType: "item-identity", objectId: "full-view-cache-item", payload: { itemId: "full-view-cache-item", level: 1 }, sourceType: "runtime", sourceRef: "same-sample" };
    backend.database.observeCatalogObject(observation);
    const first = backend.getCatalogView();
    backend.database.observeCatalogObject(observation);
    const second = backend.getCatalogView();
    assert.strictEqual(second, first);
    backend.database.observeCatalogObject({ ...observation, objectId: "full-view-cache-item-2", payload: { itemId: "full-view-cache-item-2", level: 2 } });
    assert.notStrictEqual(backend.getCatalogView(), first);
  } finally {
    backend.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("暂时跳过由 Automation Runtime 恢复中部对象的后继焦点且不改变领域 revision 或规划", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-review-skip-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  try {
    for (const objectId of ["skip-first", "skip-middle", "skip-next"]) {
      backend.database.observeCatalogObject({
        objectType: "item-identity",
        objectId,
        payload: { itemId: objectId, chainId: "skip-chain", level: objectId === "skip-first" ? 1 : objectId === "skip-middle" ? 2 : 3 },
        sourceType: "runtime",
      });
      backend.catalogGate.evaluateObject("item-identity", objectId);
    }
    const initialQueue = backend.getCatalogView().repository.reviewQueue;
    const middleIndex = initialQueue.findIndex((entry) => entry.objectId === "skip-middle");
    assert.ok(middleIndex > 0 && middleIndex < initialQueue.length - 1);
    const expectedNext = initialQueue[middleIndex + 1];
    const middleBefore = backend.getCatalogObject("item-identity", "skip-middle");
    const planningBefore = backend.getPlanningCatalog();

    const skipped = backend.skipCatalogReview({ objectType: "item-identity", objectId: "skip-middle" });
    const refreshed = backend.getCatalogView();

    assert.equal(skipped.nextReviewTarget.objectId, expectedNext.objectId);
    assert.equal(refreshed.repository.reviewQueue.at(-1).objectId, "skip-middle");
    assert.equal(refreshed.repository.reviewQueue.at(-1).actionStatus, "已跳过");
    assert.deepEqual(refreshed.repository.reviewSession.skippedObjectKeys, ["item-identity:skip-middle"]);
    assert.equal(refreshed.repository.reviewSession.resumeObjectKey, `${expectedNext.objectType}:${expectedNext.objectId}`);
    assert.equal(refreshed.repository.reviewSession.commandRevision, 1);
    assert.strictEqual(backend.getCatalogView(), refreshed);
    assert.equal(backend.getCatalogObject("item-identity", "skip-middle").revision, middleBefore.revision);
    assert.strictEqual(backend.getPlanningCatalog(), planningBefore);
  } finally {
    backend.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("自动图标质量拒绝后进入退避而人工采集仍可立即重试", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-icon-backoff-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const item = backend.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const requests = [];
  backend.iconService.request = (itemId) => { requests.push(String(itemId)); return { itemId: String(itemId), status: "queued" }; };
  try {
    backend.iconEvidenceRetryAt.set(item.objectId, Date.now() + 300_000);
    const queued = backend.queueVisibleBoardIconEvidence({ board: { grids: [{ itemId: item.objectId }] } });
    assert.deepEqual(queued, []);
    backend.acquireCatalogIcon(item.objectId);
    assert.deepEqual(requests, [item.objectId]);
    assert.equal(backend.iconEvidenceRetryAt.has(item.objectId), false);
  } finally {
    backend.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("运行时重启会清除与资源提示冲突的通用自动图标并保留人工选择", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-generic-icon-"));
  const iconPath = path.join(dataDir, "generic-icon.png");
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(persistedCatalogFixture()), "utf8");
  fs.writeFileSync(iconPath, Buffer.from("same-generic-icon"));
  let backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const candidateAsset = {
    hash: "a".repeat(64),
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteSize: fs.statSync(iconPath).size,
    filePath: iconPath,
  };
  backend.database.saveIconCandidate({
    itemId: "i1",
    cacheKey: "generic-i1",
    sourceType: "cocos-runtime-resource",
    runtimeIdentifier: "icon",
    crop: { rect: { x: 0, y: 0, width: 1, height: 1 } },
    asset: candidateAsset,
  });
  const manualCandidate = backend.database.saveIconCandidate({
    itemId: "i2",
    cacheKey: "generic-i2",
    sourceType: "cocos-runtime-resource",
    runtimeIdentifier: "icon",
    crop: { rect: { x: 0, y: 0, width: 1, height: 1 } },
    asset: candidateAsset,
  });
  backend.database.selectIconCandidate("i2", manualCandidate.id, {
    actor: "operator",
    note: "verified",
    expectedRevision: backend.getCatalogObject("item-identity", "i2").revision,
  });
  backend.database.close();

  backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  try {
    assert.equal(backend.getCatalogObject("item-identity", "i1").selectedIcon, null);
    assert.equal(backend.getCatalogObject("item-identity", "i2").selectedIcon.id, manualCandidate.id);
    const queued = backend.queueVisibleBoardIconEvidence({
      board: { grids: [{ itemId: "i1" }, { itemId: "i2" }] },
    });
    assert.deepEqual(queued.map(({ itemId, status }) => ({ itemId, status })), [
      { itemId: "i1", status: "queued" },
    ]);
  } finally {
    backend.iconService.interruptForAutomation();
    await backend.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("dashboard polling reuses the runtime state while an automation action is active", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-dashboard-running-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  let collections = 0;
  backend.collectState = async () => { collections += 1; throw new Error("dashboard must not compete with action verification"); };
  backend.connectionService.status = async () => ({ listening: true, starting: false, managed: false, cdpPort: 62000 });
  backend.running = true;
  backend.lab = {};
  backend.selection = { probe: { context: { id: 1 } } };
  backend.lastState = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    scene: "board",
    resources: { coins: 0, diamonds: 0, energy: 10 },
    board: { available: true, visible: true, width: 1, height: 1, occupied: 0, empty: 1, signature: "empty-board", grids: [], requiredItemCounts: {} },
    warehouse: { inventoryKnowledge: { status: "unknown", slots: [], items: [], exchangeCapacity: 0 }, storeAvailability: { status: "unknown" } },
    orders: [],
    mapMission: { canComplete: false, requirements: [] },
  };
  backend.lastPlan = { status: "cached-running-plan", recommended: null, plans: [] };

  const dashboard = await backend.dashboard();

  assert.equal(collections, 0);
  assert.equal(dashboard.connected, true);
  assert.equal(dashboard.state, backend.lastState);
  assert.equal(dashboard.plan, backend.lastPlan);
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("active automation defers full-board catalog evidence instead of blocking every action", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-deferred-board-evidence-"));
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  const state = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    scene: "board",
    resources: { coins: 0, diamonds: 0, energy: 10 },
    board: { available: true, visible: true, width: 1, height: 1, occupied: 0, empty: 1, signature: "active-board", grids: [], requiredItemCounts: {} },
    warehouse: { inventoryKnowledge: { status: "unknown", slots: [], items: [], exchangeCapacity: 0 }, storeAvailability: { status: "unknown" } },
    orders: [],
    mapMission: { canComplete: false, requirements: [] },
  };
  backend.running = true;

  backend.queuePassiveCatalogEvidence({ state });
  backend.queuePassiveCatalogEvidence({ actionDiff: { type: "merge", itemId: "i1", expectedTarget: "i2", actualTarget: "i2", verified: true } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(backend.passiveCatalogDrainPromise, null);
  assert.equal(backend.passiveCatalogState, null);
  assert.equal(backend.deferredPassiveCatalogState, state);
  assert.equal(backend.passiveCatalogDiffs.length, 0);
  assert.equal(backend.deferredPassiveCatalogDiffs.length, 1);
  backend.running = false;
  backend.flushDeferredPassiveCatalogState();
  assert.ok(backend.passiveCatalogDrainPromise);
  await backend.passiveCatalogDrainPromise;
  assert.equal(backend.deferredPassiveCatalogState, null);
  backend.queuePassiveCatalogEvidence({ state });
  assert.equal(backend.passiveCatalogDrainPromise, null);
  backend.database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("passive item evidence convergence clears stale review conflicts", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-passive-review-convergence-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(persistedCatalogFixture()), "utf8");
  const backend = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  try {
    backend.database.observeCatalogObject({
      objectType: "item-identity", objectId: "i1",
      payload: { itemId: "i1", chainId: "c", level: 1, baseUnits: 1, saleValue: 99 },
      sourceType: "passive-runtime", sourceRef: "stale-board-state", countDuplicate: false,
    });
    backend.catalogGate.evaluateObject("item-identity", "i1");
    assert.equal(backend.database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1"), true);

    backend.queuePassiveCatalogEvidence({ state: { board: { grids: [{ index: 0, itemId: "i1", level: 1 }] }, orders: [], producers: [] } });
    await backend.passiveCatalogDrainPromise;

    assert.equal(backend.database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1"), false);
  } finally {
    await backend.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("runtime startup reconciles review conflicts against the latest persisted evidence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-review-startup-reconcile-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(persistedCatalogFixture()), "utf8");
  const first = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  first.database.observeCatalogObject({
    objectType: "item-identity", objectId: "i1",
    payload: { itemId: "i1", chainId: "c", level: 1, baseUnits: 1, saleValue: 99 },
    sourceType: "passive-runtime", sourceRef: "board-state", countDuplicate: false,
  });
  first.catalogGate.evaluateObject("item-identity", "i1");
  assert.equal(first.database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1"), true);
  first.database.observeCatalogObject({
    objectType: "item-identity", objectId: "i1",
    payload: { itemId: "i1", chainId: "c", level: 1, baseUnits: 1, saleValue: 0, iconResourceIdentifier: "leaf/1" },
    sourceType: "passive-runtime", sourceRef: "board-state", countDuplicate: false,
  });
  await first.close();

  const restarted = new AutomationRuntime({ rootDir: path.resolve(__dirname, ".."), dataDir, manageConnectionRoute: false });
  try {
    assert.equal(restarted.database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1"), false);
  } finally {
    await restarted.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
