"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createControlServer } = require("../src/control-server");

function createRuntime() {
  return {
    dashboard: async () => ({ connected: false, running: false }),
    getCatalogView: () => ({ revision: "db-revision-3", stats: { items: 3 }, repository: { summary: { states: { observed: 1, provisional: 1, active: 1 } }, objects: [{ objectType: "item-identity", objectId: "i", status: "active", revision: 3, evidenceSummary: { evidenceCount: 2 } }] } }),
    exportCatalog: () => ({ schemaVersion: 1, source: { type: "sqlite-catalog-repository", revision: "db-revision-3" }, objects: [] }),
    importCatalog: (snapshot, options) => ({ imported: snapshot.objects.length, preserved: 0, sourceFile: options.sourceFile, revision: "db-revision-4" }),
    acquireCatalogIcon: (itemId) => ({ status: "queued", taskId: 17, itemId }),
    getCatalogIconTask: (taskId) => ({ status: "complete", taskId: Number(taskId), itemId: "i" }),
    getCatalogIconAsset: () => null,
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
    connectionRouteStatus: async () => ({ listening: false, managed: false }),
    startConnectionRoute: async () => ({ ok: true, reason: "route-started" }),
    stopConnectionRoute: async () => ({ ok: true, reason: "route-stopped" }),
    preview: async () => ({ ok: true, reason: "planned" }),
    startInBackground: (options) => ({ ok: true, accepted: true, options }),
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
  try {
    const queued = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/acquire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objectId: "i" }) });
    assert.equal(queued.status, 202);
    assert.deepEqual(await queued.json(), { status: "queued", taskId: 17, itemId: "i" });
    const task = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/task?id=17`);
    assert.deepEqual(await task.json(), { status: "complete", taskId: 17, itemId: "i" });
    const icon = await fetch(`http://127.0.0.1:${port}/api/catalog/icon/${hash}`);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.equal(await icon.text(), "png-fixture");
  } finally {
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
