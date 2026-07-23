"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");
const { CatalogReviewGate } = require("../src/catalog-review-gate");

function withDatabase(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-resolution-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try { return run(database); }
  finally { database.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

function provisionalIdentity(database, objectId = "review-item") {
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: {
      itemId: objectId,
      chainId: "garden-tools",
      level: 2,
      baseUnits: 2,
      descriptionKey: "园艺手套",
    },
    sourceType: "structural-inference",
    sourceRef: "candidate.json",
    countDuplicate: false,
  });
  return new CatalogReviewGate(database).evaluateObject("item-identity", objectId);
}

test("确认无误以一个事务保存完整快照、结论和 Catalog Audit Summary，并按请求幂等", () => withDatabase((database) => {
  const before = provisionalIdentity(database);
  const snapshot = structuredClone(before.algorithmCandidate);
  const input = {
    objectType: before.objectType,
    objectId: before.objectId,
    decision: "confirm",
    snapshot,
    actor: "本地操作者",
    requestId: "review-request-001",
    expectedRevision: before.revision,
    createdAt: "2026-07-24T08:00:00.000Z",
  };

  const first = database.completeCatalogReview(input);
  const replay = database.completeCatalogReview(input);
  const resolutions = database.listCatalogReviewResolutions({
    objectType: before.objectType,
    objectId: before.objectId,
  });
  const audits = database.listCatalogAuditSummaries({
    objectType: before.objectType,
    objectId: before.objectId,
  });

  assert.deepEqual(first.effectiveValue, snapshot);
  assert.equal(first.reviewStatus, "clear");
  assert.equal(first.idempotentReplay, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.revision, first.revision);
  assert.equal(resolutions.length, 1);
  assert.equal(audits.length, 1);
  assert.equal(resolutions[0].requestId, input.requestId);
  assert.deepEqual(resolutions[0].snapshot, snapshot);
  assert.equal(resolutions[0].objectRevision, first.revision);
  assert.deepEqual(audits[0], {
    id: audits[0].id,
    resolutionId: resolutions[0].id,
    requestId: input.requestId,
    objectType: before.objectType,
    objectId: before.objectId,
    objectRevision: first.revision,
    actor: input.actor,
    action: "confirm",
    displayTitle: "未命名物品（第 2 级）",
    meaningfulDifferences: [],
    triggerReasons: before.reviewReasons,
    planningResult: { status: "pending", recovered: false },
    evidenceReferences: before.evidence.map((evidence) => ({
      id: evidence.id,
      sourceType: evidence.sourceType,
      sourceRef: evidence.sourceRef,
    })),
    optionalNote: null,
    createdAt: input.createdAt,
  });
}));

test("同一幂等请求标识不能代表不同的候选快照", () => withDatabase((database) => {
  const before = provisionalIdentity(database, "mismatched-request");
  const input = {
    objectType: before.objectType,
    objectId: before.objectId,
    decision: "confirm",
    snapshot: before.algorithmCandidate,
    actor: "本地操作者",
    requestId: "review-request-reused",
    expectedRevision: before.revision,
  };
  database.completeCatalogReview(input);

  assert.throws(() => database.completeCatalogReview({
    ...input,
    snapshot: { ...input.snapshot, name: "另一候选" },
  }), (error) => {
    assert.equal(error.code, "CATALOG_IDEMPOTENCY_CONFLICT");
    assert.equal(error.statusCode, 409);
    return true;
  });
}));

test("重规划失败保留不可变审计并在刷新投影中恢复未完成状态", () => withDatabase((database) => {
  const before = provisionalIdentity(database, "planning-pending");
  const completed = database.completeCatalogReview({
    objectType: before.objectType,
    objectId: before.objectId,
    decision: "confirm",
    snapshot: before.algorithmCandidate,
    actor: "本地操作者",
    requestId: "review-planning-failed",
    expectedRevision: before.revision,
  });
  const storedBefore = database.db.prepare(
    "SELECT summary_json FROM catalog_audit_summaries WHERE resolution_id=?",
  ).get(completed.reviewResolution.id).summary_json;

  database.finalizeCatalogReviewPlanning("review-planning-failed", {
    status: "failed",
    recovered: false,
    boundaryReason: "catalog-review-replan-failed",
    recommendedOrderSlot: null,
    error: "planner fixture failed",
  });

  const storedAfter = database.db.prepare(
    "SELECT summary_json FROM catalog_audit_summaries WHERE resolution_id=?",
  ).get(completed.reviewResolution.id).summary_json;
  const restored = database.getCatalogObject(before.objectType, before.objectId);
  const queued = database.getCatalogReviewQueue().find((entry) => entry.objectId === before.objectId);
  const audit = database.listCatalogAuditSummaries({ objectId: before.objectId })[0];

  assert.equal(storedAfter, storedBefore);
  assert.equal(restored.reviewResolution.planningResult.status, "failed");
  assert.equal(restored.catalogAuditSummary.planningResult.status, "failed");
  assert.equal(queued.reviewStatus, "clear");
  assert.equal(queued.actionStatus, "已确认");
  assert.equal(queued.reasons.some((reason) => reason.type === "planning-recovery-pending"), true);
  assert.equal(audit.planningResult.status, "failed");
}));
