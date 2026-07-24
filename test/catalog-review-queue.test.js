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

test("已生效对象的历史版本不会永久留在审核队列", () => withDatabase((database) => {
  const object = activeIdentity(database);

  assert.equal(object.status, "active");
  assert.equal(object.candidateVersion, null);
  assert.equal(object.reviewReasons.some((reason) => reason.type === "inference-change"), false);
}));

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

test("语义审核队列汇总新观测、推断变化、证据冲突和裁决冲突", () => withDatabase((database) => {
  let object = activeIdentity(database, "i1", { iconResource: null });
  object = database.applyCatalogRuling({ objectType: "item-identity", objectId: "i1", fieldPath: "level", decision: "confirm", value: 1, actor: "operator", note: "确认", expectedRevision: object.revision, baseRulingId: null });
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { id: "i1", chainId: "c", level: 2, baseUnits: 2 }, sourceType: "structured-runtime", sourceRef: "changed.json", countDuplicate: false });
  new CatalogReviewGate(database).evaluateObject("item-identity", "i1");
  database.observeCatalogObject({ objectType: "merge-relation", objectId: "new", payload: { itemId: "new", chainId: "c", level: 1, mergeTarget: null }, sourceType: "visual-evidence", sourceRef: "screen.png" });
  database.observeCatalogObject({ objectType: "item-identity", objectId: "candidate", payload: { id: "candidate", chainId: "c", level: 1, baseUnits: 1 }, sourceType: "structural-inference", sourceRef: "candidate.json", countDuplicate: false });
  new CatalogReviewGate(database).evaluateObject("item-identity", "candidate");

  const types = new Set(database.getCatalogReviewQueue().flatMap((entry) => entry.reasons.map((reason) => reason.type)));
  assert.deepEqual([...types].sort(), ["evidence-conflict", "inference-change", "human-ruling-conflict", "new-observation"].sort());
  assert.equal(database.listCatalogConflicts().some((conflict) => conflict.objectId === "i1" && conflict.conflictType === "evidence-conflict"), true);
}));

