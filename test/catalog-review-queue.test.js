"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");
const { CatalogReviewGate, buildPlanningCatalogFromRepository } = require("../src/catalog-review-gate");

function withDatabase(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-review-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try { return run(database); }
  finally { database.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

function activeIdentity(database, id = "i1", payload = {}) {
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: id,
    payload: { id, chainId: "c", level: 1, baseUnits: 1, ...payload },
    sourceType: "runtime-capture",
    sourceRef: "capture.json",
    countDuplicate: false,
  });
  new CatalogReviewGate(database).evaluateObject("item-identity", id);
  return database.getCatalogObject("item-identity", id);
}

test("字段级人工裁决只覆盖目标字段并保留完整审计记录", () => withDatabase((database) => {
  const before = activeIdentity(database, "i1", { iconResource: null });

  const ruled = database.applyCatalogRuling({
    objectType: "item-identity",
    objectId: "i1",
    fieldPath: "level",
    decision: "modify",
    value: 2,
    actor: "operator-a",
    note: "现场核对",
    expectedRevision: before.revision,
    baseRulingId: null,
  });

  assert.equal(ruled.algorithmCandidate.level, 1);
  assert.equal(ruled.humanValues.level.value, 2);
  assert.equal(ruled.effectiveValue.level, 2);
  assert.equal(ruled.effectiveValue.chainId, "c");
  assert.deepEqual(ruled.rulingHistory.at(-1), {
    id: ruled.rulingHistory.at(-1).id,
    fieldPath: "level",
    decision: "modify",
    value: 2,
    actor: "operator-a",
    note: "现场核对",
    oldValue: 1,
    newValue: 2,
    objectRevision: ruled.revision,
    createdAt: ruled.rulingHistory.at(-1).createdAt,
  });
}));

test("撤销裁决揭示当前算法候选而不是旧候选", () => withDatabase((database) => {
  let object = activeIdentity(database);
  object = database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "level", decision: "confirm", value: 1, actor: "operator-a", note: "确认", expectedRevision: object.revision, baseRulingId: null });
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { id: "i1", chainId: "c", level: 2, baseUnits: 2 }, sourceType: "runtime-capture", sourceRef: "new.json", countDuplicate: false });
  new CatalogReviewGate(database).evaluateObject("item-identity", "i1");
  object = database.getCatalogObject("item-identity", "i1");

  assert.equal(object.effectiveValue.level, 1);
  assert.equal(object.reviewReasons.some((reason) => reason.type === "human-ruling-conflict"), true);
  const rulingId = object.humanValues.level.id;
  const revoked = database.revokeCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "level", actor: "operator-b", note: "采用新证据", expectedRevision: object.revision, baseRulingId: rulingId });

  assert.equal(revoked.algorithmCandidate.level, 2);
  assert.equal(revoked.effectiveValue.level, 2);
  assert.equal(revoked.humanValues.level, undefined);
  assert.equal(revoked.rulingHistory.at(-1).oldValue, 1);
  assert.equal(revoked.rulingHistory.at(-1).newValue, 2);
}));

test("stale revision 明确冲突，重载后可重新提交未冲突字段", () => withDatabase((database) => {
  const original = activeIdentity(database);
  const first = database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "level", decision: "modify", value: 2, actor: "operator-a", note: "等级", expectedRevision: original.revision, baseRulingId: null });

  assert.throws(() => database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "chainId", decision: "modify", value: "manual-chain", actor: "operator-b", note: "链", expectedRevision: original.revision, baseRulingId: null }), (error) => {
    assert.equal(error.code, "CATALOG_REVISION_CONFLICT");
    assert.equal(error.currentObject.revision, first.revision);
    return true;
  });
  const merged = database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "chainId", decision: "modify", value: "manual-chain", actor: "operator-b", note: "链", expectedRevision: first.revision, baseRulingId: null });
  assert.equal(merged.effectiveValue.level, 2);
  assert.equal(merged.effectiveValue.chainId, "manual-chain");

  assert.throws(() => database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "level", decision: "modify", value: 3, actor: "operator-c", note: "冲突", expectedRevision: original.revision, baseRulingId: null }), (error) => {
    assert.equal(error.code, "CATALOG_REVISION_CONFLICT");
    assert.equal(error.statusCode, 409);
    assert.equal(error.currentObject.revision, merged.revision);
    assert.equal(error.currentObject.humanValues.level.id, first.humanValues.level.id);
    return true;
  });
}));

