"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createControlServer } = require("../src/control-server");

function createRuntime() {
  const reviewQueue = [{ objectType: "item-identity", objectId: "next", revision: 2, reviewStatus: "needs-review" }];
  return {
    dashboard: async () => ({ connected: false, running: false }),
    getCatalogView: () => ({ revision: "db-revision-3", stats: { items: 3 }, repository: { summary: { states: { observed: 1, provisional: 1, active: 1 } }, objects: [{ objectType: "item-identity", objectId: "i", status: "active", revision: 3, evidenceSummary: { evidenceCount: 2 } }], reviewQueue } }),
    exportCatalog: () => ({ schemaVersion: 1, source: { type: "sqlite-catalog-repository", revision: "db-revision-3" }, objects: [] }),
    importCatalog: (snapshot, options) => ({ imported: snapshot.objects.length, preserved: 0, sourceFile: options.sourceFile, revision: "db-revision-4" }),
    acquireCatalogIcon: (itemId) => ({ status: "queued", taskId: 17, itemId }),
    getCatalogIconTask: (taskId) => ({ status: "complete", taskId: Number(taskId), itemId: "i" }),
    getCatalogIconAsset: () => null,
    selectCatalogIcon: (itemId, candidateId, input) => ({
      objectType: "item-identity",
      objectId: itemId,
      selectedIcon: { id: candidateId },
      displayIcon: { revision: input.expectedDisplayIconRevision + 1, selectedIcon: { id: candidateId } },
      revision: 3,
      reviewStatus: "clear",
    }),
    revokeCatalogIconSelection: (itemId, input) => ({
      objectType: "item-identity",
      objectId: itemId,
      selectedIcon: null,
      displayIcon: { revision: input.expectedDisplayIconRevision + 1, selectedIcon: null },
      revision: 3,
      reviewStatus: "clear",
    }),
    uploadCatalogIcon: async (itemId, input) => ({
      objectType: "item-identity",
      objectId: itemId,
      selectedIcon: { sourceType: "user-upload" },
      displayIcon: { revision: Number(input.expectedDisplayIconRevision) + 1, selectedIcon: { sourceType: "user-upload" } },
      revision: 3,
      reviewStatus: "clear",
    }),
    getCatalogObject: (type, id) => ({ objectType: type, objectId: id, status: "active", revision: 3, evidenceSummary: { evidenceCount: 2 } }),
    setCatalogObjectDisposition: (type, id, disposition, reason, expectedRevision) => {
      if (expectedRevision !== 3) throw Object.assign(new Error("catalog revision conflict"), { statusCode: 409 });
      return { objectType: type, objectId: id, disposition, expectedRevision, latestTransition: { reason } };
    },
    setCatalogEvidenceDisposition: (type, id, evidenceId, disposition, reason, expectedRevision) => ({ objectType: type, objectId: id, evidenceId, disposition, expectedRevision, latestTransition: { reason } }),
    applyCatalogRuling: (input) => {
      if (input.expectedRevision !== 3) throw Object.assign(new Error("catalog revision conflict"), { code: "CATALOG_REVISION_CONFLICT", statusCode: 409, fieldPath: input.fieldPath, currentObject: { objectType: input.objectType, objectId: input.objectId, revision: 3 } });
      return { objectType: input.objectType, objectId: input.objectId, revision: 4, reviewStatus: "needs-review", humanValues: { [input.fieldPath]: { id: 9, value: input.value } } };
    },
    revokeCatalogRuling: (input) => ({ objectType: input.objectType, objectId: input.objectId, revision: 5, reviewStatus: "clear", humanValues: {} }),
    refreshCatalogFromRuntime: async () => ({ ok: true }),
    runActiveCatalogScan: async ({ itemIds }) => ({ ok: true, reason: "active-catalog-scan-complete", itemIds, plan: { status: "ready" } }),
    connectionRouteStatus: async () => ({ listening: false, managed: false }),
    startConnectionRoute: async () => ({ ok: true, reason: "route-started" }),
    stopConnectionRoute: async () => ({ ok: true, reason: "route-stopped" }),
    preview: async () => ({ ok: true, reason: "planned" }),
    startInBackground: (options) => ({ ok: true, accepted: true, options }),
    startIdleInBackground: (options) => ({ ok: true, accepted: true, idle: true, options }),
    stop: () => ({ ok: true }),
    pause: () => ({ ok: true, paused: true }),
    resume: () => ({ ok: true, paused: false }),
    completeCurrentMapMission: async () => ({ ok: true }),
    getSettings: () => ({ mode: "observation" }),
    saveSettings: (settings) => settings,
    exportDiagnostic: async (targetPath) => fs.writeFileSync(targetPath, "zip-fixture"),
  };
}

