"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");
const { CatalogReviewGate } = require("../src/catalog-review-gate");
const { CatalogReviewOperator } = require("../src/catalog-review-operator");

async function withOperator(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-operator-"));
  const database = new AutomationDatabase(path.join(root, "catalog.db"));
  const catalogGate = new CatalogReviewGate(database);
  const context = {
    state: {
      schemaVersion: 1,
      scene: "board",
      resources: { energy: 10 },
      board: { signature: "empty", empty: 9, grids: [], mergeCandidates: [] },
      orders: [],
    },
    catalog: { coverage: {}, items: [], producers: [], evidence: { objects: [] } },
    publishedPlans: [],
    invalidations: 0,
    events: [],
  };
  const operator = new CatalogReviewOperator({
    database,
    catalogGate,
    getSettings: () => ({
      mode: "assisted",
      strategy: "efficiency",
      prioritySlot: null,
      salePolicy: { automaticEnabled: false, rules: [] },
    }),
    getState: () => context.state,
    getPlanningCatalog: () => context.catalog,
    publishPlan: (plan) => context.publishedPlans.push(plan),
    invalidateCatalogView: () => { context.invalidations += 1; },
    onEvent: (type, payload) => context.events.push({ type, payload }),
  });
  try {
    return await run({ database, catalogGate, operator, context });
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function provisionalIdentity(database, catalogGate, objectId, level = 1) {
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: {
      itemId: objectId,
      chainId: "review-chain",
      level,
      baseUnits: 2 ** (level - 1),
      descriptionKey: `候选物品 ${level}`,
    },
    sourceType: "structural-inference",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
  return catalogGate.evaluateObject("item-identity", objectId);
}

function activeIdentity(database, catalogGate, objectId, level = 1) {
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: {
      itemId: objectId,
      chainId: "active-chain",
      level,
      baseUnits: 2 ** (level - 1),
      name: `生效物品 ${level}`,
    },
    sourceType: "runtime-capture",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
  return catalogGate.evaluateObject("item-identity", objectId);
}

test("CatalogReviewOperator 源码与连接和 CDP 生命周期保持隔离", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "catalog-review-operator.js"), "utf8");
  assert.doesNotMatch(source, /ConnectionService|AdapterLab|\.connect\s*\(|CDP/i);
});

test("CatalogReviewOperator 暂时跳过只移动进程内队列且不改变领域 revision", () => withOperator(
  ({ database, catalogGate, operator, context }) => {
    for (const [objectId, level] of [["skip-first", 1], ["skip-middle", 2], ["skip-last", 3]]) {
      provisionalIdentity(database, catalogGate, objectId, level);
    }
    const initial = operator.getReviewProjection();
    const middleIndex = initial.reviewQueue.findIndex((entry) => entry.objectId === "skip-middle");
    const expectedNext = initial.reviewQueue[middleIndex + 1];
    const before = database.getCatalogObject("item-identity", "skip-middle");
    const semanticRevision = database.getCatalogSemanticRevision();

    const skipped = operator.skipCatalogReview({ objectType: "item-identity", objectId: "skip-middle" });

    assert.equal(skipped.nextReviewTarget.objectId, expectedNext.objectId);
    assert.equal(skipped.reviewQueue.at(-1).objectId, "skip-middle");
    assert.equal(skipped.reviewQueue.at(-1).actionStatus, "已跳过");
    assert.deepEqual(skipped.reviewSession.skippedObjectKeys, ["item-identity:skip-middle"]);
    assert.equal(skipped.reviewSession.commandRevision, 1);
    assert.equal(database.getCatalogObject("item-identity", "skip-middle").revision, before.revision);
    assert.equal(database.getCatalogSemanticRevision(), semanticRevision);
    assert.equal(context.invalidations, 1);
    assert.equal(context.publishedPlans.length, 0);
  },
));

test("CatalogReviewOperator 预览、提交和幂等重放共用同一重规划收尾路径", () => withOperator(
  async ({ database, catalogGate, operator, context }) => {
    const candidate = provisionalIdentity(database, catalogGate, "review-submit", 2);
    context.state.orders = [{
      slot: "review-order",
      rewardCoins: 10,
      items: [{ itemId: "review-submit", complete: false }],
    }];
    const snapshot = { ...candidate.algorithmCandidate, descriptionKey: "人工确认物品" };
    const preview = operator.previewCatalogReview({
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      snapshot,
      expectedRevision: candidate.revision,
    });
    let replans = 0;
    operator.replanner = async () => {
      replans += 1;
      return {
        status: "ready",
        recovered: true,
        boundaryReason: null,
        recommendedOrderSlot: "review-order",
      };
    };
    const request = {
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      decision: "modify",
      snapshot,
      actor: "operator",
      requestId: "operator-review-submit",
      expectedRevision: candidate.revision,
    };

    const completed = await operator.completeCatalogReview(request);
    const replayed = await operator.completeCatalogReview(request);

    assert.equal(preview.valid, true);
    assert.equal(preview.planningImpact.orders[0].slot, "review-order");
    assert.equal(completed.reviewResolution.planningResult.status, "ready");
    assert.equal(completed.reviewResolution.planningResult.recommendedOrderSlot, "review-order");
    assert.equal(replayed.idempotentReplay, true);
    assert.equal(replans, 1);
  },
));

