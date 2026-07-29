"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { AutomationRuntime } = require("../src/automation-runtime");
const { createControlServer } = require("../src/control-server");

async function listen(server) {
  await new Promise((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  return server.httpServer.address().port;
}

async function openSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextJob(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("job snapshot timeout")), 3000);
    const onMessage = (raw) => {
      const event = JSON.parse(String(raw));
      if (event.type !== "icon-harvest-job-updated" || !predicate(event.job)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(event.job);
    };
    socket.on("message", onMessage);
  });
}

function lifecycleRuntime(prefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  return { dataDir, runtime };
}

test("create idempotency replays the same request and rejects different content", async () => {
  const { dataDir, runtime } = lifecycleRuntime("icon-harvest-create-key-");
  const items = runtime.database.listCatalogObjects({ objectType: "item-identity" });
  assert.ok(items.length >= 2);
  runtime.iconService.request = (itemId) => ({
    status: "queued",
    taskId: String(itemId) === items[0].objectId ? 801 : 802,
    itemId: String(itemId),
  });
  runtime.iconService.getTask = (taskId) => ({
    status: "queued",
    taskId,
  });

  try {
    const input = {
      scope: { type: "item", itemId: items[0].objectId },
      idempotencyKey: "create-content-key",
    };
    const created = runtime.createIconHarvestJob(input);
    const replay = runtime.createIconHarvestJob(input);
    assert.equal(replay.jobId, created.jobId);
    assert.equal(replay.idempotentReplay, true);
    assert.throws(
      () => runtime.cancelIconHarvestJob({
        jobId: created.jobId,
        expectedRevision: created.revision,
        idempotencyKey: "create-content-key",
      }),
      (error) => error.statusCode === 409
        && error.code === "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
    );
    assert.throws(
      () => runtime.createIconHarvestJob({
        scope: { type: "item", itemId: items[1].objectId },
        idempotencyKey: "create-content-key",
      }),
      (error) => error.statusCode === 409
        && error.code === "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("cancelling a parent is revisioned, observable, idempotent, and preserves shared runner work", async () => {
  const { dataDir, runtime } = lifecycleRuntime("icon-harvest-cancel-");
  const events = [];
  runtime.onEvent = (event) => events.push(event);
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];

  try {
    runtime.sessionSupervisor.adoptSession({ kind: "test-fixture" });
    const first = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "cancel-parent-a",
    });
    const second = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "cancel-parent-b",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.taskId, second.taskId);

    const firstBefore = runtime.getIconHarvestJob(first.jobId);
    const cancelledFirst = runtime.cancelIconHarvestJob({
      jobId: first.jobId,
      expectedRevision: firstBefore.revision,
      idempotencyKey: "cancel-command-a",
    });
    assert.equal(cancelledFirst.state, "cancelled");
    assert.equal(runtime.iconService.getTask(first.taskId).status, "queued");
    assert.deepEqual(
      events
        .filter((event) => event.type === "icon-harvest-job-updated" && event.job.jobId === first.jobId)
        .slice(-2)
        .map((event) => event.job.state),
      ["cancelling", "cancelled"],
    );
    assert.throws(
      () => runtime.retryIconHarvestJob({
        jobId: first.jobId,
        expectedRevision: cancelledFirst.revision,
        idempotencyKey: "cancel-command-a",
      }),
      (error) => error.statusCode === 409
        && error.code === "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
    );

    const replay = runtime.cancelIconHarvestJob({
      jobId: first.jobId,
      expectedRevision: firstBefore.revision,
      idempotencyKey: "cancel-command-a",
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.revision, cancelledFirst.revision);
    assert.throws(
      () => runtime.cancelIconHarvestJob({
        jobId: first.jobId,
        expectedRevision: firstBefore.revision,
        idempotencyKey: "cancel-command-stale",
      }),
      (error) => error.statusCode === 409
        && error.code === "ICON_HARVEST_REVISION_CONFLICT"
        && error.currentJob.revision === cancelledFirst.revision,
    );

    const secondBefore = runtime.getIconHarvestJob(second.jobId);
    const cancelledSecond = runtime.cancelIconHarvestJob({
      jobId: second.jobId,
      expectedRevision: secondBefore.revision,
      idempotencyKey: "cancel-command-b",
    });
    assert.equal(cancelledSecond.state, "cancelled");
    assert.equal(runtime.iconService.getTask(second.taskId).status, "cancelled");
  } finally {
    runtime.sessionSupervisor.finish();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("explicit retry creates one immutable related job for unresolved work and never auto-retries", async () => {
  const { dataDir, runtime } = lifecycleRuntime("icon-harvest-retry-");
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const requested = [];
  let nextTaskId = 500;
  runtime.iconService.request = (itemId) => {
    requested.push(String(itemId));
    return { status: "queued", taskId: nextTaskId++, itemId: String(itemId) };
  };
  runtime.iconService.getTask = (taskId) => ({
    status: taskId === 500 ? "error" : "queued",
    taskId,
    itemId: item.objectId,
    error: taskId === 500 ? "fixture failed" : null,
  });

  try {
    const source = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "retry-source",
    });
    assert.equal(source.state, "failed");
    assert.deepEqual(requested, [item.objectId]);

    const retried = runtime.retryIconHarvestJob({
      jobId: source.jobId,
      expectedRevision: source.revision,
      idempotencyKey: "retry-command",
    });
    assert.notEqual(retried.jobId, source.jobId);
    assert.equal(retried.retryOfJobId, source.jobId);
    assert.equal(retried.children.length, 1);
    assert.equal(retried.children[0].itemId, item.objectId);
    assert.equal(retried.state, "queued");
    assert.deepEqual(requested, [item.objectId, item.objectId]);

    const replay = runtime.retryIconHarvestJob({
      jobId: source.jobId,
      expectedRevision: source.revision,
      idempotencyKey: "retry-command",
    });
    assert.equal(replay.jobId, retried.jobId);
    assert.equal(replay.idempotentReplay, true);
    assert.deepEqual(requested, [item.objectId, item.objectId]);

    assert.throws(
      () => runtime.retryIconHarvestJob({
        jobId: source.jobId,
        expectedRevision: source.revision + 1,
        idempotencyKey: "retry-command",
      }),
      (error) => error.statusCode === 409
        && error.code === "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("two consoles resolve cancel and retry races by revision and reconnect from the REST-consistent snapshot", async () => {
  const { dataDir, runtime } = lifecycleRuntime("icon-harvest-convergence-");
  const publicRoot = path.join(dataDir, "public");
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, "index.html"), "ok");
  runtime.sessionSupervisor.adoptSession({ kind: "test-fixture" });
  const server = createControlServer({ runtime, publicRoot, dataDir });
  runtime.onEvent = (event) => server.broadcast(event);
  const port = await listen(server);
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const consoleA = await openSocket(port);
  let consoleB = await openSocket(port);

  try {
    const createdEventA = nextJob(consoleA, (job) => job.scope.itemId === item.objectId);
    const createdEventB = nextJob(consoleB, (job) => job.scope.itemId === item.objectId);
    const createdResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: { type: "item", itemId: item.objectId },
          idempotencyKey: "convergence-source",
        }),
      },
    );
    const created = await createdResponse.json();
    await Promise.all([createdEventA, createdEventB]);
    const current = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs/${created.jobId}`,
    ).then((response) => response.json());
    consoleB.close();
    await new Promise((resolve) => consoleB.once("close", resolve));

    const cancelBodies = ["console-a-cancel", "console-b-cancel"].map((idempotencyKey) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: current.revision, idempotencyKey }),
    }));
    const cancelResponses = await Promise.all(cancelBodies.map((options) => fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs/${created.jobId}/cancel`,
      options,
    )));
    assert.deepEqual(
      cancelResponses.map((response) => response.status).sort(),
      [200, 409],
    );

    const persisted = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs/${created.jobId}`,
    ).then((response) => response.json());
    assert.equal(persisted.state, "cancelled");

    consoleB = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const recoveredPromise = nextJob(
      consoleB,
      (job) => job.jobId === created.jobId,
    );
    await new Promise((resolve, reject) => {
      consoleB.once("open", resolve);
      consoleB.once("error", reject);
    });
    const recovered = await recoveredPromise;
    assert.deepEqual(recovered, persisted);

    const retryBodies = ["console-a-retry", "console-b-retry"].map((idempotencyKey) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: persisted.revision, idempotencyKey }),
    }));
    const retryResponses = await Promise.all(retryBodies.map((options) => fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs/${created.jobId}/retry`,
      options,
    )));
    assert.deepEqual(
      retryResponses.map((response) => response.status).sort(),
      [202, 409],
    );
    const retry = await retryResponses.find((response) => response.status === 202).json();
    assert.equal(retry.retryOfJobId, created.jobId);
  } finally {
    consoleA.close();
    consoleB.close();
    runtime.sessionSupervisor.finish();
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