test("逻辑 IconRes 标识不能冒充已取得的图标证据", () => withDatabase((database) => {
  activeIdentity(database, "i1", { iconResource: "items/leaf", iconEvidenceStatus: "missing" });
  const object = database.getCatalogObject("item-identity", "i1");
  assert.equal(object.completenessGaps.some((gap) => gap.type === "icon-gap"), true);
  assert.equal(database.getCatalogReviewQueue().some((item) => item.objectId === "i1"), false);
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

test("采用证据只记录审计并保留完整确认边界，否决后原始来源仍可追溯", () => withDatabase((database) => {
  activeIdentity(database, "evidence-choice", { name: "可信名称" });
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "evidence-choice",
    payload: { itemId: "evidence-choice", chainId: "other-chain", level: 2, baseUnits: 2, name: "不可信名称" },
    sourceType: "structured-runtime",
    sourceRef: "conflicting-source.json",
    countDuplicate: false,
  });
  const gate = new CatalogReviewGate(database);
  gate.evaluateObject("item-identity", "evidence-choice");
  let object = database.getCatalogObject("item-identity", "evidence-choice");
  const trusted = object.evidence.find((evidence) => evidence.sourceType === "runtime-capture");
  const untrusted = object.evidence.find((evidence) => evidence.sourceType === "structured-runtime");
  const resolutionsBefore = database.listCatalogReviewResolutions({ objectId: object.objectId }).length;

  const accepted = gate.setEvidenceDisposition(
    object.objectType,
    object.objectId,
    trusted.id,
    "eligible",
    "operator-a: 采用运行时证据",
    object.revision,
    { actor: "operator-a", note: "采用运行时证据", action: "accept-evidence" },
  );
  assert.equal(accepted.reviewStatus, "needs-review");
  assert.equal(accepted.evidence.every((evidence) => evidence.disposition === "eligible"), true);
  assert.equal(database.listCatalogReviewResolutions({ objectId: object.objectId }).length, resolutionsBefore);
  assert.equal(accepted.catalogAuditSummary.action, "accept-evidence");
  assert.equal(accepted.catalogAuditSummary.evidenceReference.sourceRef, "capture.json");
  assert.deepEqual(accepted.catalogAuditSummary.adoptedPayload, trusted.payload);

  const rejected = gate.setEvidenceDisposition(
    object.objectType,
    object.objectId,
    untrusted.id,
    "rejected",
    "operator-a: 与现场不符",
    accepted.revision,
    { actor: "operator-a", note: "与现场不符", action: "reject-evidence" },
  );
  const rejectedEvidence = rejected.evidence.find((evidence) => evidence.id === untrusted.id);
  assert.equal(rejectedEvidence.disposition, "rejected");
  assert.equal(rejectedEvidence.sourceRef, "conflicting-source.json");
  assert.deepEqual(rejectedEvidence.payload, untrusted.payload);
  assert.equal(rejected.catalogAuditSummary.action, "reject-evidence");
  assert.deepEqual(rejected.catalogAuditSummary.impact, {
    excludedFromInference: true,
    excludedFromPlanning: true,
  });
  assert.deepEqual(database.listCatalogEvidenceAuditSummaries({ objectId: object.objectId }).map((audit) => audit.action), [
    "accept-evidence",
    "reject-evidence",
  ]);
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

test("确认候选接受整个对象并激活后退出语义审核队列", () => withDatabase((database) => {
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "candidate",
    payload: { id: "candidate", chainId: "c", level: 1, baseUnits: 1, descriptionKey: "candidate-name" },
    sourceType: "structural-inference",
    sourceRef: "candidate.json",
    countDuplicate: false,
  });
  const gate = new CatalogReviewGate(database);
  const provisional = gate.evaluateObject("item-identity", "candidate");
  const candidate = structuredClone(provisional.algorithmCandidate);

  const confirmed = database.completeCatalogReview({
    objectType: "item-identity",
    objectId: "candidate",
    decision: "confirm",
    actor: "operator-a",
    note: "整对象核对无误",
    expectedRevision: provisional.revision,
  });

  assert.equal(confirmed.status, "active");
  assert.equal(confirmed.activeVersion.origin, "user");
  assert.deepEqual(confirmed.activeVersion.payload, candidate);
  assert.deepEqual(confirmed.effectiveValue, candidate);
  assert.equal(confirmed.candidateVersion, null);
  assert.equal(confirmed.reviewStatus, "clear");
  assert.deepEqual(confirmed.reviewReasons, []);
  assert.equal(database.getCatalogReviewQueue().some((entry) => entry.objectId === "candidate"), false);
}));

test("保存修改提交完整对象并把修改后的版本激活", () => withDatabase((database) => {
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "modified",
    payload: { id: "modified", chainId: "c", level: 1, baseUnits: 1, descriptionKey: "before" },
    sourceType: "structural-inference",
    sourceRef: "candidate.json",
    countDuplicate: false,
  });
  const provisional = new CatalogReviewGate(database).evaluateObject("item-identity", "modified");
  const modifiedPayload = { ...provisional.algorithmCandidate, descriptionKey: "人工修正后的完整对象" };

  const modified = database.completeCatalogReview({
    objectType: "item-identity",
    objectId: "modified",
    decision: "modify",
    payload: modifiedPayload,
    actor: "operator-b",
    note: "按游戏图鉴修正名称",
    expectedRevision: provisional.revision,
  });

  assert.equal(modified.status, "active");
  assert.equal(modified.activeVersion.origin, "user");
  assert.deepEqual(modified.activeVersion.payload, modifiedPayload);
  assert.deepEqual(modified.effectiveValue, modifiedPayload);
  assert.equal(modified.candidateVersion, null);
  assert.deepEqual(modified.versions.map((version) => version.status), ["observed", "provisional", "active"]);
  assert.equal(modified.reviewReasons.some((reason) => reason.type === "human-ruling-conflict"), false);
  assert.equal(database.getCatalogReviewQueue().some((entry) => entry.objectId === "modified"), false);
}));

test("图标缺口不进入语义审核队列但在对象详情保留完整性提示", () => withDatabase((database) => {
  const object = activeIdentity(database, "without-icon", { iconResource: null, iconEvidenceStatus: "missing" });

  assert.equal(object.status, "active");
  assert.equal(object.reviewReasons.some((reason) => reason.type === "icon-gap"), false);
  assert.equal(object.completenessGaps.some((gap) => gap.type === "icon-gap" && gap.fieldPath === "iconResourceIdentifier"), true);
  assert.equal(database.getCatalogReviewQueue().some((entry) => entry.objectId === "without-icon"), false);
}));