test("审核队列汇总新观测、推断变化、证据冲突、图标缺口和裁决冲突", () => withDatabase((database) => {
  let object = activeIdentity(database, "i1", { iconResource: null });
  object = database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "level", decision: "confirm", value: 1, actor: "operator", note: "确认", expectedRevision: object.revision, baseRulingId: null });
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { id: "i1", chainId: "c", level: 2, baseUnits: 2 }, sourceType: "structured-runtime", sourceRef: "changed.json", countDuplicate: false });
  new CatalogReviewGate(database).evaluateObject("item-identity", "i1");
  database.observeCatalogObject({ objectType: "merge-relation", objectId: "new", payload: { itemId: "new", chainId: "c", level: 1, mergeTarget: null }, sourceType: "visual-evidence", sourceRef: "screen.png" });

  const types = new Set(database.getCatalogReviewQueue().flatMap((entry) => entry.reasons.map((reason) => reason.type)));
  assert.deepEqual([...types].sort(), ["evidence-conflict", "icon-gap", "inference-change", "human-ruling-conflict", "new-observation"].sort());
  assert.equal(database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1" && conflict.conflictType === "evidence-conflict"), true);
}));

test("逻辑 IconRes 标识不能冒充已取得的图标证据", () => withDatabase((database) => {
  activeIdentity(database, "i1", { iconResource: "items/leaf", iconEvidenceStatus: "missing" });
  const entry = database.getCatalogReviewQueue().find((item) => item.objectId === "i1");
  assert.equal(entry.reasons.some((reason) => reason.type === "icon-gap"), true);
}));

test("证据冲突只比较不同来源的当前候选并在冲突证据失效后关闭", () => withDatabase((database) => {
  activeIdentity(database);
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { id: "i1", chainId: "c", level: 2, baseUnits: 2 }, sourceType: "runtime-capture", sourceRef: "newer-same-source.json", countDuplicate: false });
  const gate = new CatalogReviewGate(database);
  gate.evaluateObject("item-identity", "i1");
  assert.equal(database.listCatalogConflicts().length, 0);

  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { id: "i1", chainId: "other", level: 2, baseUnits: 2 }, sourceType: "structured-runtime", sourceRef: "config.json", countDuplicate: false });
  gate.evaluateObject("item-identity", "i1");
  let object = database.getCatalogObject("item-identity", "i1");
  assert.equal(database.listCatalogConflicts().length, 1);
  const conflictRevision = database.getCatalogRevision();
  gate.evaluateObject("item-identity", "i1");
  assert.equal(database.listCatalogConflicts().length, 1);
  assert.equal(database.getCatalogRevision(), conflictRevision);
  const conflictingEvidence = object.evidence.find((evidence) => evidence.sourceType === "structured-runtime");
  gate.setEvidenceDisposition("item-identity", "i1", conflictingEvidence.id, "rejected", "invalid-config", object.revision);
  assert.equal(database.listCatalogConflicts().length, 0);
}));

test("人工有效值参与真实规划而无关字段继续使用算法值", () => withDatabase((database) => {
  const legacy = { coverage: {}, chains: [{ id: "c", complete: true }], items: [{ id: "i1", chainId: "c", level: 1, baseUnits: 1, mergeTarget: null }], producers: [] };
  let identity = activeIdentity(database);
  database.observeCatalogObject({ objectType: "merge-relation", objectId: "i1", payload: { itemId: "i1", chainId: "c", level: 1, mergeTarget: null }, sourceType: "runtime-capture", sourceRef: "capture.json", countDuplicate: false });
  const gate = new CatalogReviewGate(database);
  gate.evaluateObject("merge-relation", "i1");
  identity = database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "iconResourceIdentifier", decision: "modify", value: "manual/icon", actor: "operator", note: "图标", expectedRevision: identity.revision, baseRulingId: null });

  const planning = buildPlanningCatalogFromRepository(database, legacy);
  assert.equal(planning.items[0].level, 1);
  assert.equal(planning.items[0].iconResource, "manual/icon");
}));
