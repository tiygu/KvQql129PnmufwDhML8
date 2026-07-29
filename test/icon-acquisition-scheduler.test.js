"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { IconEvidenceService, runIconWorker } = require("../src/icon-evidence");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeDatabase() {
  let candidateId = 0;
  return {
    findIconAcquisition: () => null,
    getIconAsset: () => null,
    listIconCandidates: () => [],
    saveIconCandidateWithDecision: ({ itemId, asset, sourceType }) => ({
      candidate: {
        id: ++candidateId,
        itemId,
        assetHash: asset.hash,
        sourceType,
      },
      decisionChange: null,
    }),
  };
}

function serviceFixture(options = {}) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-scheduler-"));
  let assetId = 0;
  const service = new IconEvidenceService({
    database: fakeDatabase(),
    cacheDir,
    resolveSpriteFrame: async ({ itemId }) => ({
      runtimeIdentifier: itemId,
      resourceUrl: `fixture://${itemId}`,
      mimeType: "image/png",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      originalSize: { width: 1, height: 1 },
      offset: { x: 0, y: 0 },
    }),
    readResource: async ({ resourceUrl }) => ({
      body: Buffer.from(resourceUrl),
      mimeType: "image/png",
      resolvedUrl: resourceUrl,
    }),
    processImage: async () => ({
      hash: String(++assetId).padStart(64, "0"),
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteSize: 1,
      filePath: path.join(cacheDir, `${assetId}.png`),
    }),
    ...options,
  });
  return {
    service,
    cleanup: () => fs.rmSync(cacheDir, { recursive: true, force: true }),
  };
}

test("runtime acquisition is single-slot while offline processing defaults to two and clamps at four", async () => {
  let runtimeActive = 0;
  let runtimeMaximum = 0;
  let offlineActive = 0;
  let offlineMaximum = 0;
  const runtimeGate = deferred();
  const offlineGate = deferred();
  const { service, cleanup } = serviceFixture({
    concurrency: 99,
    readResource: async ({ resourceUrl }) => {
      runtimeActive += 1;
      runtimeMaximum = Math.max(runtimeMaximum, runtimeActive);
      await runtimeGate.promise;
      runtimeActive -= 1;
      return {
        body: Buffer.from(resourceUrl),
        mimeType: "image/png",
        resolvedUrl: resourceUrl,
      };
    },
    processImage: async ({ metadata }) => {
      offlineActive += 1;
      offlineMaximum = Math.max(offlineMaximum, offlineActive);
      await offlineGate.promise;
      offlineActive -= 1;
      return {
        hash: String(metadata.runtimeIdentifier).padStart(64, "0"),
        mimeType: "image/png",
        width: 1,
        height: 1,
        byteSize: 1,
        filePath: path.join(os.tmpdir(), `${metadata.runtimeIdentifier}.png`),
      };
    },
  });

  try {
    for (let index = 1; index <= 8; index += 1) {
      service.request(String(index), { parentTaskId: `parent-${index}` });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtimeMaximum, 1);

    runtimeGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(runtimeMaximum, 1);
    assert.equal(offlineMaximum, 4);

    offlineGate.resolve();
    await service.waitForIdle();
  } finally {
    cleanup();
  }

  const defaults = serviceFixture();
  try {
    assert.equal(defaults.service.runtimeConcurrency, 1);
    assert.equal(defaults.service.offlineConcurrency, 2);
    assert.equal(defaults.service.softQueueLimit, 100);
    assert.equal(defaults.service.hardQueueLimit, 1000);
  } finally {
    defaults.cleanup();
  }
});