async function listen(server) {
  await new Promise((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  return server.httpServer.address().port;
}

function waitForEvent(client, predicate, label = "event") {
  let timer = null;
  let handler = null;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      client.off("message", handler);
      reject(new Error(`${label} timeout`));
    }, 2000);
    handler = (raw) => {
      const event = JSON.parse(String(raw));
      if (!predicate(event)) return;
      clearTimeout(timer);
      client.off("message", handler);
      resolve(event);
    };
    client.on("message", handler);
  });
  return {
    promise,
    cancel() {
      clearTimeout(timer);
      client.off("message", handler);
    },
  };
}

test("control server hosts the console and accepts background automation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-server-"));
  const publicRoot = path.join(root, "public");
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, "index.html"), "<h1>console fixture</h1>");
  const server = createControlServer({ runtime: createRuntime(), publicRoot, dataDir: path.join(root, "data") });
  const port = await listen(server);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /console fixture/);

    const response = await fetch(`http://127.0.0.1:${port}/api/automation/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxActions: 1 }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, accepted: true, options: { maxActions: 1 } });

    const continuousResponse = await fetch(`http://127.0.0.1:${port}/api/automation/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "automatic" }),
    });
    assert.equal(continuousResponse.status, 202);
    assert.deepEqual(await continuousResponse.json(), { ok: true, accepted: true, idle: true, options: { mode: "automatic" } });

    const catalogResponse = await fetch(`http://127.0.0.1:${port}/api/catalog`);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.revision, "db-revision-3");
    assert.equal(catalog.repository.objects[0].status, "active");
    assert.equal(catalog.repository.objects[0].revision, 3);
    assert.equal(catalog.repository.objects[0].evidenceSummary.evidenceCount, 2);

    const objectResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/object?type=item-identity&id=i`);
    assert.deepEqual(await objectResponse.json(), { objectType: "item-identity", objectId: "i", status: "active", revision: 3, evidenceSummary: { evidenceCount: 2 } });
    const invalidObjectResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/object?type=unknown&id=i`);
    assert.equal(invalidObjectResponse.status, 400);
    const dispositionResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/object/disposition`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType: "item-identity", objectId: "i", disposition: "paused", reason: "operator-paused", expectedRevision: 3 }),
    });
    assert.deepEqual(await dispositionResponse.json(), { objectType: "item-identity", objectId: "i", disposition: "paused", expectedRevision: 3, latestTransition: { reason: "operator-paused" } });
    const staleDispositionResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/object/disposition`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType: "item-identity", objectId: "i", disposition: "paused", reason: "stale", expectedRevision: 2 }),
    });
    assert.equal(staleDispositionResponse.status, 409);
    const scanResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemIds: ["i"] }) });
    assert.deepEqual(await scanResponse.json(), { ok: true, reason: "active-catalog-scan-complete", itemIds: ["i"], plan: { status: "ready" } });
    const oversizedScanResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemIds: Array.from({ length: 13 }, (_, index) => `i${index}`) }) });
    assert.equal(oversizedScanResponse.status, 400);
    assert.deepEqual(await oversizedScanResponse.json(), { ok: false, error: "active-catalog-scan-target-limit", limit: 12 });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control server 从同一 SQLite revision 导出并导入 Catalog JSON", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-catalog-json-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "ok");
  const server = createControlServer({ runtime: createRuntime(), publicRoot: path.join(root, "public"), dataDir: path.join(root, "data") });
  const port = await listen(server);
  try {
    const exported = await fetch(`http://127.0.0.1:${port}/api/catalog/export`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /catalog-repository-/);
    const snapshot = await exported.json();
    assert.equal(snapshot.source.revision, "db-revision-3");

    const imported = await fetch(`http://127.0.0.1:${port}/api/catalog/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot),
    });
    assert.deepEqual(await imported.json(), { imported: 0, preserved: 0, sourceFile: "control-api", revision: "db-revision-4" });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control server 按需排队图标任务并提供内容哈希资源", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-icon-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "ok");
  const iconPath = path.join(root, "icon.png");
  fs.writeFileSync(iconPath, "png-fixture");
  const runtime = createRuntime();
  const hash = "a".repeat(64);
  runtime.getCatalogIconAsset = (requestedHash) => requestedHash === hash ? { hash, mimeType: "image/png", filePath: iconPath } : null;
  const server = createControlServer({ runtime, publicRoot: path.join(root, "public"), dataDir: path.join(root, "data") });
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const queued = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/acquire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objectId: "i" }) });
    assert.equal(queued.status, 202);
    assert.deepEqual(await queued.json(), { status: "queued", taskId: 17, itemId: "i" });
    const task = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/task?id=17`);
    assert.deepEqual(await task.json(), { status: "complete", taskId: 17, itemId: "i" });
    const icon = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/${hash}`);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.equal(await icon.text(), "png-fixture");
    const selected = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/select`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objectId: "i", candidateId: 4, actor: "operator", note: "best", expectedDisplayIconRevision: 3 }) });
    const selectedObject = await selected.json();
    assert.equal(selectedObject.revision, 3);
    assert.equal(selectedObject.displayIcon.revision, 4);
    assert.equal(selectedObject.selectedIcon.id, 4);
    const revoked = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objectId: "i", actor: "operator", note: "recheck", expectedDisplayIconRevision: 4 }) });
    assert.equal((await revoked.json()).selectedIcon, null);
    const uploaded = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objectId: "i", actor: "operator", note: "replacement", expectedDisplayIconRevision: 5, mimeType: "image/png", dataBase64: "cG5n" }) });
    assert.equal((await uploaded.json()).selectedIcon.sourceType, "user-upload");
  } finally {
    client.close();
    await server.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control server broadcasts runtime events to every connected page", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-ws-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "ok");
  const server = createControlServer({ runtime: createRuntime(), publicRoot: path.join(root, "public"), dataDir: path.join(root, "data") });
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event timeout")), 2000);
      client.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "automation-status") return;
        clearTimeout(timer);
        assert.equal(event.running, true);
        resolve();
      });
      server.broadcast({ type: "automation-status", running: true });
    });
  } finally {
    client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("人工裁决 API 返回明确 revision 冲突并向所有控制台广播审核变化", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-ruling-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "ok");
  const server = createControlServer({ runtime: createRuntime(), publicRoot: path.join(root, "public"), dataDir: path.join(root, "data") });
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    const eventPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("catalog event timeout")), 2000);
      client.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "catalog-review-updated") return;
        clearTimeout(timer);
        resolve(event);
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/catalog/ruling`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType: "item-identity", objectId: "i", fieldPath: "level", decision: "modify", value: 2, actor: "operator-a", note: "核对", expectedRevision: 3, baseRulingId: null }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.revision, 4);
    assert.deepEqual(await eventPromise, { type: "catalog-review-updated", objectType: "item-identity", objectId: "i", revision: 4, reviewStatus: "needs-review" });

    const stale = await fetch(`http://127.0.0.1:${port}/api/catalog/ruling`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType: "item-identity", objectId: "i", fieldPath: "level", decision: "modify", value: 3, actor: "operator-b", note: "旧页面", expectedRevision: 2, baseRulingId: null }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { ok: false, error: "catalog revision conflict", code: "CATALOG_REVISION_CONFLICT", fieldPath: "level", currentObject: { objectType: "item-identity", objectId: "i", revision: 3 } });
  } finally {
    client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("完整候选确认与整项修改会完成审核、校验 revision 并广播队列变化", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-review-complete-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "ok");
  const runtime = createRuntime();
  const reviewQueue = runtime.getCatalogView().repository.reviewQueue;
  const completions = [];
  let revision = 3;
  runtime.completeCatalogReview = (input) => {
    if (input.expectedRevision !== revision) {
      throw Object.assign(new Error("catalog revision conflict"), {
        code: "CATALOG_REVISION_CONFLICT",
        statusCode: 409,
        currentObject: { objectType: input.objectType, objectId: input.objectId, revision },
      });
    }
    completions.push(input);
    revision += 1;
    const effectiveValue = input.snapshot;
    return {
      objectType: input.objectType,
      objectId: input.objectId,
      status: "active",
      revision,
      reviewStatus: "clear",
      reviewReasons: [],
      effectiveValue,
    };
  };
  const server = createControlServer({ runtime, publicRoot: path.join(root, "public"), dataDir: path.join(root, "data") });
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });

    const confirmInput = {
      objectType: "item-identity", objectId: "i", decision: "confirm",
      snapshot: { itemId: "i", chainId: "c", level: 1, baseUnits: 1 },
      actor: "operator-a", note: "完整候选已核对", requestId: "confirm-i-3", expectedRevision: 3,
    };
    const confirmEvent = waitForEvent(client, (event) => event.type === "catalog-review-updated" && event.revision === 4, "catalog confirm event");
    const confirmed = await fetch(`http://127.0.0.1:${port}/api/catalog/review/complete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(confirmInput),
    });
    if (confirmed.status !== 200) confirmEvent.cancel();
    assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), {
      objectType: "item-identity", objectId: "i", status: "active", revision: 4,
      reviewStatus: "clear", reviewReasons: [],
      effectiveValue: { itemId: "i", chainId: "c", level: 1, baseUnits: 1 },
    });
    assert.deepEqual(await confirmEvent.promise, {
      type: "catalog-review-updated", objectType: "item-identity", objectId: "i", revision: 4, reviewStatus: "clear",
      planningResult: null,
      reviewQueue,
    });

    const modifiedPayload = { itemId: "i", chainId: "manual", level: 2, baseUnits: 2 };
    const modifyInput = {
      objectType: "item-identity", objectId: "i", decision: "modify", snapshot: modifiedPayload,
      actor: "operator-b", note: "整项修改已核对", requestId: "modify-i-4", expectedRevision: 4,
    };
    const modifyEvent = waitForEvent(client, (event) => event.type === "catalog-review-updated" && event.revision === 5, "catalog modify event");
    const modified = await fetch(`http://127.0.0.1:${port}/api/catalog/review/complete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(modifyInput),
    });
    if (modified.status !== 200) modifyEvent.cancel();
    assert.equal(modified.status, 200);
    assert.deepEqual((await modified.json()).effectiveValue, modifiedPayload);
    assert.deepEqual(await modifyEvent.promise, {
      type: "catalog-review-updated", objectType: "item-identity", objectId: "i", revision: 5, reviewStatus: "clear",
      planningResult: null,
      reviewQueue,
    });
    assert.deepEqual(completions, [confirmInput, modifyInput]);

    const stale = await fetch(`http://127.0.0.1:${port}/api/catalog/review/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...confirmInput, note: "旧页面", expectedRevision: 2 }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      ok: false, error: "catalog revision conflict", code: "CATALOG_REVISION_CONFLICT",
      currentObject: { objectType: "item-identity", objectId: "i", revision: 5 },
    });
  } finally {
    client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("暂时跳过 API 返回 Runtime 队列并向其他控制台广播会话变化", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-review-skip-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "ok");
  const runtime = createRuntime();
  const calls = [];
  runtime.skipCatalogReview = (input) => {
    calls.push(input);
    return {
      ok: true,
      reviewQueue: [
        { objectType: "item-identity", objectId: "next", actionStatus: "需要处理" },
        { objectType: "item-identity", objectId: input.objectId, actionStatus: "已跳过" },
      ],
      reviewSession: { revision: 1, commandRevision: 1, skippedObjectKeys: [`${input.objectType}:${input.objectId}`], resumeObjectKey: "item-identity:next" },
      nextReviewTarget: { objectType: "item-identity", objectId: "next", actionStatus: "需要处理" },
    };
  };
  const server = createControlServer({ runtime, publicRoot: path.join(root, "public"), dataDir: path.join(root, "data") });
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    const update = waitForEvent(client, (event) => event.type === "catalog-review-session-updated");
    const response = await fetch(`http://127.0.0.1:${port}/api/catalog/review/skip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType: "item-identity", objectId: "skipped" }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ objectType: "item-identity", objectId: "skipped" }]);
    assert.equal(result.reviewQueue.at(-1).actionStatus, "已跳过");
    assert.deepEqual(await update.promise, {
      type: "catalog-review-session-updated",
      reviewQueue: result.reviewQueue,
      reviewSession: result.reviewSession,
    });
  } finally {
    client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("高级 JSON 快照预校验 API 返回人话差异和影响且不广播对象变化", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-review-preview-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "ok");
  const runtime = createRuntime();
  const previews = [];
  runtime.previewCatalogReview = (input) => {
    previews.push(input);
    return {
      valid: true,
      objectType: input.objectType,
      objectId: input.objectId,
      revision: input.expectedRevision,
      snapshot: input.snapshot,
      meaningfulDifferences: [{ fieldPath: "name", oldValue: "旧名称", newValue: "新名称" }],
      planningImpact: { summary: "影响 1 个订单、0 条合成关系", orders: [{ slot: "order-a", impactedItems: ["i"] }], relations: [] },
    };
  };
  const server = createControlServer({ runtime, publicRoot: path.join(root, "public"), dataDir: path.join(root, "data") });
  const port = await listen(server);
  try {
    const input = {
      objectType: "item-identity",
      objectId: "i",
      snapshot: { itemId: "i", chainId: "c", level: 1, baseUnits: 1, name: "新名称" },
      expectedRevision: 3,
    };
    const response = await fetch(`http://127.0.0.1:${port}/api/catalog/review/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.deepEqual(preview.meaningfulDifferences, [{ fieldPath: "name", oldValue: "旧名称", newValue: "新名称" }]);
    assert.equal(preview.planningImpact.orders[0].slot, "order-a");
    assert.deepEqual(previews, [input]);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("证据处置 API 返回重评结果并向所有控制台广播审核变化", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-evidence-disposition-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), "ok");
  const runtime = createRuntime();
  const calls = [];
  runtime.setCatalogEvidenceDisposition = (objectType, objectId, evidenceId, disposition, reason, expectedRevision) => {
    calls.push({ objectType, objectId, evidenceId, disposition, reason, expectedRevision });
    return {
      objectType, objectId, status: "active", revision: expectedRevision + 1,
      reviewStatus: "clear", reviewReasons: [],
      evidence: [{ id: Number(evidenceId), disposition }],
    };
  };
  const server = createControlServer({ runtime, publicRoot: path.join(root, "public"), dataDir: path.join(root, "data") });
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    const input = {
      objectType: "item-identity", objectId: "i", evidenceId: 7,
      disposition: "paused", reason: "等待复核", expectedRevision: 3,
    };
    const pendingEvent = waitForEvent(client, (event) => event.type === "catalog-review-updated" && event.revision === 4, "catalog evidence event");
    const response = await fetch(`http://127.0.0.1:${port}/api/catalog/evidence/disposition`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (response.status !== 200) pendingEvent.cancel();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      objectType: "item-identity", objectId: "i", status: "active", revision: 4,
      reviewStatus: "clear", reviewReasons: [], evidence: [{ id: 7, disposition: "paused" }],
    });
    assert.deepEqual(calls, [input]);
    assert.deepEqual(await pendingEvent.promise, {
      type: "catalog-review-updated", objectType: "item-identity", objectId: "i", revision: 4, reviewStatus: "clear",
    });
  } finally {
    client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
