"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const localLibraries = "/tmp/playwright-libs/usr/lib/x86_64-linux-gnu";
if (fs.existsSync(localLibraries)) {
  process.env.LD_LIBRARY_PATH = `${localLibraries}:${process.env.LD_LIBRARY_PATH || ""}`;
}
const { chromium } = require("playwright");
const { AutomationRuntime } = require("../src/automation-runtime");
const { createControlServer } = require("../src/control-server");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", () => resolve(server.httpServer.address().port));
  });
}

function seedReviewCandidate(runtime, { objectId, name, level }) {
  let object = runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId: "review-chain", level, baseUnits: 2 ** (level - 1), name },
    sourceType: "structural-inference",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
  object = runtime.database.saveCatalogVersion({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId: "review-chain", level, baseUnits: 2 ** (level - 1), name },
    status: "provisional",
    origin: "inference-gate",
    expectedRevision: object.revision,
  });
  return object;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-browser-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  seedReviewCandidate(runtime, { objectId: "browser-next", name: "下一候选", level: 2 });
  let first = seedReviewCandidate(runtime, { objectId: "browser-first", name: "园艺手套", level: 1 });
  first = runtime.database.applyCatalogRuling({
    objectType: first.objectType,
    objectId: first.objectId,
    fieldPath: "chainId",
    decision: "modify",
    value: "旧人工合成链",
    actor: "历史操作者",
    note: "制造候选与生效值不同的浏览器夹具",
    expectedRevision: first.revision,
  });
  assert.notDeepEqual(first.effectiveValue, first.algorithmCandidate);
  runtime.catalogReviewReplanner = async () => ({
    status: "ready",
    recovered: true,
    boundaryReason: null,
    recommendedOrderSlot: "order-a",
  });
  runtime.dashboard = async () => ({
    connected: false,
    connectionError: "browser fixture",
    running: false,
    paused: false,
    state: runtime.lastState,
    plan: { status: "evidence-waiting", plans: [], evidenceBlocks: [], recommended: null },
    catalog: runtime.getCatalogView().stats,
    catalogView: runtime.getCatalogView({ includeRepositoryObjects: false }),
    actions: [],
    sessions: [],
    resourceSamples: [],
    connectionRoute: { listening: false, managed: false },
    runtimeControl: { mocked: true },
  });
  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  const browser = await chromium.launch({
    headless: true,
  });
  const page = await browser.newPage();
  let completionRequest = null;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/catalog/review/complete")) {
      completionRequest = request.postDataJSON();
    }
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    const firstQueueEntry = page.getByRole("button", { name: /疑似“园艺手套”/ });
    await firstQueueEntry.waitFor();
    await firstQueueEntry.click();

    await page.getByRole("heading", { name: "疑似“园艺手套”" }).waitFor();
    await page.getByText("为什么需要处理").waitFor();
    await page.getByText("本次将确认的完整候选").waitFor();
    await page.getByText("普通确认无需填写备注").waitFor();
    assert.equal(await page.getByText("完整对象 JSON").isVisible(), false);

    await page.getByRole("button", { name: "确认无误" }).click();
    await page.getByRole("status").filter({ hasText: "审核结论已保存，规划已经恢复" }).waitFor();
    await page.getByText("Catalog Audit Summary").waitFor();
    await page.getByText("规划已恢复").waitFor();
    await page.getByRole("heading", { name: "疑似“下一候选”" }).waitFor();

    assert.ok(completionRequest);
    assert.deepEqual(completionRequest.snapshot, first.algorithmCandidate);
    assert.equal(completionRequest.note, undefined);
    assert.equal(typeof completionRequest.requestId, "string");
    const replay = await page.evaluate(async (body) => {
      const response = await fetch("/api/catalog/review/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }, completionRequest);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: "browser-first" }).length, 1);
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectId: "browser-first" }).length, 1);
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectId: "browser-first" })[0].planningResult.recovered, true);

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    await page.getByRole("button", { name: /疑似“下一候选”/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /疑似“园艺手套”/ }).count(), 0);
    const restored = runtime.getCatalogObject("item-identity", "browser-first");
    assert.equal(restored.reviewStatus, "clear");
    assert.deepEqual(restored.effectiveValue, completionRequest.snapshot);
  } finally {
    await browser.close();
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.stdout.write("catalog review browser scenario passed\n"),
  (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  },
);
