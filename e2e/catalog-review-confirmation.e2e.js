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

function seedReviewCandidate(runtime, { objectId, name, level, type = null }) {
  let object = runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId: "review-chain", level, baseUnits: 2 ** (level - 1), name, type },
    sourceType: "structural-inference",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
  object = runtime.database.saveCatalogVersion({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId: "review-chain", level, baseUnits: 2 ** (level - 1), name, type },
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
  const editable = seedReviewCandidate(runtime, { objectId: "browser-edit", name: "旧名称", level: 2 });
  runtime.database.observeCatalogObject({
    objectType: "merge-relation",
    objectId: editable.objectId,
    payload: { itemId: editable.objectId, chainId: "review-chain", level: 2, mergeTarget: "browser-next" },
    sourceType: "structural-inference",
    sourceRef: "browser-edit-relation.json",
    countDuplicate: false,
  });
  const relationBefore = runtime.catalogGate.evaluateObject("merge-relation", editable.objectId);
  const iconFile = path.join(dataDir, "browser-edit-icon.png");
  fs.writeFileSync(iconFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R3v7WQAAAABJRU5ErkJggg==", "base64"));
  const editableIcon = runtime.database.saveIconCandidate({
    itemId: editable.objectId,
    cacheKey: "browser-edit-real-icon",
    sourceType: "screenshot-runtime",
    crop: { fixture: "browser" },
    similarity: { composite: 0.92 },
    rankScore: 0.92,
    autoSelect: false,
    asset: {
      hash: "a".repeat(64),
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteSize: fs.statSync(iconFile).size,
      filePath: iconFile,
    },
  });
  seedReviewCandidate(runtime, { objectId: "browser-next", name: "下一候选", level: 2 });
  let first = seedReviewCandidate(runtime, { objectId: "browser-first", name: "园艺手套", level: 1 });
  runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "browser-later",
    payload: { itemId: "browser-later", chainId: "review-chain", level: 3, baseUnits: 4, name: "候补图标" },
    sourceType: "runtime-capture",
    sourceRef: "browser-later.json",
    countDuplicate: false,
  });
  runtime.catalogGate.evaluateObject("item-identity", "browser-later");
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
  const completionRequests = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/catalog/review/complete")) {
      completionRequests.push(request.postDataJSON());
    }
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    await page.getByText("以后再看", { exact: true }).click();
    const laterEntry = page.getByRole("button", { name: /疑似“候补图标”/ });
    await laterEntry.click();
    await page.getByRole("heading", { name: "疑似“候补图标”" }).waitFor();
    await page.getByText("不影响当前规划", { exact: false }).first().waitFor();

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

    const confirmationRequest = completionRequests.at(-1);
    assert.ok(confirmationRequest);
    assert.deepEqual(confirmationRequest.snapshot, first.algorithmCandidate);
    assert.equal(confirmationRequest.note, undefined);
    assert.equal(typeof confirmationRequest.requestId, "string");
    const replay = await page.evaluate(async (body) => {
      const response = await fetch("/api/catalog/review/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }, confirmationRequest);
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
    assert.deepEqual(restored.effectiveValue, confirmationRequest.snapshot);

    const editableEntry = page.getByRole("button", { name: /疑似“旧名称”/ });
    await editableEntry.click();
    await page.getByRole("heading", { name: "疑似“旧名称”" }).waitFor();
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("新名称");
    await page.getByRole("textbox", { name: "类型", exact: true }).fill("园艺工具");
    await page.getByRole("textbox", { name: "等级", exact: true }).fill("-1");
    await page.getByText("等级必须是正整数或留空表示未知").waitFor();
    assert.equal(await page.getByRole("button", { name: "修改后确认" }).isDisabled(), true);
    await page.getByRole("textbox", { name: "等级", exact: true }).fill("3");
    await page.getByRole("button", { name: "选择候选" }).click();
    await page.getByRole("button", { name: /当前选择/ }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "名称", exact: true }).inputValue(), "新名称");
    assert.equal(await page.getByRole("textbox", { name: "等级", exact: true }).inputValue(), "3");
    assert.equal(await page.getByRole("textbox", { name: "类型", exact: true }).inputValue(), "园艺工具");
    assert.equal(await page.getByRole("button", { name: "确认无误" }).count(), 0);
    await page.getByRole("button", { name: "修改后确认" }).click();
    await page.getByRole("status").filter({ hasText: "审核结论已保存" }).waitFor();

    const modificationRequest = completionRequests.at(-1);
    assert.equal(modificationRequest.decision, "modify");
    assert.equal(modificationRequest.note, undefined);
    assert.equal(modificationRequest.snapshot.name, "新名称");
    assert.equal(modificationRequest.snapshot.level, 3);
    assert.equal(modificationRequest.snapshot.type, "园艺工具");
    assert.deepEqual(modificationRequest.snapshot.displayIcon, {
      candidateId: editableIcon.id,
      assetHash: editableIcon.assetHash,
    });
    const modifiedAudit = runtime.database.listCatalogAuditSummaries({ objectId: editable.objectId }).at(-1);
    assert.equal(modifiedAudit.optionalNote, "系统生成：修改后确认完整候选快照");
    assert.deepEqual(modifiedAudit.meaningfulDifferences.map((difference) => difference.fieldPath), [
      "displayIcon",
      "level",
      "name",
      "type",
    ]);
    assert.equal(
      runtime.database.getCatalogObject("item-identity", editable.objectId).iconSelectionHistory.at(-1).note,
      "手动选择图标候选",
    );
    const relationAfter = runtime.database.getCatalogObject("merge-relation", editable.objectId);
    assert.equal(relationAfter.revision, relationBefore.revision);
    assert.equal(relationAfter.status, relationBefore.status);
    assert.equal(runtime.database.listCatalogReviewResolutions({
      objectType: "merge-relation",
      objectId: editable.objectId,
    }).length, 0);
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
