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
    }, 10000);
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

function seedActiveCatalogItem(runtime, objectId, level, mergeTarget = null) {
  runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId: "pause-chain", level, baseUnits: 2 ** (level - 1), name: `物品 ${level}` },
    sourceType: "runtime-capture",
    sourceRef: `${objectId}-identity.json`,
    countDuplicate: false,
  });
  runtime.catalogGate.evaluateObject("item-identity", objectId);
  runtime.database.observeCatalogObject({
    objectType: "merge-relation",
    objectId,
    payload: { itemId: objectId, chainId: "pause-chain", level, requiredCount: 2, mergeTarget },
    sourceType: "runtime-capture",
    sourceRef: `${objectId}-relation.json`,
    countDuplicate: false,
  });
  runtime.catalogGate.evaluateObject("merge-relation", objectId);
  return runtime.database.getCatalogObject("item-identity", objectId);
}

test("真实重规划从证据阻塞中返回首个独立审核对象", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-production-replan-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  runtime.getPlanningCatalog = () => ({
    coverage: {},
    items: [],
    producers: [],
    evidence: { objects: [] },
  });
  runtime.lastState = {
    schemaVersion: 1,
    scene: "board",
    resources: { energy: 10 },
    board: { signature: "empty", empty: 9, grids: [], mergeCandidates: [] },
    orders: [{ slot: "blocked", rewardCoins: 10, items: [{ itemId: "unknown-item", complete: false }] }],
  };
  try {
    const result = await runtime._replanAfterCatalogReview();

    assert.equal(result.status, "evidence-waiting");
    assert.deepEqual(result.blockingReviewTarget, {
      objectType: "item-identity",
      objectId: "unknown-item",
    });
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

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

test("并发提交冲突返回最新完整对象和本地快照差异且只保存首个结论", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-concurrent-conflict-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const before = seedReviewCandidate(runtime, "concurrent-review", 2);
  runtime.catalogReviewReplanner = async () => ({
    status: "ready",
    recovered: true,
    boundaryReason: null,
    recommendedOrderSlot: "order-a",
  });
  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  try {
    const firstSnapshot = { ...before.algorithmCandidate, name: "控制台甲结论" };
    const secondSnapshot = { ...before.algorithmCandidate, name: "控制台乙草稿" };
    const first = await fetch(`http://127.0.0.1:${port}/api/catalog/review/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectType: before.objectType,
        objectId: before.objectId,
        decision: "modify",
        snapshot: firstSnapshot,
        actor: "控制台甲",
        requestId: "concurrent-review-a",
        expectedRevision: before.revision,
      }),
    });
    assert.equal(first.status, 200);
    const committed = await first.json();

    const stale = await fetch(`http://127.0.0.1:${port}/api/catalog/review/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectType: before.objectType,
        objectId: before.objectId,
        decision: "modify",
        snapshot: secondSnapshot,
        actor: "控制台乙",
        requestId: "concurrent-review-b",
        expectedRevision: before.revision,
      }),
    });
    assert.equal(stale.status, 409);
    const conflict = await stale.json();
    assert.equal(conflict.code, "CATALOG_REVISION_CONFLICT");
    assert.equal(conflict.currentObject.revision, committed.revision);
    assert.deepEqual(conflict.currentObject.effectiveValue, firstSnapshot);
    assert.deepEqual(conflict.meaningfulDifferences, [{
      fieldPath: "name",
      oldValue: "控制台甲结论",
      newValue: "控制台乙草稿",
    }]);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: before.objectId }).length, 1);
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectId: before.objectId }).length, 1);
  } finally {
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("暂停对象预览订单与关系、隔离规划并在恢复后向所有控制台广播同一 revision", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-object-pause-e2e-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  seedActiveCatalogItem(runtime, "pause-target", 2);
  let source = seedActiveCatalogItem(runtime, "pause-source", 1, "pause-target");
  source = runtime.database.applyCatalogRuling({
    objectType: "item-identity",
    objectId: "pause-source",
    fieldPath: "name",
    decision: "confirm",
    value: "物品 1",
    actor: "历史操作者",
    note: "保留裁决历史",
    expectedRevision: source.revision,
  });
  runtime.lastState = {
    schemaVersion: 1,
    scene: "board",
    resources: { energy: 10 },
    board: { signature: "pause-fixture", empty: 8, grids: [], mergeCandidates: [] },
    orders: [{ slot: "pause-order", items: [{ itemId: "pause-target", complete: false }] }],
  };
  let replanCalls = 0;
  runtime.catalogReviewOperator.replanAfterCatalogReview = async () => {
    replanCalls += 1;
    return {
      status: "ready",
      recovered: true,
      boundaryReason: null,
      recommendedOrderSlot: "pause-order",
    };
  };
  const before = runtime.getCatalogObject("item-identity", "pause-source");
  assert.equal(before.planningImpact.orders.length, 1);
  assert.equal(before.planningImpact.relations.some((relation) => relation.objectId === "pause-source"), true);
  const preserved = {
    evidence: before.evidence,
    versions: before.versions,
    rulingHistory: before.rulingHistory,
  };
  assert.equal(runtime.getPlanningCatalog().items.some((item) => item.id === "pause-source"), true);

  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  const socketUrl = `ws://127.0.0.1:${port}/ws`;
  const [consoleA, consoleB] = await Promise.all([openSocket(socketUrl), openSocket(socketUrl)]);
  try {
    const pausedEventA = waitForEvent(consoleA, (event) => event.type === "catalog-review-updated" && event.disposition === "paused", "console A pause event");
    const pausedEventB = waitForEvent(consoleB, (event) => event.type === "catalog-review-updated" && event.disposition === "paused", "console B pause event");
    const pauseResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/object/disposition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectType: "item-identity",
        objectId: "pause-source",
        disposition: "paused",
        reason: "operator-confirmed-planning-impact",
        expectedRevision: before.revision,
      }),
    });
    assert.equal(pauseResponse.status, 200);
    const paused = await pauseResponse.json();
    assert.equal(paused.disposition, "paused");
    assert.equal(paused.planningEligible, false);
    assert.equal(paused.reviewStatus, before.reviewStatus);
    assert.equal(paused.revision, before.revision + 1);
    assert.deepEqual(paused.evidence, preserved.evidence);
    assert.deepEqual(paused.versions, preserved.versions);
    assert.deepEqual(paused.rulingHistory, preserved.rulingHistory);
    assert.equal(runtime.getPlanningCatalog().items.some((item) => item.id === "pause-source"), false);
    const [receivedPauseA, receivedPauseB] = await Promise.all([pausedEventA, pausedEventB]);
    assert.deepEqual(receivedPauseA, receivedPauseB);
    assert.equal(receivedPauseA.revision, paused.revision);
    assert.equal(receivedPauseA.planningEligible, false);

    const resumedEventA = waitForEvent(consoleA, (event) => event.type === "catalog-review-updated" && event.disposition === "enabled", "console A resume event");
    const resumedEventB = waitForEvent(consoleB, (event) => event.type === "catalog-review-updated" && event.disposition === "enabled", "console B resume event");
    const resumeResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/object/disposition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectType: "item-identity",
        objectId: "pause-source",
        disposition: "enabled",
        reason: "operator-resumed-review",
        expectedRevision: paused.revision,
      }),
    });
    assert.equal(resumeResponse.status, 200);
    const resumed = await resumeResponse.json();
    assert.equal(resumed.disposition, "enabled");
    assert.equal(resumed.planningEligible, true);
    assert.equal(resumed.revision, paused.revision + 1);
    assert.deepEqual(resumed.evidence, preserved.evidence);
    assert.deepEqual(resumed.versions, preserved.versions);
    assert.deepEqual(resumed.rulingHistory, preserved.rulingHistory);
    assert.equal(runtime.getPlanningCatalog().items.some((item) => item.id === "pause-source"), true);
    const [receivedResumeA, receivedResumeB] = await Promise.all([resumedEventA, resumedEventB]);
    assert.deepEqual(receivedResumeA, receivedResumeB);
    assert.equal(receivedResumeA.revision, resumed.revision);
    assert.equal(receivedResumeA.planningEligible, true);
    assert.equal(replanCalls, 2);
  } finally {
    consoleA.close();
    consoleB.close();
    await server.close();
    await runtime.close();
  }

  const restoredRuntime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  try {
    const restored = restoredRuntime.getCatalogObject("item-identity", "pause-source");
    assert.equal(restored.disposition, "enabled");
    assert.deepEqual(restored.evidence, preserved.evidence);
    assert.deepEqual(restored.versions, preserved.versions);
    assert.deepEqual(restored.rulingHistory, preserved.rulingHistory);
    assert.equal(restored.transitions.some((transition) => transition.toDisposition === "paused"), true);
    assert.equal(restored.transitions.some((transition) => transition.toDisposition === "enabled"), true);
  } finally {
    await restoredRuntime.close();
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
