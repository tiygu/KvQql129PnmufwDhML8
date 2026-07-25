"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");
const { AutomationRuntime } = require("../src/automation-runtime");

function withDirectory(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-"));
  try { return run(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function observeIdentity(database, objectId = "item-1", name = "候选物品") {
  return database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: { id: objectId, name, chainId: "chain-1", level: 1 },
    sourceType: "runtime-capture",
    sourceRef: "capture.json",
    countDuplicate: false,
  });
}

test("图鉴 Schema v2 迁移会先备份且重复启动保持幂等", () => withDirectory((dir) => {
  const filePath = path.join(dir, "catalog.db");
  let database = new AutomationDatabase(filePath);
  database.db.exec("PRAGMA user_version=1; DELETE FROM schema_migrations WHERE version=2;");
  database.close();

  database = new AutomationDatabase(filePath);
  const status = database.getCatalogSchemaStatus();
  const backupPath = `${filePath}.pre-v2.bak`;

  assert.equal(status.currentVersion, 2);
  assert.deepEqual(status.migrations.map((migration) => migration.version), [1, 2]);
  assert.equal(status.preMigrationBackupPath, backupPath);
  assert.equal(fs.existsSync(backupPath), true);
  const backupStat = fs.statSync(backupPath);
  database.close();

  database = new AutomationDatabase(filePath);
  assert.equal(database.getCatalogSchemaStatus().currentVersion, 2);
  assert.equal(fs.statSync(backupPath).mtimeMs, backupStat.mtimeMs);
  database.close();
}));

test("旧裁决按兼容默认值读取且首个新裁决写入完整快照 Schema v2", () => withDirectory((dir) => {
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try {
    const observed = observeIdentity(database);
    const objectRow = database.db.prepare(
      "SELECT id FROM catalog_repository_objects WHERE object_type='item-identity' AND object_id='item-1'",
    ).get();
    database.db.prepare(`INSERT INTO catalog_review_resolutions(
      object_id,request_id,request_fingerprint,decision,snapshot_json,actor,optional_note,object_revision,planning_result_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      objectRow.id,
      "legacy-resolution",
      "legacy-fingerprint",
      "confirm",
      JSON.stringify({ id: "item-1", name: "旧结论", chainId: "chain-1", level: 1 }),
      "legacy-operator",
      null,
      observed.revision,
      JSON.stringify({ status: "not-requested", recovered: true }),
      "2026-07-01T00:00:00.000Z",
    );

    const legacy = database.listCatalogReviewResolutions().at(-1);
    assert.equal(legacy.schemaVersion, 1);
    assert.equal(legacy.compatibilitySource, "legacy-default");

    const completed = database.completeCatalogReview({
      objectType: "item-identity",
      objectId: "item-1",
      decision: "modify",
      snapshot: { id: "item-1", name: "新结论", chainId: "chain-1", level: 1 },
      actor: "operator",
      requestId: "native-v2-resolution",
      expectedRevision: observed.revision,
    });
    assert.equal(completed.reviewResolution.schemaVersion, 2);
    assert.equal(completed.reviewResolution.compatibilitySource, "native-full-snapshot");
  } finally {
    database.close();
  }
}));

test("旧字段动作无损适配为完整快照裁决并记录兼容调用", () => withDirectory((dir) => {
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try {
    const observed = observeIdentity(database);
    const completed = database.adaptLegacyCatalogRuling({
      objectType: "item-identity",
      objectId: "item-1",
      fieldPath: "name",
      decision: "modify",
      value: "人工命名",
      actor: "operator",
      note: "旧入口字段修改",
      requestId: "legacy-field-action",
      expectedRevision: observed.revision,
    });

    assert.equal(completed.reviewResolution.snapshot.name, "人工命名");
    assert.equal(completed.reviewResolution.snapshot.level, 1);
    assert.equal(completed.reviewResolution.schemaVersion, 2);
    assert.equal(completed.reviewResolution.compatibilitySource, "legacy-field-ruling");
    assert.equal(database.getCatalogCompatibilityMetrics().find((metric) => metric.operation === "legacy-field-ruling").callCount, 1);
    assert.throws(
      () => database.adaptLegacyCatalogRuling({ objectType: "item-identity", objectId: "item-1" }),
      (error) => error.code === "CATALOG_LEGACY_ACTION_INVALID" && error.statusCode === 400,
    );
  } finally {
    database.close();
  }
}));

test("运行时旧字段动作复用完整审核的重规划收尾路径", async () => {
  const calls = [];
  const committed = {
    objectType: "item-identity",
    objectId: "item-1",
    reviewResolution: {
      decision: "modify",
      snapshot: { id: "item-1", name: "人工命名", chainId: "chain-1", level: 1 },
      requestId: "legacy-field-action",
      compatibilitySource: "legacy-field-ruling",
    },
  };
  const runtime = {
    database: {
      adaptLegacyCatalogRuling(input, options) {
        calls.push(["adapt", input, options]);
        return committed;
      },
    },
    async completeCatalogReview(input) {
      calls.push(["complete", input]);
      return { ...committed, reviewResolution: { ...committed.reviewResolution, planningResult: { status: "ready", recovered: true } } };
    },
  };
  const input = {
    objectType: "item-identity",
    objectId: "item-1",
    fieldPath: "name",
    decision: "modify",
    value: "人工命名",
    actor: "operator",
    note: "旧入口字段修改",
    expectedRevision: 3,
  };

  const result = await AutomationRuntime.prototype.adaptLegacyCatalogRuling.call(runtime, input);

  assert.equal(calls[0][0], "adapt");
  assert.equal(calls[1][0], "complete");
  assert.equal(calls[1][1].requestId, "legacy-field-action");
  assert.equal(calls[1][1].compatibilitySource, "legacy-field-ruling");
  assert.deepEqual(result.reviewResolution.planningResult, { status: "ready", recovered: true });
});

test("JSON 导入只补充证据且发布回退不撤销已提交领域事实", () => withDirectory((dir) => {
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  try {
    const observed = observeIdentity(database);
    const completed = database.completeCatalogReview({
      objectType: "item-identity",
      objectId: "item-1",
      decision: "modify",
      snapshot: { id: "item-1", name: "人工事实", chainId: "chain-1", level: 1 },
      actor: "operator",
      requestId: "committed-before-rollback",
      expectedRevision: observed.revision,
    });
    const imported = database.importCatalog({
      chains: [{ id: "chain-1", complete: false }],
      items: [{ id: "item-1", name: "过期 JSON", chainId: "chain-1", level: 1 }],
      producers: [],
    }, { sourceFile: "legacy.json", sourceType: "json-import" });

    assert.equal(imported.items, 1);
    assert.equal(database.getCatalogObject("item-identity", "item-1").effectiveValue.name, "人工事实");
    assert.equal(database.getCatalogCompatibilityMetrics().find((metric) => metric.operation === "json-evidence-import").callCount, 1);

    const release = database.setCatalogReleaseControl({ entryMode: "legacy-advanced" });
    assert.equal(release.entryMode, "legacy-advanced");
    assert.equal(database.getCatalogObject("item-identity", "item-1").reviewResolution.requestId, completed.reviewResolution.requestId);
    assert.throws(
      () => database.setCatalogReleaseControl({ entryMode: "invalid" }),
      (error) => error.code === "CATALOG_RELEASE_CONTROL_INVALID" && error.statusCode === 400,
    );
  } finally {
    database.close();
  }
}));