test("CatalogReviewOperator 并发冲突返回最新对象与有意义差异", () => withOperator(
  async ({ database, catalogGate, operator }) => {
    const candidate = provisionalIdentity(database, catalogGate, "review-conflict", 2);
    operator.replanner = async () => ({ status: "ready", recovered: true });
    await operator.completeCatalogReview({
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      decision: "confirm",
      snapshot: candidate.algorithmCandidate,
      actor: "operator-a",
      requestId: "operator-review-first",
      expectedRevision: candidate.revision,
    });

    await assert.rejects(() => operator.completeCatalogReview({
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      decision: "modify",
      snapshot: { ...candidate.algorithmCandidate, descriptionKey: "并发草稿" },
      actor: "operator-b",
      requestId: "operator-review-stale",
      expectedRevision: candidate.revision,
    }), (error) => {
      assert.equal(error.code, "CATALOG_REVISION_CONFLICT");
      assert.equal(error.currentObject.objectId, "review-conflict");
      assert.equal(error.meaningfulDifferences.some((entry) => entry.fieldPath === "descriptionKey"), true);
      return true;
    });
  },
));

test("CatalogReviewOperator 记录重规划失败并可独立执行默认重规划", () => withOperator(
  async ({ database, catalogGate, operator, context }) => {
    const candidate = provisionalIdentity(database, catalogGate, "review-failure", 1);
    operator.replanner = async () => { throw new Error("planner fixture failed"); };
    const completed = await operator.completeCatalogReview({
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      decision: "confirm",
      snapshot: candidate.algorithmCandidate,
      actor: "operator",
      requestId: "operator-review-failure",
      expectedRevision: candidate.revision,
    });
    assert.equal(completed.reviewResolution.planningResult.status, "failed");
    assert.equal(completed.reviewResolution.planningResult.boundaryReason, "catalog-review-replan-failed");

    operator.replanner = null;
    context.state.orders = [{
      slot: "blocked",
      rewardCoins: 10,
      items: [{ itemId: "unknown-item", complete: false }],
    }];
    const replanned = await operator.replanAfterCatalogReview();
    assert.equal(replanned.status, "evidence-waiting");
    assert.deepEqual(replanned.blockingReviewTarget, {
      objectType: "item-identity",
      objectId: "unknown-item",
    });
    assert.equal(context.publishedPlans.length, 1);
  },
));

test("CatalogReviewOperator 对象处置发布审核事件并同步规划资格", () => withOperator(
  async ({ database, catalogGate, operator, context }) => {
    const active = activeIdentity(database, catalogGate, "review-disposition");
    operator.replanAfterCatalogReview = async () => ({
      status: "ready",
      recovered: true,
      boundaryReason: null,
      recommendedOrderSlot: null,
    });

    const paused = await operator.setCatalogObjectDisposition(
      active.objectType,
      active.objectId,
      "paused",
      "operator-confirmed-impact",
      active.revision,
    );

    assert.equal(paused.disposition, "paused");
    assert.equal(paused.planningEligible, false);
    assert.equal(context.events.length, 1);
    assert.equal(context.events[0].type, "catalog-state-updated");
    assert.equal(context.events[0].payload.object.objectId, active.objectId);
    assert.equal(context.events[0].payload.planningEligible, false);
  },
));

test("CatalogReviewOperator 证据处置返回审核摘要并发布同一对象事件", () => withOperator(
  ({ database, catalogGate, operator, context }) => {
    const candidate = provisionalIdentity(database, catalogGate, "review-evidence");
    const evidence = database.getCatalogObject(candidate.objectType, candidate.objectId).evidence[0];

    const disposed = operator.setCatalogEvidenceDisposition(
      candidate.objectType,
      candidate.objectId,
      evidence.id,
      "rejected",
      "operator-rejected-conflict",
      candidate.revision,
      { actor: "operator", action: "reject-evidence" },
    );

    assert.equal(disposed.evidence.find((entry) => entry.id === evidence.id).disposition, "rejected");
    assert.equal(disposed.catalogAuditSummary.action, "reject-evidence");
    assert.equal(disposed.catalogEvidenceAuditSummaries.at(-1).action, "reject-evidence");
    assert.equal(context.events.length, 1);
    assert.equal(context.events[0].type, "catalog-state-updated");
    assert.equal(context.events[0].payload.object.objectId, candidate.objectId);
  },
));
