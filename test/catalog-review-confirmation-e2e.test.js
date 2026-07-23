"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { AutomationRuntime } = require("../src/automation-runtime");
const { createControlServer } = require("../src/control-server");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", () => resolve(server.httpServer.address().port));
  });
}

function openSocket(url) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForEvent(socket, predicate, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${label}`));
    }, 3000);
    const onMessage = (data) => {
      const event = JSON.parse(String(data));
      if (!predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

function seedReviewCandidate(runtime, objectId, level) {
  runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId: "review-chain", level, baseUnits: 2 ** (level - 1) },
    sourceType: "structural-inference",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
  return runtime.catalogGate.evaluateObject("item-identity", objectId);
}

test("控制台确认无误后保存 SQLite 审计、重规划、同步所有控制台并可刷新恢复", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-confirm-e2e-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const first = seedReviewCandidate(runtime, "review-first", 1);
  seedReviewCandidate(runtime, "review-next", 2);
  let replanCalls = 0;
  runtime.catalogReviewReplanner = async () => {
    replanCalls += 1;
    return {
      status: "ready",
      recovered: true,
      boundaryReason: null,
      recommendedOrderSlot: "order-a",
    };
  };
  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  const socketUrl = `ws://127.0.0.1:${port}/ws`;
  const [consoleA, consoleB] = await Promise.all([openSocket(socketUrl), openSocket(socketUrl)]);
  try {
    const request = {
      objectType: first.objectType,
      objectId: first.objectId,
      decision: "confirm",
      snapshot: first.algorithmCandidate,
      actor: "本地操作者",
      requestId: "browser-confirm-001",
      expectedRevision: first.revision,
    };
    const eventA = waitForEvent(consoleA, (event) => event.type === "catalog-review-updated", "console A review event");
    const eventB = waitForEvent(consoleB, (event) => event.type === "catalog-review-updated", "console B review event");
    const response = await fetch(`http://127.0.0.1:${port}/api/catalog/review/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    const completed = await response.json();
    assert.equal(completed.reviewStatus, "clear");
    assert.deepEqual(completed.effectiveValue, request.snapshot);
    assert.deepEqual(completed.reviewResolution.planningResult, {
      status: "ready",
      recovered: true,
      boundaryReason: null,
      recommendedOrderSlot: "order-a",
    });
    const expectedEvent = {
      type: "catalog-review-updated",
      objectType: first.objectType,
      objectId: first.objectId,
      revision: completed.revision,
      reviewStatus: "clear",
      planningResult: completed.reviewResolution.planningResult,
    };
    const [receivedA, receivedB] = await Promise.all([eventA, eventB]);
    assert.deepEqual({ ...receivedA, reviewQueue: undefined }, { ...expectedEvent, reviewQueue: undefined });
    assert.deepEqual({ ...receivedB, reviewQueue: undefined }, { ...expectedEvent, reviewQueue: undefined });
    assert.equal(receivedA.reviewQueue.some((entry) => entry.objectId === "review-next"), true);
    assert.deepEqual(receivedB.reviewQueue, receivedA.reviewQueue);

    const retry = await fetch(`http://127.0.0.1:${port}/api/catalog/review/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).idempotentReplay, true);
    assert.equal(replanCalls, 1);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: first.objectId }).length, 1);
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectId: first.objectId }).length, 1);

    const catalog = await (await fetch(`http://127.0.0.1:${port}/api/catalog`)).json();
    assert.equal(catalog.repository.reviewQueue.some((entry) => entry.objectId === first.objectId), false);
    assert.equal(catalog.repository.reviewQueue.some((entry) => entry.objectId === "review-next"), true);
    const restored = await (await fetch(`http://127.0.0.1:${port}/api/catalog/object?type=item-identity&id=${first.objectId}`)).json();
    assert.equal(restored.reviewStatus, "clear");
    assert.deepEqual(restored.effectiveValue, request.snapshot);
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectId: first.objectId })[0].planningResult.recovered, true);
  } finally {
    consoleA.close();
    consoleB.close();
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("重规划失败后刷新仍能恢复已保存结论、审计和当前诊断对象", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-replan-failed-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const first = seedReviewCandidate(runtime, "review-replan-failed", 1);
  runtime.catalogReviewReplanner = async () => {
    throw new Error("planner fixture failed");
  };
  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/catalog/review/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectType: first.objectType,
        objectId: first.objectId,
        decision: "confirm",
        snapshot: first.algorithmCandidate,
        actor: "本地操作者",
        requestId: "browser-confirm-replan-failed",
        expectedRevision: first.revision,
      }),
    });
    assert.equal(response.status, 200);
    const completed = await response.json();
    assert.equal(completed.reviewResolution.planningResult.status, "failed");

    const catalog = await (await fetch(`http://127.0.0.1:${port}/api/catalog`)).json();
    const queued = catalog.repository.reviewQueue.find((entry) => entry.objectId === first.objectId);
    assert.equal(queued.actionStatus, "已确认");
    assert.equal(queued.reviewStatus, "clear");
    const restored = await (await fetch(`http://127.0.0.1:${port}/api/catalog/object?type=item-identity&id=${first.objectId}`)).json();
    assert.equal(restored.reviewResolution.planningResult.status, "failed");
    assert.equal(restored.catalogAuditSummary.planningResult.status, "failed");
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: first.objectId }).length, 1);
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectId: first.objectId }).length, 1);
  } finally {
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