test("parent queues advance round-robin and shared in-flight items consume one queue entry", async () => {
  const order = [];
  const firstParentGate = deferred();
  const { service, cleanup } = serviceFixture({
    concurrency: 1,
    resolveSpriteFrame: async ({ itemId }) => {
      order.push(itemId);
      if (itemId === "a1") await firstParentGate.promise;
      return {
        runtimeIdentifier: itemId,
        resourceUrl: `fixture://${itemId}`,
        mimeType: "image/png",
        rect: { x: 0, y: 0, width: 1, height: 1 },
        originalSize: { width: 1, height: 1 },
        offset: { x: 0, y: 0 },
      };
    },
    queueLimit: 4,
  });

  try {
    service.request("a1", { parentTaskId: "large-parent" });
    service.request("a2", { parentTaskId: "large-parent" });
    service.request("a3", { parentTaskId: "large-parent" });
    await new Promise((resolve) => setImmediate(resolve));
    const firstShared = service.request("shared", { parentTaskId: "single-parent" });
    const secondShared = service.request("shared", { parentTaskId: "large-parent" });
    assert.equal(secondShared.taskId, firstShared.taskId);
    assert.equal(secondShared.shared, true);
    assert.throws(
      () => service.request("overflow", { parentTaskId: "single-parent" }),
      (error) => error.code === "ICON_ACQUISITION_QUEUE_SOFT_LIMIT"
        && error.reason === "queue-soft-capacity",
    );

    firstParentGate.resolve();
    await service.waitForIdle();
    assert.deepEqual(order, ["a1", "shared", "a2", "a3"]);
  } finally {
    cleanup();
  }
});

test("soft queue pressure can defer background work but the hard queue limit is absolute", () => {
  const { service, cleanup } = serviceFixture({
    queueLimit: 4,
    hardQueueLimit: 5,
    isSafeBoundary: () => false,
  });

  try {
    for (let index = 1; index <= 4; index += 1) {
      service.request(`soft-${index}`);
    }
    assert.throws(
      () => service.request("background-deferred"),
      (error) => error.code === "ICON_ACQUISITION_QUEUE_SOFT_LIMIT",
    );
    assert.equal(
      service.request("operator-priority", { allowSoftOverflow: true }).status,
      "queued",
    );
    assert.throws(
      () => service.request("hard-rejected", { allowSoftOverflow: true }),
      (error) => error.code === "ICON_ACQUISITION_QUEUE_HARD_LIMIT"
        && error.reason === "queue-hard-capacity",
    );
  } finally {
    cleanup();
  }
});