test("审核队列标题按人工确认、疑似候选和未命名降级且同名候选用等级区分", () => withDatabase((database) => {
  for (const [objectId, level, name] of [
    ["internal-candidate-a", 1, "园艺手套"],
    ["internal-candidate-b", 2, "园艺手套"],
    ["internal-unnamed", 3, null],
    ["internal-confirmed", 4, "待人工确认"],
  ]) {
    database.observeCatalogObject({
      objectType: "item-identity",
      objectId,
      payload: {
        itemId: objectId,
        chainId: "internal-chain-id",
        level,
        baseUnits: 2 ** (level - 1),
        ...(name ? { name } : {}),
      },
      sourceType: "structural-inference",
      sourceRef: `${objectId}.json`,
      countDuplicate: false,
    });
    new CatalogReviewGate(database).evaluateObject("item-identity", objectId);
  }

  let confirmed = database.getCatalogObject("item-identity", "internal-confirmed");
  confirmed = database.applyCatalogRuling({
    objectType: confirmed.objectType,
    objectId: confirmed.objectId,
    fieldPath: "name",
    decision: "confirm",
    value: "人工确认手套",
    actor: "operator",
    note: "核对名称",
    expectedRevision: confirmed.revision,
    baseRulingId: null,
  });
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: confirmed.objectId,
    payload: {
      itemId: confirmed.objectId,
      chainId: "internal-chain-id",
      level: 4,
      baseUnits: 8,
      name: "新候选名称",
    },
    sourceType: "structured-runtime",
    sourceRef: "changed.json",
    countDuplicate: false,
  });
  new CatalogReviewGate(database).evaluateObject("item-identity", confirmed.objectId);

  const queue = database.getCatalogReviewQueue();
  const confirmedEntry = queue.find((entry) => entry.objectId === "internal-confirmed");
  const sameNameEntries = queue.filter((entry) => ["internal-candidate-a", "internal-candidate-b"].includes(entry.objectId));
  const unnamedEntry = queue.find((entry) => entry.objectId === "internal-unnamed");

  assert.equal(confirmedEntry.displayTitle, "人工确认手套");
  assert.deepEqual(sameNameEntries.map((entry) => entry.displayTitle).sort(), [
    "疑似“园艺手套”（第 1 级）",
    "疑似“园艺手套”（第 2 级）",
  ]);
  assert.equal(unnamedEntry.displayTitle, "未命名物品（第 3 级）");
  for (const entry of queue) {
    assert.equal(entry.displayTitle.includes(entry.objectId), false);
    assert.equal(entry.displayTitle.includes("internal-chain-id"), false);
  }
}));

test("仅有完整性缺口的对象进入以后再看而不进入主阻塞队列", () => withDatabase((database) => {
  const object = activeIdentity(database, "later-icon", {
    name: "园艺铲",
    iconResource: null,
    iconEvidenceStatus: "missing",
  });

  assert.deepEqual(object.reviewReasons, []);
  assert.equal(database.getCatalogReviewQueue().some((entry) => entry.objectId === object.objectId), false);
  assert.deepEqual(database.getCatalogCompletenessQueue().map((entry) => ({
    objectId: entry.objectId,
    actionStatus: entry.actionStatus,
    gapTypes: entry.gaps.map((gap) => gap.type),
    planningImpact: entry.planningImpact,
  })), [{
    objectId: "later-icon",
    actionStatus: "以后再看",
    gapTypes: ["icon-gap"],
    planningImpact: "不影响当前规划",
  }]);
}));

test("已确认无名快照后的新名称证据仍显示为疑似候选", () => withDatabase((database) => {
  let object = activeIdentity(database, "confirmed-unnamed", { name: null });
  object = database.completeCatalogReview({
    objectType: object.objectType,
    objectId: object.objectId,
    decision: "confirm",
    snapshot: object.algorithmCandidate,
    actor: "operator",
    requestId: "confirm-unnamed",
    expectedRevision: object.revision,
  });
  database.finalizeCatalogReviewPlanning("confirm-unnamed", { status: "ready", recovered: true });
  database.observeCatalogObject({
    objectType: object.objectType,
    objectId: object.objectId,
    payload: {
      itemId: object.objectId,
      chainId: "changed-chain",
      level: 2,
      baseUnits: 2,
      name: "新发现的手套",
    },
    sourceType: "structured-runtime",
    sourceRef: "changed-name.json",
    countDuplicate: false,
  });
  new CatalogReviewGate(database).evaluateObject(object.objectType, object.objectId);

  const entry = database.getCatalogReviewQueue().find((candidate) => candidate.objectId === object.objectId);
  assert.equal(entry.displayTitle, "疑似“新发现的手套”");
}));

test("同名同级对象使用稳定链位置区分且不暴露内部标识", () => withDatabase((database) => {
  for (const objectId of ["same-level-internal-b", "same-level-internal-a"]) {
    database.observeCatalogObject({
      objectType: "item-identity",
      objectId,
      payload: {
        itemId: objectId,
        chainId: `${objectId}-chain`,
        level: 2,
        baseUnits: 2,
        name: "同名剪刀",
      },
      sourceType: "structural-inference",
      sourceRef: `${objectId}.json`,
      countDuplicate: false,
    });
    new CatalogReviewGate(database).evaluateObject("item-identity", objectId);
  }

  const titles = database.getCatalogReviewQueue().map((entry) => entry.displayTitle).sort();
  assert.deepEqual(titles, [
    "疑似“同名剪刀”（第 2 级 · 链位置 1/2）",
    "疑似“同名剪刀”（第 2 级 · 链位置 2/2）",
  ]);
  assert.equal(titles.some((title) => title.includes("internal")), false);
}));
