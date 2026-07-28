"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationRuntime } = require("../src/automation-runtime");
const { IconEvidenceService } = require("../src/icon-evidence");

test("挂机自动化启动会先中断后台图标采集再读取首个状态", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-start-icon-priority-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  let iconOwnsRuntime = true;
  let interruptions = 0;
  let collected = false;

  runtime.iconService.interruptForAutomation = () => {
    interruptions += 1;
    iconOwnsRuntime = false;
    return 1;
  };
  runtime.connect = async () => {
    assert.equal(
      iconOwnsRuntime,
      false,
      "自动化首轮连接不应与仍在运行的截图图标采集竞争",
    );
  };
  runtime.collectState = async () => {
    collected = true;
    throw new Error("fixture-first-state-reached");
  };

  try {
    await assert.rejects(
      runtime.startIdle({ mode: "automatic" }),
      /fixture-first-state-reached/,
    );
    assert.equal(interruptions, 1);
    assert.equal(collected, true);
  } finally {
    runtime.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("后台挂机启动在返回已接受之前同步抢占图标采集", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-accept-icon-priority-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  let interruptions = 0;

  runtime.iconService.interruptForAutomation = () => {
    interruptions += 1;
    return 1;
  };
  runtime.startIdle = async () => ({ ok: true, reason: "fixture-complete" });

  try {
    const result = runtime.startIdleInBackground({ mode: "automatic" });
    assert.equal(result.accepted, true);
    assert.equal(
      interruptions,
      1,
      "启动请求被接受时，旧的截图图标任务应已收到中断",
    );
    await runtime.activeRunPromise;
  } finally {
    runtime.database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("自动化启动不会中断已下载的截图离线处理", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "interrupted-icon-event-"));
  const events = [];
  let safeBoundary = true;
  let releaseProcessing;
  let notifyProcessing;
  const processingStarted = new Promise((resolve) => {
    notifyProcessing = resolve;
  });
  const service = new IconEvidenceService({
    database: {
      listIconCandidates: () => [],
      saveIconCandidateWithDecision: () => ({
        candidate: { id: 1, sourceType: "screenshot-runtime" },
        decisionChange: null,
      }),
    },
    cacheDir,
    concurrency: 1,
    screenshotFrameDelayMs: 0,
    resolveSpriteFrame: async () => {
      throw new Error("SpriteFrame mapping unavailable");
    },
    resolveScreenshotBounds: async () => ({
      observedItemId: "item-1",
      visible: true,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      viewport: { width: 100, height: 100 },
      runtimeSource: "board-cell",
    }),
    captureScreenshot: async () => Buffer.from("frame"),
    processScreenshot: async () => {
      notifyProcessing();
      await new Promise((resolve) => {
        releaseProcessing = resolve;
      });
      return {
        crop: {
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          viewport: { width: 100, height: 100 },
          backgroundRemoval: { applied: true },
          runtimeSource: "board-cell",
        },
        similarity: {
          frameSelection: { acceptedFrameIndexes: [0, 1, 2] },
        },
        asset: {
          hash: "fixture-asset",
          mimeType: "image/png",
          width: 3,
          height: 4,
          byteSize: 5,
          filePath: path.join(cacheDir, "fixture.png"),
        },
      };
    },
    isSafeBoundary: () => safeBoundary,
    onEvent: (event) => events.push(event),
  });

  try {
    const queued = service.request("item-1");
    await processingStarted;
    safeBoundary = false;
    assert.equal(service.interruptForAutomation(), 0);
    releaseProcessing();
    await service.waitForIdle();

    assert.equal(service.getTask(queued.taskId).status, "complete");
    assert.equal(
      events.some((event) => event.type === "icon-acquisition-complete"),
      true,
    );
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