test("runtime-busy work remains queued with a stable reason and resumes at a safe boundary", async () => {
  let safe = false;
  const { service, cleanup } = serviceFixture({
    isSafeBoundary: () => safe,
  });

  try {
    const queued = service.request("busy", { parentTaskId: "job-busy" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      {
        status: service.getTask(queued.taskId).status,
        stage: service.getTask(queued.taskId).stage,
        reason: service.getTask(queued.taskId).reason,
      },
      {
        status: "queued",
        stage: "waiting-for-runtime-slot",
        reason: "automation-runtime-busy",
      },
    );

    safe = true;
    service.notifySafeBoundary();
    await service.waitForIdle();
    assert.equal(service.getTask(queued.taskId).status, "complete");
  } finally {
    cleanup();
  }
});

test("automation preempts runtime acquisition but downloaded offline bytes continue to commit", async () => {
  const processing = deferred();
  const processingStarted = deferred();
  let safe = true;
  const { service, cleanup } = serviceFixture({
    isSafeBoundary: () => safe,
    processImage: async () => {
      processingStarted.resolve();
      await processing.promise;
      return {
        hash: "f".repeat(64),
        mimeType: "image/png",
        width: 1,
        height: 1,
        byteSize: 1,
        filePath: path.join(os.tmpdir(), "offline-continues.png"),
      };
    },
  });

  try {
    const queued = service.request("offline");
    await processingStarted.promise;
    await service.waitForRuntimeIdle();
    assert.equal(service.getTask(queued.taskId).phase, "offline");
    safe = false;
    assert.equal(service.interruptForAutomation(), 0);
    processing.resolve();
    await service.waitForIdle();
    assert.equal(service.getTask(queued.taskId).status, "complete");
  } finally {
    cleanup();
  }
});

test("screenshot fallback never captures a target outside the current viewport", async () => {
  let captures = 0;
  const { service, cleanup } = serviceFixture({
    resolveSpriteFrame: async () => {
      throw new Error("SpriteFrame mapping unavailable");
    },
    resolveScreenshotBounds: async ({ itemId }) => ({
      observedItemId: itemId,
      visible: true,
      bounds: { x: 95, y: 10, width: 20, height: 20 },
      viewport: { width: 100, height: 100 },
      runtimeSource: "board-cell",
    }),
    captureScreenshot: async () => {
      captures += 1;
      return Buffer.from("must-not-capture");
    },
  });

  try {
    const queued = service.request("not-visible");
    await service.waitForIdle();
    const task = service.getTask(queued.taskId);
    assert.equal(task.status, "error");
    assert.equal(task.code, "ICON_SCREENSHOT_TARGET_NOT_VISIBLE");
    assert.equal(task.reason, "screenshot-target-not-visible");
    assert.equal(captures, 0);
  } finally {
    cleanup();
  }
});

test("screenshot fallback requires an explicit current-visibility observation", async () => {
  let captures = 0;
  const { service, cleanup } = serviceFixture({
    resolveSpriteFrame: async () => {
      throw new Error("SpriteFrame mapping unavailable");
    },
    resolveScreenshotBounds: async ({ itemId }) => ({
      observedItemId: itemId,
      bounds: { x: 10, y: 10, width: 20, height: 20 },
      viewport: { width: 100, height: 100 },
      runtimeSource: "board-cell",
    }),
    captureScreenshot: async () => {
      captures += 1;
      return Buffer.from("must-not-capture");
    },
  });

  try {
    const queued = service.request("visibility-unknown");
    await service.waitForIdle();
    assert.equal(service.getTask(queued.taskId).reason, "screenshot-target-not-visible");
    assert.equal(captures, 0);
  } finally {
    cleanup();
  }
});

test("each acquisition stage reports its own deadline and measured duration", async () => {
  const events = [];
  const { service, cleanup } = serviceFixture({
    stageDeadlines: {
      resolve: 50,
      download: 80,
      process: 120,
      commit: 40,
    },
    onEvent: (event) => events.push(event),
  });

  try {
    const queued = service.request("timed");
    await service.waitForIdle();
    const task = service.getTask(queued.taskId);
    assert.equal(task.status, "complete");
    assert.deepEqual(
      task.timings.map(({ stage, deadlineMs }) => [stage, deadlineMs]),
      [
        ["resolve-runtime-resource", 50],
        ["download-runtime-resource", 80],
        ["process-image-bytes", 120],
        ["commit-icon-evidence", 40],
      ],
    );
    assert.equal(
      task.timings.every((timing) => Number.isFinite(timing.durationMs)
        && timing.durationMs >= 0
        && timing.startedAt
        && timing.completedAt),
      true,
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "icon-acquisition-stage-complete")
        .map(({ stage, deadlineMs }) => [stage, deadlineMs]),
      task.timings.map(({ stage, deadlineMs }) => [stage, deadlineMs]),
    );
  } finally {
    cleanup();
  }
});

test("stage deadline failures identify the real stage instead of reporting a uniform timeout", async () => {
  const { service, cleanup } = serviceFixture({
    stageDeadlines: { resolve: 10 },
    resolveSpriteFrame: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });

  try {
    const queued = service.request("timeout");
    await service.waitForIdle();
    const task = service.getTask(queued.taskId);
    assert.equal(task.status, "error");
    assert.equal(task.code, "ICON_ACQUISITION_STAGE_TIMEOUT");
    assert.equal(task.reason, "stage-deadline-exceeded");
    assert.equal(task.technicalDetails.stage, "resolve-runtime-resource");
    assert.equal(task.technicalDetails.deadlineMs, 10);
    assert.equal(task.timings[0].status, "timed-out");
    assert.ok(task.timings[0].durationMs >= 5);
  } finally {
    cleanup();
  }
});

