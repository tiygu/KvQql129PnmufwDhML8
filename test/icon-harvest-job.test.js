"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { AutomationRuntime } = require("../src/automation-runtime");
const { createControlServer } = require("../src/control-server");

function iconAsset(filePath, hash) {
  return {
    hash,
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteSize: fs.statSync(filePath).size,
    filePath,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  return server.httpServer.address().port;
}

test("single-item Icon Harvest Job persists one child and replays an idempotent create", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-job-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const requests = [];
  runtime.iconService.request = (itemId) => {
    requests.push(String(itemId));
    return { status: "queued", taskId: 71, itemId: String(itemId) };
  };

  try {
    const input = {
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "single-item-job-1",
    };
    const created = runtime.createIconHarvestJob(input);
    const replayed = runtime.createIconHarvestJob(input);

    assert.equal(created.jobId, replayed.jobId);
    assert.equal(created.idempotentReplay, false);
    assert.equal(replayed.idempotentReplay, true);
    assert.equal(created.revision, 1);
    assert.equal(created.state, "queued");
    assert.equal(created.stage, "queued");
    assert.deepEqual(created.scope, input.scope);
    assert.deepEqual(created.progress, {
      settled: 0,
      total: 1,
      terminal: {
        succeeded: 0,
        deferred: 0,
        failed: 0,
        cancelled: 0,
      },
    });
    assert.equal(created.children.length, 1);
    assert.equal(created.children[0].itemId, item.objectId);
    assert.equal(created.children[0].state, "queued");
    assert.deepEqual(requests, [item.objectId]);
    const { idempotentReplay: _replay, taskId: _taskId, ...snapshot } = created;
    assert.deepEqual(runtime.getIconHarvestJob(created.jobId), snapshot);
    assert.equal(runtime.listIconHarvestJobs()[0].jobId, created.jobId);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("successful acquisition publishes and persists one revisioned job snapshot without replacing a manual display choice", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-success-"));
  const events = [];
  let runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    onEvent: (event) => events.push(event),
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const manualPath = path.join(dataDir, "manual.png");
  const acquiredPath = path.join(dataDir, "acquired.png");
  fs.writeFileSync(manualPath, "manual");
  fs.writeFileSync(acquiredPath, "acquired");
  const manual = runtime.database.saveIconCandidate({
    itemId: item.objectId,
    cacheKey: "manual-candidate",
    sourceType: "user-upload",
    rankScore: 1,
    autoSelect: false,
    asset: iconAsset(manualPath, "a".repeat(64)),
  });
  const decision = runtime.database.getCatalogObject(
    "item-identity",
    item.objectId,
  ).displayIcon;
  runtime.database.selectIconCandidate(item.objectId, manual.id, {
    actor: "operator",
    note: "keep this display choice",
    expectedDisplayIconRevision: decision.revision,
  });
  const semanticBefore = runtime.getCatalogObject(
    "item-identity",
    item.objectId,
  ).effectiveValue;
  const planningBefore = runtime.getPlanningCatalog().items.find(
    (entry) => String(entry.id) === item.objectId,
  );
  runtime.iconService.resolveSpriteFrame = async () => ({
    resourceUrl: "fixture://current-icon",
    runtimeIdentifier: "resolved-current-icon",
    rect: { x: 0, y: 0, width: 1, height: 1 },
    originalSize: { width: 1, height: 1 },
    offset: { x: 0, y: 0 },
    mimeType: "image/png",
  });
  runtime.iconService.readResource = async () => ({
    body: Buffer.from("fixture"),
    mimeType: "image/png",
    resolvedUrl: "fixture://current-icon",
  });
  runtime.iconService.processImage = async () => iconAsset(
    acquiredPath,
    "b".repeat(64),
  );

  try {
    const created = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "successful-single-item-job",
    });
    await runtime.iconService.waitForIdle();
    const completed = runtime.getIconHarvestJob(created.jobId);

    assert.equal(completed.revision, 3);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.stage, "committed");
    assert.deepEqual(completed.progress, {
      settled: 1,
      total: 1,
      terminal: {
        succeeded: 1,
        deferred: 0,
        failed: 0,
        cancelled: 0,
      },
    });
    assert.equal(completed.children[0].result.assetHash, "b".repeat(64));
    assert.equal(
      runtime.getCatalogObject("item-identity", item.objectId).selectedIcon.id,
      manual.id,
    );
    assert.deepEqual(
      runtime.getCatalogObject("item-identity", item.objectId).effectiveValue,
      semanticBefore,
    );
    assert.deepEqual(
      runtime.getPlanningCatalog().items.find(
        (entry) => String(entry.id) === item.objectId,
      ),
      planningBefore,
    );
    assert.deepEqual(
      events.filter((event) => event.type === "icon-harvest-job-updated").at(-1).job,
      completed,
    );

    await runtime.close();
    runtime = new AutomationRuntime({
      rootDir: path.resolve(__dirname, ".."),
      dataDir,
      manageConnectionRoute: false,
    });
    assert.deepEqual(runtime.getIconHarvestJob(created.jobId), completed);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("failed evidence commit settles the acquisition without leaving asset or candidate records", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-rollback-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const acquiredPath = path.join(dataDir, "failed-acquired.png");
  fs.writeFileSync(acquiredPath, "acquired");
  const acquiredHash = "c".repeat(64);
  runtime.iconService.resolveSpriteFrame = async () => ({
    resourceUrl: "fixture://failed-icon",
    rect: { x: 0, y: 0, width: 1, height: 1 },
    originalSize: { width: 1, height: 1 },
    offset: { x: 0, y: 0 },
    mimeType: "image/png",
  });
  runtime.iconService.readResource = async () => ({
    body: Buffer.from("fixture"),
    mimeType: "image/png",
    resolvedUrl: "fixture://failed-icon",
  });
  runtime.iconService.processImage = async () => iconAsset(
    acquiredPath,
    acquiredHash,
  );
  runtime.database.saveIconCandidateWithDecision = () => {
    throw Object.assign(new Error("injected SQLite failure"), {
      code: "SQLITE_INJECTED_FAILURE",
    });
  };

  try {
    const before = runtime.database.listIconCandidates(item.objectId).length;
    const created = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "failed-single-item-job",
    });
    await runtime.iconService.waitForIdle();
    const failed = runtime.getIconHarvestJob(created.jobId);

    assert.equal(failed.revision, 3);
    assert.equal(failed.state, "failed");
    assert.equal(failed.children[0].reason, "SQLITE_INJECTED_FAILURE");
    assert.equal(failed.children[0].result, null);
    assert.equal(runtime.database.listIconCandidates(item.objectId).length, before);
    assert.equal(runtime.database.getIconAsset(acquiredHash), null);
    assert.equal(fs.existsSync(acquiredPath), false);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("REST list and detail match the revisioned WebSocket snapshot", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-http-"));
  const publicRoot = path.join(dataDir, "public");
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, "index.html"), "ok");
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const requests = [];
  runtime.iconService.request = (itemId) => {
    requests.push(String(itemId));
    return { status: "queued", taskId: 81, itemId: String(itemId) };
  };
  const server = createControlServer({ runtime, publicRoot, dataDir });
  runtime.onEvent = (event) => server.broadcast(event);
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];

  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const update = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("job update timeout")), 2000);
      client.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "icon-harvest-job-updated") return;
        clearTimeout(timer);
        resolve(event.job);
      });
    });
    const input = {
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "http-single-item-job",
    };
    const response = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    assert.equal(response.status, 202);
    const created = await response.json();
    const websocketSnapshot = await update;
    const detailResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs/${created.jobId}`,
    );
    const detail = await detailResponse.json();
    const listResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs`,
    );
    const list = await listResponse.json();
    const replay = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );

    assert.deepEqual(detail, websocketSnapshot);
    assert.deepEqual(list, { jobs: [detail] });
    assert.equal((await replay.json()).jobId, created.jobId);
    assert.deepEqual(requests, [item.objectId]);
  } finally {
    client.close();
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("runtime restart converges unfinished harvest work to an explicit deferred result", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-restart-"));
  let runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  runtime.iconService.request = () => ({ status: "queued", taskId: 901, itemId: item.objectId });
  const created = runtime.createIconHarvestJob({
    scope: { type: "item", itemId: item.objectId },
    idempotencyKey: "restart-single-item-job",
  });
  assert.equal(created.state, "queued");
  await runtime.close();

  try {
    runtime = new AutomationRuntime({
      rootDir: path.resolve(__dirname, ".."),
      dataDir,
      manageConnectionRoute: false,
    });
    const recovered = runtime.getIconHarvestJob(created.jobId);
    assert.equal(recovered.state, "completed-with-gaps");
    assert.equal(recovered.finalStatus, "completed-with-gaps");
    assert.equal(recovered.reason, "runtime-restarted");
    assert.equal(recovered.children[0].state, "deferred");
    assert.equal(recovered.children[0].retryable, true);
    assert.equal(recovered.children[0].result, null);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("new harvest subscriptions reconcile an already-running runner task", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-subscription-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  runtime.iconService.request = () => ({
    status: "queued",
    taskId: 902,
    itemId: item.objectId,
  });
  runtime.iconService.getTask = () => ({
    status: "running",
    taskId: 902,
    itemId: item.objectId,
  });

  try {
    const created = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "existing-runner-task-job",
    });
    assert.equal(created.state, "running");
    assert.equal(created.revision, 2);

    runtime.iconHarvestJobs.handleAcquisitionEvent({
      type: "icon-acquisition-complete",
      taskId: 902,
      itemId: item.objectId,
      candidate: {
        id: 77,
        assetHash: "d".repeat(64),
        sourceType: "cocos-runtime-resource",
      },
    });
    const completed = runtime.getIconHarvestJob(created.jobId);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.revision, 3);
    assert.equal(completed.children[0].result.assetHash, "d".repeat(64));
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
