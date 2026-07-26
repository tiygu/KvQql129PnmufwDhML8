"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationDatabase } = require("../src/automation-database");

function withDatabase(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "display-icon-decision-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  const filePath = path.join(root, "icon.png");
  fs.writeFileSync(filePath, "icon fixture");
  try {
    database.observeCatalogObject({
      objectType: "item-identity",
      objectId: "item-1",
      payload: { itemId: "item-1", name: "候选物品", level: 1 },
      sourceType: "runtime-capture",
    });
    return run({ database, filePath });
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function asset(filePath, hash) {
  return {
    hash,
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteSize: fs.statSync(filePath).size,
    filePath,
  };
}

test("展示图标决定只在选择改变时推进独立 revision", () => withDatabase(({ database, filePath }) => {
  const before = database.getCatalogObject("item-identity", "item-1");
  const semanticRevisionBefore = database.getCatalogRevision();
  const presentationRevisionBefore = database.getCatalogPresentationRevision();

  database.saveIconCandidate({
    itemId: "item-1",
    cacheKey: "candidate-only",
    sourceType: "runtime-resource",
    autoSelect: false,
    asset: asset(filePath, "1".repeat(64)),
  });
  const candidateOnly = database.getCatalogObject("item-identity", "item-1");

  assert.equal(candidateOnly.revision, before.revision);
  assert.equal(candidateOnly.displayIcon.revision, 1);
  assert.equal(candidateOnly.displayIcon.selectedIcon, null);
  assert.equal(database.getCatalogRevision(), semanticRevisionBefore);
  assert.equal(database.getCatalogPresentationRevision(), presentationRevisionBefore);

  const selected = database.saveIconCandidate({
    itemId: "item-1",
    cacheKey: "automatic-selection",
    sourceType: "runtime-resource",
    autoSelect: true,
    rankScore: 2,
    asset: asset(filePath, "2".repeat(64)),
  });
  const after = database.getCatalogObject("item-identity", "item-1");

  assert.equal(after.revision, before.revision);
  assert.equal(after.displayIcon.revision, 2);
  assert.equal(after.displayIcon.selectedIcon.id, selected.id);
  assert.notEqual(database.getCatalogPresentationRevision(), presentationRevisionBefore);
  assert.deepEqual(after.displayIcon.history.map((entry) => ({
    action: entry.action,
    revision: entry.revision,
    objectRevision: entry.objectRevision,
  })), [{
    action: "automatic-select",
    revision: 2,
    objectRevision: before.revision,
  }]);
}));

test("展示图标命令原子校验独立 revision 与候选归属", () => withDatabase(({ database, filePath }) => {
  const ownCandidate = database.saveIconCandidate({
    itemId: "item-1",
    cacheKey: "owned",
    sourceType: "runtime-resource",
    autoSelect: false,
    asset: asset(filePath, "3".repeat(64)),
  });
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "item-2",
    payload: { itemId: "item-2", name: "其他物品", level: 1 },
    sourceType: "runtime-capture",
  });
  const foreignCandidate = database.saveIconCandidate({
    itemId: "item-2",
    cacheKey: "foreign",
    sourceType: "runtime-resource",
    autoSelect: false,
    asset: asset(filePath, "4".repeat(64)),
  });

  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "item-1",
    payload: { itemId: "item-1", name: "更新后的候选物品", level: 1 },
    sourceType: "runtime-capture",
    sourceRef: "later-capture",
  });
  const semanticRevision = database.getCatalogObject("item-identity", "item-1").revision;
  const selected = database.selectIconCandidate("item-1", ownCandidate.id, {
    actor: "operator",
    note: "最清晰",
    expectedDisplayIconRevision: 1,
  });

  assert.equal(selected.revision, semanticRevision);
  assert.equal(selected.displayIcon.revision, 2);
  assert.throws(
    () => database.selectIconCandidate("item-1", foreignCandidate.id, {
      actor: "operator",
      note: "错误归属",
      expectedDisplayIconRevision: 2,
    }),
    (error) => error.statusCode === 404,
  );
  assert.equal(database.getCatalogObject("item-identity", "item-1").displayIcon.revision, 2);
  assert.throws(
    () => database.revokeIconSelection("item-1", {
      actor: "operator",
      note: "过期命令",
      expectedDisplayIconRevision: 1,
    }),
    (error) => error.code === "DISPLAY_ICON_REVISION_CONFLICT"
      && error.currentDisplayIcon.revision === 2,
  );
}));

test("Schema v3 从旧候选选择回填展示图标决定", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "display-icon-migration-"));
  const filePath = path.join(root, "automation.db");
  const iconPath = path.join(root, "icon.png");
  fs.writeFileSync(iconPath, "legacy icon fixture");
  let database = new AutomationDatabase(filePath);
  try {
    database.observeCatalogObject({
      objectType: "item-identity",
      objectId: "legacy-item",
      payload: { itemId: "legacy-item", name: "旧物品" },
      sourceType: "legacy-import",
    });
    const candidate = database.saveIconCandidate({
      itemId: "legacy-item",
      cacheKey: "legacy-selected",
      sourceType: "legacy-runtime",
      asset: asset(iconPath, "5".repeat(64)),
    });
    database.db.exec(`
      DELETE FROM catalog_icon_selection_history;
      DELETE FROM catalog_icon_decisions;
      DELETE FROM schema_migrations WHERE version=3;
      PRAGMA user_version=2;
    `);
    database.close();

    database = new AutomationDatabase(filePath);
    const object = database.getCatalogObject("item-identity", "legacy-item");
    assert.equal(database.getCatalogSchemaStatus().currentVersion, 3);
    assert.equal(object.displayIcon.revision, 2);
    assert.equal(object.displayIcon.selectedIcon.id, candidate.id);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
