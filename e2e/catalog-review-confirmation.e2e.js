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

function seedReviewCandidate(runtime, { objectId, name, level, type = null, chainId = "review-chain" }) {
  let object = runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId, level, baseUnits: 2 ** (level - 1), name, type },
    sourceType: "structural-inference",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
  object = runtime.database.saveCatalogVersion({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId, level, baseUnits: 2 ** (level - 1), name, type },
    status: "provisional",
    origin: "inference-gate",
    expectedRevision: object.revision,
  });
  return object;
}

function seedActiveIdentity(runtime, { objectId, name, level, chainId }) {
  runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, chainId, level, baseUnits: level == null ? null : 2 ** (level - 1), name, type: "花材" },
    sourceType: "runtime-capture",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
  return runtime.catalogGate.evaluateObject("item-identity", objectId);
}

function seedRelation(runtime, { objectId, level, mergeTarget, sourceType = "runtime-capture", chainId = "browser-flower-chain" }) {
  runtime.database.observeCatalogObject({
    objectType: "merge-relation",
    objectId,
    payload: { itemId: objectId, chainId, level, requiredCount: 2, mergeTarget },
    sourceType,
    sourceRef: `${objectId}-relation.json`,
    countDuplicate: false,
  });
  return runtime.catalogGate.evaluateObject("merge-relation", objectId);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-browser-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  runtime.saveSettings({ ...runtime.getSettings(), mode: "automatic" });
  for (const identity of [
    { objectId: "flower-1", name: "花苞", level: 1 },
    { objectId: "flower-2", name: "初绽花", level: 2 },
    { objectId: "flower-3", name: "盛放花", level: 3 },
    { objectId: "flower-5", name: "冠冕花", level: 5 },
    { objectId: "flower-6", name: "余香花", level: 6 },
    { objectId: "flower-7", name: "永恒花", level: 7 },
    { objectId: "flower-unknown", name: "待定花", level: null },
  ]) seedActiveIdentity(runtime, { ...identity, chainId: "browser-flower-chain" });
  seedRelation(runtime, { objectId: "flower-1", level: 1, mergeTarget: "flower-2" });
  const relationSnapshotBefore = seedRelation(runtime, {
    objectId: "flower-2",
    level: 2,
    mergeTarget: "flower-5",
    sourceType: "structural-inference",
  });
  seedRelation(runtime, { objectId: "flower-3", level: 3, mergeTarget: null });
  seedRelation(runtime, { objectId: "flower-5", level: 5, mergeTarget: null });
  seedActiveIdentity(runtime, { objectId: "waiting-source", name: "待结果花", level: 1, chainId: "waiting-chain" });
  seedReviewCandidate(runtime, { objectId: "waiting-target", name: "未见花", level: 2, chainId: "waiting-chain" });
  seedRelation(runtime, { objectId: "waiting-target", level: 2, mergeTarget: null, chainId: "waiting-chain" });
  seedRelation(runtime, {
    objectId: "waiting-source",
    level: 1,
    mergeTarget: "waiting-target",
    sourceType: "structural-inference",
    chainId: "waiting-chain",
  });
  seedActiveIdentity(runtime, { objectId: "conflict-source", name: "歧义花苞", level: 1, chainId: "conflict-chain" });
  seedReviewCandidate(runtime, { objectId: "predicted-target", name: "推测花", level: 2, chainId: "conflict-chain" });
  seedActiveIdentity(runtime, { objectId: "actual-target", name: "实见花", level: 2, chainId: "conflict-chain" });
  seedRelation(runtime, { objectId: "actual-target", level: 2, mergeTarget: null, chainId: "conflict-chain" });
  seedRelation(runtime, {
    objectId: "conflict-source",
    level: 1,
    mergeTarget: "predicted-target",
    sourceType: "structural-inference",
    chainId: "conflict-chain",
  });
  seedActiveIdentity(runtime, { objectId: "profile-producer", name: "园艺篮", level: 1, chainId: "profile-producer-chain" });
  seedActiveIdentity(runtime, { objectId: "profile-output-a", name: "晨露", level: 1, chainId: "profile-output-chain" });
  seedActiveIdentity(runtime, { objectId: "profile-output-b", name: "花粉", level: 2, chainId: "profile-output-chain" });
  seedRelation(runtime, { objectId: "profile-producer", level: 1, mergeTarget: null, chainId: "profile-producer-chain" });
  seedRelation(runtime, { objectId: "profile-output-a", level: 1, mergeTarget: "profile-output-b", chainId: "profile-output-chain" });
  seedRelation(runtime, { objectId: "profile-output-b", level: 2, mergeTarget: null, chainId: "profile-output-chain" });
  runtime.database.observeCatalogObject({
    objectType: "production-mode",
    objectId: "profile-producer:single",
    payload: {
      producerItemId: "profile-producer",
      modeId: "single",
      energyCost: 1,
      outputs: [
        { itemId: "profile-output-a", count: 1, probability: 1 },
        { itemId: "profile-output-b", count: 1, probability: 1 },
      ],
      unlocked: true,
      switchEntry: { status: "available", method: "setMultipleMode" },
    },
    sourceType: "runtime-capture",
    sourceRef: "profile-producer-single-mode.json",
    countDuplicate: false,
  });
  runtime.catalogGate.evaluateObject("production-mode", "profile-producer:single");
  runtime.database.upsertTheoreticalProductionDistribution({
    producerItemId: "profile-producer",
    modeId: "single",
    theoreticalDistribution: {
      configVersion: "cfg-browser-19",
      extractionSource: "runtime:browser-production-mode",
      outputsPerAction: 2,
      outcomes: [
        { itemId: "profile-output-a", weight: 3 },
        { itemId: "profile-output-b", weight: 1 },
      ],
    },
  });
  const editable = seedReviewCandidate(runtime, { objectId: "browser-edit", name: "旧名称", level: 2 });
  const advancedJsonEditable = seedReviewCandidate(runtime, {
    objectId: "browser-json-edit",
    name: "JSON 草稿对象",
    level: 4,
  });
  const draftRecoveryEditable = seedReviewCandidate(runtime, {
    objectId: "browser-draft-recovery",
    name: "草稿恢复对象",
    level: 2,
  });
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
  seedReviewCandidate(runtime, { objectId: "browser-after-next", name: "后续候选", level: 3 });
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
  let pausePreviewRelation = runtime.database.observeCatalogObject({
    objectType: "merge-relation",
    objectId: "browser-first",
    payload: { itemId: "browser-first", chainId: "review-chain", level: 1, requiredCount: 2, mergeTarget: "browser-next" },
    sourceType: "runtime-capture",
    sourceRef: "browser-first-pause-preview.json",
    countDuplicate: false,
  });
  pausePreviewRelation = runtime.database.saveCatalogVersion({
    objectType: "merge-relation",
    objectId: "browser-first",
    payload: pausePreviewRelation.algorithmCandidate,
    status: "active",
    origin: "user",
    expectedRevision: pausePreviewRelation.revision,
  });
  runtime.lastState = {
    ...runtime.lastState,
    orders: [
      { slot: "pause-order", items: [{ itemId: "browser-next", complete: false }] },
      { slot: "json-order", items: [{ itemId: advancedJsonEditable.objectId, complete: false }] },
    ],
  };
  let relatedConflictSeeded = false;
  runtime.catalogReviewReplanner = async ({ input }) => {
    if (input.objectId === editable.objectId) {
      return {
        status: "evidence-waiting",
        recovered: false,
        boundaryReason: "evidence-waiting",
        recommendedOrderSlot: null,
      };
    }
    if (input.objectId === "flower-2") {
      if (!relatedConflictSeeded) {
        runtime.database.observeCatalogObject({
          objectType: "item-identity",
          objectId: "flower-3",
          payload: {
            itemId: "flower-3",
            chainId: "browser-flower-chain",
            level: 3,
            baseUnits: 4,
            name: "盛放花新线索",
            type: "花材",
          },
          sourceType: "structural-inference",
          sourceRef: "flower-3-related-conflict.json",
          countDuplicate: false,
        });
        runtime.catalogGate.evaluateObject("item-identity", "flower-3");
        relatedConflictSeeded = true;
      }
      return {
        status: "evidence-waiting",
        recovered: false,
        boundaryReason: "evidence-waiting",
        recommendedOrderSlot: null,
        blockingReviewTarget: { objectType: "item-identity", objectId: "flower-3" },
      };
    }
    return {
      status: "ready",
      recovered: true,
      boundaryReason: null,
      recommendedOrderSlot: "order-a",
    };
  };
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
  const postRequests = [];
  page.on("request", (request) => {
    if (request.method() === "POST") postRequests.push(request.url());
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

    const skippedBefore = runtime.getCatalogObject("item-identity", first.objectId);
    const planningBeforeSkip = runtime.getPlanningCatalog();
    await page.getByText("高级诊断与证据处置").click();
    const dispositionPostsBeforePreview = postRequests.filter((url) => url.endsWith("/api/catalog/object/disposition")).length;
    await page.getByRole("button", { name: "预览暂停影响" }).click();
    const pauseDialog = page.getByRole("alertdialog", { name: "确认暂停对象" });
    await pauseDialog.getByRole("heading", { name: "暂停影响预览" }).waitFor();
    await pauseDialog.getByText(/1 个当前订单和 [1-9]\d* 条合成关系/).waitFor();
    await pauseDialog.getByText(/订单 pause-order/).waitFor();
    await pauseDialog.getByText(/园艺手套.*下一候选/).waitFor();
    assert.equal(postRequests.filter((url) => url.endsWith("/api/catalog/object/disposition")).length, dispositionPostsBeforePreview);
    await pauseDialog.getByRole("button", { name: "取消" }).click();
    assert.equal(await pauseDialog.count(), 0);
    assert.equal(runtime.getCatalogObject("item-identity", first.objectId).disposition, "enabled");

    await page.getByRole("button", { name: "预览暂停影响" }).click();
    await pauseDialog.getByRole("button", { name: "确认暂停对象" }).click();
    await page.getByRole("status").filter({ hasText: "对象已暂停并立即退出真实规划" }).waitFor();
    const pausedObject = runtime.getCatalogObject("item-identity", first.objectId);
    assert.equal(pausedObject.disposition, "paused");
    assert.equal(pausedObject.reviewStatus, skippedBefore.reviewStatus);
    assert.deepEqual(pausedObject.evidence, skippedBefore.evidence);
    assert.deepEqual(pausedObject.rulingHistory, skippedBefore.rulingHistory);
    assert.deepEqual(pausedObject.versions, skippedBefore.versions);
    assert.equal(pausedObject.revision, skippedBefore.revision + 1);
    await page.getByRole("button", { name: "恢复对象", exact: true }).click();
    await page.getByRole("status").filter({ hasText: /对象已恢复/ }).waitFor();
    const resumedObject = runtime.getCatalogObject("item-identity", first.objectId);
    assert.equal(resumedObject.disposition, "enabled");
    assert.equal(resumedObject.reviewStatus, skippedBefore.reviewStatus);
    assert.deepEqual(resumedObject.evidence, skippedBefore.evidence);
    assert.deepEqual(resumedObject.rulingHistory, skippedBefore.rulingHistory);
    assert.deepEqual(resumedObject.versions, skippedBefore.versions);
    assert.equal(resumedObject.revision, skippedBefore.revision + 2);

    await page.getByRole("button", { name: "暂时跳过" }).click();
    await page.getByRole("status").filter({ hasText: "已暂时跳过，本轮稍后再处理" }).waitFor();
    await page.getByRole("heading", { name: "疑似“下一候选”" }).waitFor();
    await page.getByRole("button", { name: /疑似“园艺手套”.*已跳过/ }).waitFor();
    const skippedAfter = runtime.getCatalogObject("item-identity", first.objectId);
    assert.equal(skippedAfter.revision, resumedObject.revision);
    assert.deepEqual(skippedAfter.activeVersion, resumedObject.activeVersion);
    assert.deepEqual(skippedAfter.effectiveValue, resumedObject.effectiveValue);
    assert.deepEqual(skippedAfter.evidence, resumedObject.evidence);
    assert.deepEqual(skippedAfter.reviewReasons, resumedObject.reviewReasons);
    const planningAfterSkip = runtime.getPlanningCatalog();
    const withoutRepositoryRevision = (item) => {
      const { repositoryRevision, ...domainItem } = item;
      return domainItem;
    };
    assert.deepEqual(planningAfterSkip.items.map(withoutRepositoryRevision), planningBeforeSkip.items.map(withoutRepositoryRevision));
    assert.deepEqual(planningAfterSkip.producers, planningBeforeSkip.producers);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: first.objectId }).length, 0);
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectId: first.objectId }).length, 0);

    await page.getByRole("button", { name: "确认无误" }).click();
    await page.getByRole("status").filter({ hasText: "审核结论已保存，规划已经恢复" }).waitFor();
    await page.getByRole("heading", { name: "疑似“后续候选”" }).waitFor();
    await page.getByRole("button", { name: /疑似“园艺手套”.*已跳过/ }).waitFor();
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: "browser-next" }).length, 1);

    await firstQueueEntry.click();
    await page.getByRole("heading", { name: "疑似“园艺手套”" }).waitFor();
    await page.getByRole("button", { name: "确认无误" }).click();
    await page.getByRole("status").filter({ hasText: "审核结论已保存，规划已经恢复" }).waitFor();
    await page.getByText("Catalog Audit Summary").first().waitFor();
    await page.getByText("规划已恢复").waitFor();
    await page.getByRole("heading", { name: "疑似“后续候选”" }).waitFor();

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
    await page.getByRole("button", { name: /疑似“后续候选”/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /疑似“下一候选”/ }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /疑似“园艺手套”/ }).count(), 0);
    const restored = runtime.getCatalogObject("item-identity", "browser-first");
    assert.equal(restored.reviewStatus, "clear");
    assert.deepEqual(restored.effectiveValue, confirmationRequest.snapshot);

    const advancedJsonEntry = page.getByRole("button", { name: /疑似“JSON 草稿对象”/ });
    await advancedJsonEntry.click();
    await page.getByRole("heading", { name: "疑似“JSON 草稿对象”" }).waitFor();
    await page.getByText("只读技术详情", { exact: true }).click();
    const readOnlyJson = page.getByRole("textbox", { name: "完整对象 JSON" });
    assert.equal(await readOnlyJson.isEditable(), false);
    assert.equal(await page.getByRole("textbox", { name: "高级 JSON 草稿" }).count(), 0);
    await page.getByRole("button", { name: "进入高级 JSON 编辑" }).click();
    const advancedJsonDraft = page.getByRole("textbox", { name: "高级 JSON 草稿" });
    const advancedBefore = runtime.getCatalogObject("item-identity", advancedJsonEditable.objectId);
    await advancedJsonDraft.fill("{");
    await page.getByRole("button", { name: "校验并预览影响" }).click();
    await page.getByRole("alert").filter({ hasText: /定位：JSON.*保留当前 JSON 草稿/ }).waitFor();
    assert.equal(await advancedJsonDraft.inputValue(), "{");
    assert.equal(runtime.getCatalogObject("item-identity", advancedJsonEditable.objectId).revision, advancedBefore.revision);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: advancedJsonEditable.objectId }).length, 0);

    const advancedSnapshot = {
      ...advancedBefore.algorithmCandidate,
      name: "JSON 完整快照",
      type: "高级诊断样本",
    };
    await advancedJsonDraft.fill(JSON.stringify(advancedSnapshot, null, 2));
    await page.getByRole("button", { name: "校验并预览影响" }).click();
    const advancedDialog = page.getByRole("alertdialog", { name: "确认高级 JSON 快照" });
    await advancedDialog.getByRole("heading", { name: "完整快照影响预览" }).waitFor();
    await advancedDialog.getByText(/名称.*JSON 草稿对象.*JSON 完整快照/).waitFor();
    await advancedDialog.getByText(/类型.*高级诊断样本/).waitFor();
    await advancedDialog.getByText(/1 个当前订单和 0 条合成关系/).waitFor();
    await advancedDialog.getByText(/订单 json-order/).waitFor();
    assert.equal(runtime.getCatalogObject("item-identity", advancedJsonEditable.objectId).revision, advancedBefore.revision);
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectId: advancedJsonEditable.objectId }).length, 0);
    await advancedDialog.getByRole("button", { name: "返回继续编辑" }).click();
    assert.equal(await advancedJsonDraft.inputValue(), JSON.stringify(advancedSnapshot, null, 2));
    await page.getByRole("button", { name: "校验并预览影响" }).click();
    await page.getByRole("alertdialog", { name: "确认高级 JSON 快照" }).getByRole("button", { name: "确认提交完整快照" }).click();
    await page.getByRole("status").filter({ hasText: "审核结论已保存，规划已经恢复" }).waitFor();
    const advancedRequest = completionRequests.at(-1);
    assert.equal(advancedRequest.decision, "modify");
    assert.deepEqual(advancedRequest.snapshot, advancedSnapshot);
    assert.deepEqual(runtime.getCatalogObject("item-identity", advancedJsonEditable.objectId).effectiveValue, advancedSnapshot);
    const advancedAudit = runtime.database.listCatalogAuditSummaries({ objectId: advancedJsonEditable.objectId }).at(-1);
    assert.deepEqual(advancedAudit.meaningfulDifferences.map((difference) => difference.fieldPath), ["name", "type"]);
    assert.equal(advancedAudit.planningResult.recovered, true);

    const draftRecoveryEntry = page.getByRole("button", { name: /疑似“草稿恢复对象”/ });
    await draftRecoveryEntry.click();
    await page.getByRole("heading", { name: "疑似“草稿恢复对象”" }).waitFor();
    const draftName = page.getByRole("textbox", { name: "名称", exact: true });
    await draftName.fill("第一次未提交草稿");
    await page.waitForFunction((objectKey) => {
      const drafts = JSON.parse(localStorage.getItem("catalog-review-local-drafts-v1") || "{}");
      return drafts[objectKey]?.identityDraft?.name === "第一次未提交草稿";
    }, `item-identity:${draftRecoveryEditable.objectId}`);

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    await page.getByRole("heading", { name: "疑似“草稿恢复对象”" }).waitFor();
    const firstRecoveryDialog = page.getByRole("alertdialog", { name: "恢复本地审核草稿" });
    await firstRecoveryDialog.getByText(/草稿基于 revision.*最新对象 revision/).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "名称", exact: true }).inputValue(), "草稿恢复对象");
    await firstRecoveryDialog.getByRole("button", { name: "放弃本地草稿" }).click();
    assert.equal(await page.getByRole("textbox", { name: "名称", exact: true }).inputValue(), "草稿恢复对象");
    assert.equal(await page.evaluate((objectKey) => {
      const drafts = JSON.parse(localStorage.getItem("catalog-review-local-drafts-v1") || "{}");
      return Object.hasOwn(drafts, objectKey);
    }, `item-identity:${draftRecoveryEditable.objectId}`), false);

    await page.getByRole("textbox", { name: "名称", exact: true }).fill("需要恢复的本地草稿");
    await page.waitForFunction((objectKey) => {
      const drafts = JSON.parse(localStorage.getItem("catalog-review-local-drafts-v1") || "{}");
      return drafts[objectKey]?.identityDraft?.name === "需要恢复的本地草稿";
    }, `item-identity:${draftRecoveryEditable.objectId}`);
    let externallyChanged = runtime.database.applyCatalogRuling({
      objectType: "item-identity",
      objectId: draftRecoveryEditable.objectId,
      fieldPath: "type",
      decision: "modify",
      value: "并发最新类型",
      actor: "控制台甲",
      note: "制造刷新后的草稿基线差异",
      expectedRevision: runtime.getCatalogObject("item-identity", draftRecoveryEditable.objectId).revision,
    });

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    await page.getByRole("heading", { name: "疑似“草稿恢复对象”" }).waitFor();
    const staleRecoveryDialog = page.getByRole("alertdialog", { name: "恢复本地审核草稿" });
    await staleRecoveryDialog.getByText(new RegExp(`草稿基于 revision.*最新对象 revision ${externallyChanged.revision}`)).waitFor();
    await staleRecoveryDialog.getByRole("button", { name: "恢复本地草稿" }).click();
    assert.equal(await page.getByRole("textbox", { name: "名称", exact: true }).inputValue(), "需要恢复的本地草稿");
    const restoredConflict = page.getByRole("alertdialog", { name: "重新确认 revision 冲突" });
    await restoredConflict.waitFor();
    const restoredConflictText = await restoredConflict.textContent();
    assert.match(restoredConflictText || "", /类型.*并发最新类型.*null/, `restored conflict=${restoredConflictText}`);
    await restoredConflict.getByRole("button", { name: "按最新版本重新确认" }).click();

    externallyChanged = runtime.database.applyCatalogRuling({
      objectType: "item-identity",
      objectId: draftRecoveryEditable.objectId,
      fieldPath: "type",
      decision: "modify",
      value: "第二并发类型",
      actor: "控制台乙",
      note: "制造提交时 revision 冲突",
      expectedRevision: externallyChanged.revision,
    });
    const detailScrollTop = await page.locator(".review-detail").evaluate((element) => {
      element.scrollTop = 180;
      return element.scrollTop;
    });
    const resolutionsBeforeConflict = runtime.database.listCatalogReviewResolutions({ objectId: draftRecoveryEditable.objectId }).length;
    await page.getByRole("button", { name: "修改后确认" }).click();
    const liveConflict = page.getByRole("alertdialog", { name: "重新确认 revision 冲突" });
    await liveConflict.getByText(new RegExp(`最新对象 revision ${externallyChanged.revision}`)).waitFor();
    await liveConflict.getByText(/名称.*草稿恢复对象.*需要恢复的本地草稿/).waitFor();
    await liveConflict.getByText(/类型.*第二并发类型.*null/).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "名称", exact: true }).inputValue(), "需要恢复的本地草稿");
    assert.equal(await page.locator(".review-detail").evaluate((element) => element.scrollTop), detailScrollTop);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: draftRecoveryEditable.objectId }).length, resolutionsBeforeConflict);
    await liveConflict.getByRole("button", { name: "按最新版本重新确认" }).click();
    let failPostCommitCatalogRefresh = true;
    await page.route("**/api/catalog", async (route) => {
      if (failPostCommitCatalogRefresh && route.request().method() === "GET") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "浏览器夹具目录刷新失败" }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "修改后确认" }).click();
    await page.getByRole("status").filter({ hasText: /审核结论已保存，规划已经恢复.*工作台刷新失败/ }).waitFor();
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectId: draftRecoveryEditable.objectId }).length, resolutionsBeforeConflict + 1);
    assert.equal(runtime.getCatalogObject("item-identity", draftRecoveryEditable.objectId).effectiveValue.name, "需要恢复的本地草稿");
    assert.equal(await page.evaluate((objectKey) => {
      const drafts = JSON.parse(localStorage.getItem("catalog-review-local-drafts-v1") || "{}");
      return Object.hasOwn(drafts, objectKey);
    }, `item-identity:${draftRecoveryEditable.objectId}`), false);
    assert.equal(await page.getByRole("status").filter({ hasText: "生效快照未改变" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /确认无误|修改后确认/ }).first().isDisabled(), true);
    await page.getByText("高级诊断与证据处置").click();
    await page.getByRole("button", { name: "预览暂停影响" }).click();
    await page.getByRole("button", { name: "重试刷新工作台" }).waitFor();
    await page.getByRole("alertdialog", { name: "确认暂停对象" }).getByRole("button", { name: "取消" }).click();
    await page.getByText("只读技术详情", { exact: true }).click();
    await page.getByRole("button", { name: "进入高级 JSON 编辑" }).click();
    await page.getByRole("button", { name: "校验并预览影响" }).click();
    const staleAdvancedDialog = page.getByRole("alertdialog", { name: "确认高级 JSON 快照" });
    assert.equal(await staleAdvancedDialog.getByRole("button", { name: "确认提交完整快照" }).isDisabled(), true);
    await staleAdvancedDialog.getByRole("button", { name: "返回继续编辑" }).click();
    failPostCommitCatalogRefresh = false;
    await page.getByRole("button", { name: "重试刷新工作台" }).click();
    await page.getByRole("status").filter({ hasText: "审核结论已保存，规划已经恢复" }).waitFor();
    await page.unroute("**/api/catalog");

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
    await page.getByRole("status").filter({ hasText: "裁决已保存、规划尚未恢复" }).waitFor();
    await page.getByText(/当前订单仍在等待图鉴证据.*已保留当前诊断上下文/).waitFor();
    await page.getByRole("heading", { name: "新名称" }).waitFor();

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

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    const relationEntry = page.getByRole("button", { name: /“初绽花”的合成关系.*合成关系/ });
    await relationEntry.click();
    await page.getByRole("heading", { name: "合成关系独立审核" }).waitFor();
    await page.getByText("切换关系只改变审核焦点；每个对象都需要独立审核。").waitFor();
    await page.getByRole("button", { name: "来源物 初绽花（第 2 级）", exact: true }).waitFor();
    assert.equal(await page.getByRole("spinbutton", { name: "所需数量" }).inputValue(), "2");
    await page.getByRole("region", { name: "完整横向合成链" }).getByText("未命名物品（第 4 级）").waitFor();
    await page.getByRole("region", { name: "完整横向合成链" }).getByRole("button", { name: "待定花（等级未知）" }).waitFor();
    await page.getByRole("region", { name: "完整横向合成链" }).getByText("链条断点").first().waitFor();
    await page.getByLabel("断点：余香花（第 6 级）到永恒花（第 7 级）").waitFor();
    await page.getByRole("button", { name: /当前焦点.*初绽花.*第 2 级/ }).waitFor();

    await page.getByRole("button", { name: /关系句结果物.*冠冕花.*第 5 级/ }).click();
    await page.getByRole("heading", { name: /冠冕花/ }).waitFor();
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectType: "merge-relation", objectId: "flower-2" }).length, 0);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectType: "item-identity", objectId: "flower-5" }).length, 0);

    await relationEntry.click();
    await page.getByRole("heading", { name: "合成关系独立审核" }).waitFor();
    await page.getByRole("button", { name: /选择结果物.*初绽花.*第 2 级/ }).click();
    await page.getByText(/自环.*初绽花.*不能合成为自身/).waitFor();
    assert.equal(await page.getByRole("button", { name: "修改后确认" }).isDisabled(), true);
    const relationAfterRejectedEdit = runtime.database.getCatalogObject("merge-relation", "flower-2");
    assert.equal(relationAfterRejectedEdit.revision, relationSnapshotBefore.revision);
    assert.deepEqual(relationAfterRejectedEdit.activeVersion, relationSnapshotBefore.activeVersion);
    assert.deepEqual(relationAfterRejectedEdit.candidateVersion, relationSnapshotBefore.candidateVersion);

    await page.getByRole("button", { name: /选择结果物.*盛放花.*第 3 级/ }).click();
    await page.getByText(/合成为.*盛放花/).waitFor();
    await page.getByRole("button", { name: "修改后确认" }).click();
    await page.getByRole("status").filter({ hasText: /裁决已保存、规划尚未恢复.*阻塞已转移到关联对象/ }).waitFor();
    await page.getByRole("heading", { name: /盛放花/ }).waitFor();
    const relationRequest = completionRequests.at(-1);
    assert.equal(relationRequest.objectType, "merge-relation");
    assert.equal(relationRequest.decision, "modify");
    assert.deepEqual(relationRequest.snapshot, {
      itemId: "flower-2",
      chainId: "browser-flower-chain",
      level: 2,
      requiredCount: 2,
      mergeTarget: "flower-3",
    });
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectType: "merge-relation", objectId: "flower-2" }).length, 1);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectType: "item-identity", objectId: "flower-3" }).length, 0);

    const waitingEntry = page.getByRole("button", { name: /“待结果花”的合成关系.*等待更多线索/ });
    await waitingEntry.click();
    await page.getByRole("heading", { name: "合成关系独立审核" }).waitFor();
    await page.getByText(/结果尚未真实出现.*正常订单推进/).first().waitFor();
    const readOnlyTarget = page.getByRole("textbox", { name: "结果物" });
    assert.equal(await readOnlyTarget.isEditable(), false);
    assert.equal(await page.getByRole("button", { name: "确认无误" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "修改后确认" }).count(), 0);
    const postCountBeforeReturn = postRequests.length;
    await page.getByRole("button", { name: "返回自动化继续收集" }).click();
    await page.getByRole("heading", { name: /当前棋盘/ }).waitFor();
    assert.equal(postRequests.length, postCountBeforeReturn);
    const waitingBeforeObservation = runtime.getCatalogObject("merge-relation", "waiting-source");
    assert.equal(waitingBeforeObservation.reviewStatus, "needs-review");
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectType: "merge-relation", objectId: "waiting-source" }).length, 0);

    runtime.queuePassiveCatalogEvidence({
      actionDiff: {
        type: "merge",
        itemId: "waiting-source",
        actualTarget: "waiting-target",
        verified: true,
      },
    });
    await runtime.passiveCatalogDrainPromise;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    assert.equal(await page.getByRole("button", { name: /“待结果花”的合成关系/ }).count(), 0);
    const waitingAfterObservation = runtime.getCatalogObject("merge-relation", "waiting-source");
    assert.equal(waitingAfterObservation.status, "active");
    assert.equal(waitingAfterObservation.reviewStatus, "clear");
    assert.equal(runtime.getCatalogObject("item-identity", "waiting-target").status, "active");
    assert.equal(runtime.database.listCatalogAuditSummaries({ objectType: "merge-relation", objectId: "waiting-source" }).length, 0);

    runtime.queuePassiveCatalogEvidence({
      actionDiff: {
        type: "merge",
        itemId: "conflict-source",
        actualTarget: "actual-target",
        verified: true,
      },
    });
    await runtime.passiveCatalogDrainPromise;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    const conflictEntry = page.getByRole("button", { name: /“歧义花苞”的合成关系.*需要处理/ });
    await conflictEntry.click();
    await page.getByRole("heading", { name: "合成关系独立审核" }).waitFor();
    await page.getByText(/不同来源.*含义.*核对/).waitFor();
    assert.equal(await page.getByRole("button", { name: /确认无误|修改后确认/ }).count(), 1);
    assert.equal(runtime.getCatalogObject("merge-relation", "conflict-source").reviewStatus, "needs-review");
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectType: "merge-relation", objectId: "conflict-source" }).length, 0);
    const conflictBeforeEvidenceAction = runtime.getCatalogObject("merge-relation", "conflict-source");
    await page.getByLabel("补充说明（选填）").fill("采用真实动作证据");
    await page.getByText("高级诊断与证据处置").click();
    const evidencePanel = page.locator(".review-evidence");
    const trustedEvidenceRow = evidencePanel.locator("p").filter({ hasText: "passive-action-diff" });
    await trustedEvidenceRow.getByRole("button", { name: "采用证据" }).click();
    await page.getByRole("status").filter({ hasText: /已采用该证据.*带入领域表单.*仍需确认完整对象/ }).waitFor();
    const actualTargetChoice = page.getByRole("button", { name: /选择结果物.*实见花.*第 2 级/ });
    assert.match(await actualTargetChoice.getAttribute("class"), /selected/);
    const afterEvidenceAcceptance = runtime.getCatalogObject("merge-relation", "conflict-source");
    assert.equal(afterEvidenceAcceptance.reviewStatus, "needs-review");
    assert.equal(afterEvidenceAcceptance.evidence.every((evidence) => evidence.disposition === "eligible"), true);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectType: "merge-relation", objectId: "conflict-source" }).length, 0);
    assert.equal(runtime.database.listCatalogReviewResolutions({ objectType: "item-identity", objectId: "actual-target" }).length, 0);
    assert.equal(runtime.database.listCatalogEvidenceAuditSummaries({ objectType: "merge-relation", objectId: "conflict-source" }).at(-1).action, "accept-evidence");
    await page.getByText(/已采用证据.*对象仍待完整确认/).first().waitFor();

    await page.getByLabel("补充说明（选填）").fill("旧推断与真实动作不符");
    if ((await page.locator("details.advanced-review-actions").getAttribute("open")) === null) {
      await page.getByText("高级诊断与证据处置").click();
    }
    const inferredEvidenceRow = evidencePanel.locator("p").filter({ hasText: "structural-inference" });
    const evidencePostsBeforeRejection = postRequests.filter((url) => url.endsWith("/api/catalog/evidence/disposition")).length;
    await inferredEvidenceRow.getByRole("button", { name: "否决证据" }).click();
    const rejectionDialog = page.getByRole("alertdialog", { name: "确认否决证据" });
    await rejectionDialog.getByRole("heading", { name: "否决影响预览" }).waitFor();
    await rejectionDialog.getByText(/证据来源.*structural-inference/).waitFor();
    await rejectionDialog.getByText(/后续自动推断及规划融合中排除/).waitFor();
    assert.equal(postRequests.filter((url) => url.endsWith("/api/catalog/evidence/disposition")).length, evidencePostsBeforeRejection);
    await rejectionDialog.getByRole("button", { name: "取消" }).click();
    assert.equal(runtime.getCatalogObject("merge-relation", "conflict-source").evidence.find((evidence) => evidence.sourceType === "structural-inference").disposition, "eligible");
    await inferredEvidenceRow.getByRole("button", { name: "否决证据" }).click();
    await rejectionDialog.getByRole("button", { name: "确认否决证据" }).click();
    await page.getByRole("status").filter({ hasText: /证据已否决.*自动推断及规划融合中排除/ }).waitFor();
    const afterEvidenceRejection = runtime.getCatalogObject("merge-relation", "conflict-source");
    const rejectedEvidence = afterEvidenceRejection.evidence.find((evidence) => evidence.sourceType === "structural-inference");
    assert.equal(rejectedEvidence.disposition, "rejected");
    assert.equal(rejectedEvidence.sourceRef, "conflict-source-relation.json");
    assert.deepEqual(rejectedEvidence.payload, conflictBeforeEvidenceAction.evidence.find((evidence) => evidence.sourceType === "structural-inference").payload);
    assert.deepEqual(runtime.database.listCatalogEvidenceAuditSummaries({ objectType: "merge-relation", objectId: "conflict-source" }).map((audit) => audit.action), [
      "accept-evidence",
      "reject-evidence",
    ]);
    await page.getByText(/已否决证据/).first().waitFor();

    runtime.queuePassiveCatalogEvidence({
      actionDiff: {
        actionId: "browser-production-auto-1",
        type: "produce",
        verified: true,
        attributable: true,
        producerItemId: "profile-producer",
        productionModeId: "single",
        actualOutputItemIds: ["profile-output-a", "profile-output-b"],
      },
    });
    await runtime.passiveCatalogDrainPromise;
    const adoptedProfile = runtime.getCatalogObject("production-profile", "profile-producer");
    assert.equal(adoptedProfile.status, "active");
    assert.equal(adoptedProfile.reviewStatus, "clear");
    assert.deepEqual(adoptedProfile.activeVersion.payload, {
      producerItemId: "profile-producer",
      candidateOutputs: ["profile-output-a", "profile-output-b"],
      productionModes: ["single"],
    });
    assert.equal(runtime.database.getCatalogReviewQueue().some((entry) =>
      entry.objectType === "production-profile" && entry.objectId === "profile-producer"), false);
    assert.equal(runtime.database.listCatalogAuditSummaries({
      objectType: "production-profile",
      objectId: "profile-producer",
    }).length, 0);
    const planningBeforeAttributionConflict = runtime.database.getProductionDistribution(
      "profile-producer",
      "single",
      { executionMode: "automatic" },
    );

    runtime.queuePassiveCatalogEvidence({
      actionDiff: {
        actionId: "browser-production-conflict-1",
        type: "produce",
        verified: true,
        attributable: false,
        producerItemId: "profile-producer",
        productionModeId: "single",
        actualOutputItemIds: ["profile-output-b"],
        attributionConflict: {
          candidateProducerItemIds: ["profile-producer", "other-producer"],
          sourceRefs: ["board-grid:4", "action-baseline:producer"],
        },
      },
    });
    await runtime.passiveCatalogDrainPromise;
    const planningAfterAttributionConflict = runtime.database.getProductionDistribution(
      "profile-producer",
      "single",
      { executionMode: "automatic" },
    );
    assert.equal(planningAfterAttributionConflict.observedDistribution.sampleSize, 1);
    assert.deepEqual(planningAfterAttributionConflict.planningDistribution, planningBeforeAttributionConflict.planningDistribution);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();
    const profileEntry = page.getByRole("button", { name: /“园艺篮”的产出档案.*需要处理/ });
    await profileEntry.click();
    await page.getByRole("heading", { name: "产出档案", exact: true }).waitFor();
    await page.getByText(/产出动作.*来源.*归因.*互相矛盾/).waitFor();
    const profilePanel = page.getByRole("region", { name: "产出档案内容" });
    await profilePanel.getByText("所属产出物", { exact: true }).waitFor();
    await profilePanel.getByText("园艺篮（第 1 级）").waitFor();
    await profilePanel.getByText("候选产物集合", { exact: true }).first().waitFor();
    await profilePanel.getByText("晨露（第 1 级）").waitFor();
    await profilePanel.getByText("花粉（第 2 级）").waitFor();
    await profilePanel.getByText("可用产出档位", { exact: true }).first().waitFor();
    await profilePanel.getByText("single", { exact: true }).waitFor();
    assert.equal(await profilePanel.getByText("体力消耗", { exact: true }).count(), 0);
    assert.equal(await profilePanel.getByText("理论产出分布", { exact: true }).count(), 0);
    assert.equal(await profilePanel.getByText("真实观测分布", { exact: true }).count(), 0);
    await profilePanel.getByText("single", { exact: true }).click();
    await page.getByRole("heading", { name: "产出档位", exact: true }).waitFor();
    const modePanel = page.getByRole("region", { name: "产出档位分布" });
    await modePanel.getByText("单次体力 1").waitFor();
    await modePanel.getByRole("heading", { name: "理论产出分布" }).waitFor();
    await modePanel.getByText("cfg-browser-19").waitFor();
    await modePanel.getByText("runtime:browser-production-mode").waitFor();
    await modePanel.getByRole("heading", { name: "真实观测分布" }).waitFor();
    await modePanel.getByText("样本量 1 次动作 · 实见产物 2 个").waitFor();
    await modePanel.getByText(/晨露.*1 个/).waitFor();
    await modePanel.getByText(/花粉.*1 个/).waitFor();
    await modePanel.getByText(/低样本.*仍在积累/).waitFor();
    await modePanel.getByRole("heading", { name: "规划采用分布" }).waitFor();
    await modePanel.getByText("保守可行性").waitFor();
    await modePanel.getByText(/未见产物余量/).waitFor();
    assert.equal(await modePanel.locator("input").count(), 0);
    await profileEntry.click();
    await page.getByRole("heading", { name: "产出档案", exact: true }).waitFor();
    const profileBeforeReview = runtime.getCatalogObject("production-profile", "profile-producer");
    await page.getByRole("button", { name: "确认无误" }).click();
    await page.getByRole("status").filter({ hasText: "审核结论已保存，规划已经恢复" }).waitFor();
    const profileReviewRequest = completionRequests.at(-1);
    assert.equal(profileReviewRequest.objectType, "production-profile");
    assert.deepEqual(profileReviewRequest.snapshot, profileBeforeReview.activeVersion.payload);
    assert.equal(runtime.getCatalogObject("production-profile", "profile-producer").reviewStatus, "clear");
    assert.equal(runtime.database.listCatalogReviewResolutions({
      objectType: "production-profile",
      objectId: "profile-producer",
    }).length, 1);
    assert.equal(runtime.database.listCatalogAuditSummaries({
      objectType: "production-profile",
      objectId: "profile-producer",
    }).length, 1);
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