test("a timed-out offline operation retains its worker slot until abort cleanup settles", async () => {
  const cleanupGate = deferred();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const { service, cleanup } = serviceFixture({
    concurrency: 1,
    stageDeadlines: { process: 10 },
    processImage: async ({ metadata, signal }) => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      if (metadata.runtimeIdentifier === "first") {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", async () => {
            await cleanupGate.promise;
            active -= 1;
            reject(signal.reason);
          }, { once: true });
        });
      }
      active -= 1;
      return {
        hash: String(metadata.runtimeIdentifier).padStart(64, "0"),
        mimeType: "image/png",
        width: 1,
        height: 1,
        byteSize: 1,
        filePath: path.join(os.tmpdir(), `${metadata.runtimeIdentifier}.png`),
      };
    },
  });

  try {
    const first = service.request("first", { parentTaskId: "parent-a" });
    const second = service.request("second", { parentTaskId: "parent-b" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.getTask(first.taskId).status, "running");
    assert.equal(service.getTask(second.taskId).status, "queued");
    assert.equal(calls, 1);

    cleanupGate.resolve();
    await service.waitForIdle();
    const firstTask = service.getTask(first.taskId);
    assert.equal(firstTask.status, "error");
    assert.ok(firstTask.timings.at(-1).durationMs >= 20);
    assert.ok(firstTask.timings.at(-1).completedAt);
    assert.equal(service.getTask(second.taskId).status, "complete");
    assert.equal(maximum, 1);
  } finally {
    cleanupGate.resolve();
    cleanup();
  }
});

test("worker abort waits for thread termination before releasing its operation", async () => {
  const termination = deferred();
  const worker = new EventEmitter();
  worker.terminate = () => termination.promise;
  const controller = new AbortController();
  const reason = Object.assign(new Error("deadline"), {
    code: "ICON_ACQUISITION_STAGE_TIMEOUT",
  });
  let settled = false;
  const operation = runIconWorker(
    { operation: "fixture" },
    controller.signal,
    () => worker,
  ).finally(() => {
    settled = true;
  });

  controller.abort(reason);
  worker.emit("exit", 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  termination.resolve(1);
  await assert.rejects(operation, (error) => error === reason);
  assert.equal(settled, true);
});

test("shared in-flight acquisition stops only after its final subscriber cancels", async () => {
  const events = [];
  const { service, cleanup } = serviceFixture({
    isSafeBoundary: () => false,
    onEvent: (event) => events.push(event),
  });

  try {
    const first = service.request("shared-item", { parentTaskId: "job-a" });
    const second = service.request("shared-item", { parentTaskId: "job-b" });
    assert.equal(second.taskId, first.taskId);
    assert.equal(second.shared, true);
    assert.equal(service.getTask(first.taskId).subscriberCount, 2);

    const firstCancellation = service.cancelSubscription(first.taskId, "job-a");
    assert.deepEqual(firstCancellation, {
      cancelled: false,
      remainingSubscribers: 1,
      taskId: first.taskId,
    });
    assert.equal(service.getTask(first.taskId).status, "queued");
    assert.equal(
      events.filter((event) => event.type === "icon-acquisition-cancelled").length,
      0,
    );

    const finalCancellation = service.cancelSubscription(first.taskId, "job-b");
    assert.deepEqual(finalCancellation, {
      cancelled: true,
      remainingSubscribers: 0,
      taskId: first.taskId,
    });
    assert.equal(service.getTask(first.taskId).status, "cancelled");
    assert.equal(
      events.filter((event) => event.type === "icon-acquisition-cancelled").length,
      1,
    );
    await service.waitForIdle();
  } finally {
    cleanup();
  }
});

test("the final shared subscriber aborts an active runtime acquisition", async () => {
  let aborted = false;
  const { service, cleanup } = serviceFixture({
    resolveSpriteFrame: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });

  try {
    const first = service.request("active-shared-item", { parentTaskId: "job-a" });
    service.request("active-shared-item", { parentTaskId: "job-b" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.getTask(first.taskId).status, "running");

    service.cancelSubscription(first.taskId, "job-a");
    assert.equal(service.getTask(first.taskId).status, "running");
    service.cancelSubscription(first.taskId, "job-b");
    await service.waitForIdle();

    assert.equal(aborted, true);
    assert.equal(service.getTask(first.taskId).status, "cancelled");
  } finally {
    cleanup();
  }
});
