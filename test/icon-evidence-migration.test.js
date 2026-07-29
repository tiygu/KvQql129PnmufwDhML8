"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { AutomationDatabase } = require("../src/automation-database");

const LEGACY_CREATED_AT = "2026-07-01T00:00:00.000Z";

async function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "icon-evidence-migration-"));
  let result;
  let failure = null;
  try {
    result = await run(directory);
  } catch (error) {
    failure = error;
  }
  try {
    await fsp.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    failure.cleanupError = cleanupError;
  }
  if (failure) throw failure;
  return result;
}

function createLegacyV3Database(filePath) {
  const database = new DatabaseSync(filePath);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE catalog_repository_objects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'observed',
      disposition TEXT NOT NULL DEFAULT 'enabled',
      revision INTEGER NOT NULL DEFAULT 1,
      candidate_version_id INTEGER,
      active_version_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(object_type, object_id)
    );
    CREATE TABLE catalog_repository_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'eligible',
      observation_count INTEGER NOT NULL DEFAULT 1,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      UNIQUE(object_id, fingerprint, source_type, source_ref),
      FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT
    );
    CREATE TABLE catalog_repository_rulings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL,
      field_path TEXT NOT NULL,
      decision TEXT NOT NULL,
      value_json TEXT,
      actor TEXT NOT NULL,
      note TEXT NOT NULL,
      old_value_json TEXT,
      new_value_json TEXT,
      object_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT
    );
    CREATE TABLE catalog_evidence_audit_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL,
      evidence_id INTEGER NOT NULL,
      object_revision INTEGER NOT NULL,
      action TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT,
      FOREIGN KEY(evidence_id) REFERENCES catalog_repository_evidence(id) ON DELETE RESTRICT
    );
    CREATE TABLE catalog_icon_assets (
      hash TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      byte_size INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE catalog_icon_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL,
      asset_hash TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      source_type TEXT NOT NULL,
      resource_url TEXT,
      runtime_identifier TEXT,
      texture_uuid TEXT,
      crop_json TEXT NOT NULL,
      similarity_json TEXT NOT NULL DEFAULT '{}',
      rank_score REAL NOT NULL DEFAULT 1,
      selection_origin TEXT,
      selected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(object_id,cache_key),
      FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT,
      FOREIGN KEY(asset_hash) REFERENCES catalog_icon_assets(hash) ON DELETE RESTRICT
    );
    CREATE TABLE catalog_icon_selection_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL,
      candidate_id INTEGER,
      previous_candidate_id INTEGER,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT NOT NULL,
      object_revision INTEGER NOT NULL,
      decision_revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT,
      FOREIGN KEY(candidate_id) REFERENCES catalog_icon_candidates(id) ON DELETE RESTRICT,
      FOREIGN KEY(previous_candidate_id) REFERENCES catalog_icon_candidates(id) ON DELETE RESTRICT
    );
    CREATE TABLE catalog_icon_decisions (
      object_id INTEGER PRIMARY KEY,
      selected_candidate_id INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      selection_origin TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT,
      FOREIGN KEY(selected_candidate_id) REFERENCES catalog_icon_candidates(id) ON DELETE RESTRICT
    );
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE merge_chains (
      id TEXT PRIMARY KEY,
      title_key TEXT,
      min_level INTEGER,
      max_level INTEGER,
      observed_max_level INTEGER,
      complete INTEGER NOT NULL DEFAULT 0,
      source_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      chain_id TEXT,
      level INTEGER,
      merge_target TEXT,
      icon_resource TEXT,
      energy_cost REAL,
      base_units REAL,
      confidence TEXT NOT NULL DEFAULT 'observed',
      source_json TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(chain_id) REFERENCES merge_chains(id)
    );
    CREATE TABLE icon_harvest_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations(version,name,applied_at) VALUES
      (1,'sqlite-catalog-repository','${LEGACY_CREATED_AT}'),
      (2,'full-snapshot-compatibility','${LEGACY_CREATED_AT}'),
      (3,'independent-display-icon-decision','${LEGACY_CREATED_AT}');
    INSERT INTO merge_chains(
      id,title_key,min_level,max_level,observed_max_level,complete,source_json,updated_at
    ) VALUES(
      'legacy-chain','legacy_chain',1,1,1,1,'{"id":"legacy-chain"}','${LEGACY_CREATED_AT}'
    );
    INSERT INTO items(
      id,chain_id,level,merge_target,icon_resource,energy_cost,base_units,
      confidence,source_json,updated_at
    ) VALUES(
      'legacy-item','legacy-chain',1,NULL,'legacy/icon',NULL,1,
      'observed','{"id":"legacy-item","chainId":"legacy-chain","level":1}','${LEGACY_CREATED_AT}'
    );
    INSERT INTO icon_harvest_jobs(id,status,created_at)
      VALUES('unfinished-job','running','${LEGACY_CREATED_AT}');
    PRAGMA user_version=3;
  `);
  return database;
}

function addLegacyItem(database, itemId) {
  const inserted = database.prepare(`INSERT INTO catalog_repository_objects(
    object_type,object_id,status,disposition,revision,created_at,updated_at
  ) VALUES('item-identity',?,'active','enabled',1,?,?)`).run(
    itemId,
    LEGACY_CREATED_AT,
    LEGACY_CREATED_AT,
  );
  return Number(inserted.lastInsertRowid);
}

function addLegacyCandidate(database, {
  objectId,
  id,
  sourceType,
  rankScore = 1,
  selected = false,
  selectionOrigin = null,
  filePath = `/missing/icon-${id}.png`,
  similarity = { composite: 0.9 },
  assetHash = String(id).padStart(64, "0"),
}) {
  const hash = assetHash;
  database.prepare(`INSERT OR IGNORE INTO catalog_icon_assets(
    hash,mime_type,width,height,byte_size,file_path,created_at
  ) VALUES(?,'image/png',1,1,1,?,?)`).run(
    hash,
    filePath,
    LEGACY_CREATED_AT,
  );
  database.prepare(`INSERT INTO catalog_icon_candidates(
    id,object_id,asset_hash,cache_key,source_type,resource_url,runtime_identifier,
    texture_uuid,crop_json,similarity_json,rank_score,selection_origin,selected,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    objectId,
    hash,
    `legacy-${id}`,
    sourceType,
    `fixture://resource/${id}`,
    `runtime-${id}`,
    `texture-${id}`,
    JSON.stringify({ rect: { x: id, y: 0, width: 1, height: 1 } }),
    JSON.stringify(similarity),
    rankScore,
    selectionOrigin,
    selected ? 1 : 0,
    LEGACY_CREATED_AT,
  );
  return id;
}

function addLegacyDecision(database, {
  objectId,
  selectedCandidateId = null,
  revision = 1,
  selectionOrigin = null,
}) {
  database.prepare(`INSERT INTO catalog_icon_decisions(
    object_id,selected_candidate_id,revision,selection_origin,updated_at
  ) VALUES(?,?,?,?,?)`).run(
    objectId,
    selectedCandidateId,
    revision,
    selectionOrigin,
    LEGACY_CREATED_AT,
  );
}

function addLegacyHistory(database, {
  objectId,
  candidateId = null,
  previousCandidateId = null,
  action,
  revision,
}) {
  database.prepare(`INSERT INTO catalog_icon_selection_history(
    object_id,candidate_id,previous_candidate_id,action,actor,note,
    object_revision,decision_revision,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    objectId,
    candidateId,
    previousCandidateId,
    action,
    "legacy-operator",
    "legacy decision",
    1,
    revision,
    LEGACY_CREATED_AT,
  );
}

function tableCount(database, table) {
  return Number(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function immutableCandidateFields(database) {
  return database.db.prepare(`SELECT
    id,object_id,asset_hash,cache_key,source_type,resource_url,runtime_identifier,
    texture_uuid,crop_json,similarity_json,rank_score,created_at
    FROM catalog_icon_candidates ORDER BY id`).all();
}

test("全新数据库连续启动两次保持相同的空迁移结果", () => withDirectory((directory) => {
  const filePath = path.join(directory, "catalog.db");
  let database = new AutomationDatabase(filePath);
  const first = {
    status: database.getCatalogSchemaStatus(),
    assets: tableCount(database, "catalog_icon_assets"),
    candidates: tableCount(database, "catalog_icon_candidates"),
    selectionAudits: tableCount(database, "catalog_icon_selection_history"),
    currencyAudits: tableCount(database, "catalog_icon_currency_history"),
  };
  database.close();

  database = new AutomationDatabase(filePath);
  assert.deepEqual({
    status: database.getCatalogSchemaStatus(),
    assets: tableCount(database, "catalog_icon_assets"),
    candidates: tableCount(database, "catalog_icon_candidates"),
    selectionAudits: tableCount(database, "catalog_icon_selection_history"),
    currencyAudits: tableCount(database, "catalog_icon_currency_history"),
  }, first);
  assert.equal(first.status.currentVersion, 4);
  assert.equal(first.status.preMigrationBackupPath, null);
  database.close();
}));

test("迁移失败会关闭 SQLite 连接并保留原始错误", () => withDirectory((directory) => {
  const filePath = path.join(directory, "catalog.db");
  const malformed = new DatabaseSync(filePath);
  malformed.exec("CREATE TABLE catalog_repository_objects(id INTEGER); PRAGMA user_version=3;");
  malformed.close();

  assert.throws(
    () => new AutomationDatabase(filePath),
    /no such column/,
  );
  fs.renameSync(filePath, path.join(directory, "closed-catalog.db"));
}));

test("新证据固化来源契约且重复写入只更新可变采集字段", () => withDirectory((directory) => {
  const filePath = path.join(directory, "catalog.db");
  const iconPath = path.join(directory, "icon.png");
  fs.writeFileSync(iconPath, "icon fixture");
  const database = new AutomationDatabase(filePath);
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "new-item",
    payload: { itemId: "new-item" },
    sourceType: "runtime",
  });
  const asset = {
    hash: "9".repeat(64),
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteSize: fs.statSync(iconPath).size,
    filePath: iconPath,
  };
  database.saveIconCandidate({
    itemId: "new-item",
    cacheKey: "stable-acquisition",
    sourceType: "cocos-runtime-resource",
    runtimeIdentifier: "first-runtime-id",
    rankScore: 1,
    asset,
  });
  database.saveIconCandidate({
    itemId: "new-item",
    cacheKey: "stable-acquisition",
    sourceType: "cocos-runtime-resource",
    producer: "unexpected-producer",
    runtimeIdentifier: "refreshed-runtime-id",
    rankScore: 3,
    asset,
  });
  const [candidate] = database.listIconCandidates("new-item");
  assert.equal(candidate.runtimeIdentifier, "refreshed-runtime-id");
  assert.equal(candidate.rankScore, 3);
  assert.deepEqual(candidate.provenance, {
    producer: "cocos-runtime-reconstruction",
    reconstructionVersion: "2",
    qualityContractVersion: "runtime-resource-quality-v1",
  });
  assert.equal(candidate.currency.status, "current");

  const mismatched = database.saveIconCandidate({
    itemId: "new-item",
    cacheKey: "mismatched-producer",
    sourceType: "cocos-runtime-resource",
    producer: "unexpected-producer",
    autoSelect: false,
    asset: { ...asset, hash: "8".repeat(64) },
  });
  assert.equal(mismatched.currency.status, "stale");
  assert.equal(mismatched.currency.reason, "producer-contract-mismatch");
  const beforeRevoke = database.getCatalogObject("item-identity", "new-item").displayIcon;
  database.revokeIconSelection("new-item", {
    actor: "operator",
    note: "暂时保持空值",
    expectedDisplayIconRevision: beforeRevoke.revision,
  });
  const revoked = database.getCatalogObject("item-identity", "new-item").displayIcon;
  assert.equal(revoked.protectedEmpty, true);
  const returned = database.returnIconSelectionToAutomatic("new-item", {
    actor: "operator",
    note: "交回自动选择",
    expectedDisplayIconRevision: revoked.revision,
  });
  assert.equal(returned.displayIcon.manualProtection, false);
  assert.equal(returned.displayIcon.selectedCandidate.id, candidate.id);
  database.close();

  const reopened = new AutomationDatabase(filePath);
  const persisted = reopened.getCatalogObject("item-identity", "new-item").displayIcon;
  assert.equal(persisted.manualProtection, false);
  assert.equal(persisted.selectedCandidate.id, candidate.id);
  reopened.close();
}));

test("Schema v4 图标证据迁移保留来源并按来源契约评估时效", () => withDirectory((directory) => {
  const filePath = path.join(directory, "catalog.db");
  const legacy = createLegacyV3Database(filePath);
  const runtimeObject = addLegacyItem(legacy, "runtime-item");
  const screenshotObject = addLegacyItem(legacy, "screenshot-item");
  const uploadObject = addLegacyItem(legacy, "upload-item");
  addLegacyCandidate(legacy, { objectId: runtimeObject, id: 1, sourceType: "cocos-runtime-resource" });
  addLegacyCandidate(legacy, { objectId: screenshotObject, id: 2, sourceType: "screenshot-runtime" });
  addLegacyCandidate(legacy, { objectId: uploadObject, id: 3, sourceType: "user-upload" });
  const evidence = legacy.prepare(`INSERT INTO catalog_repository_evidence(
    object_id,fingerprint,source_type,source_ref,payload_json,disposition,
    observation_count,first_observed_at,last_observed_at
  ) VALUES(?,?,?,?,?,'eligible',1,?,?)`).run(
    runtimeObject,
    "legacy-evidence-fingerprint",
    "legacy-import",
    "sanitized-fixture",
    JSON.stringify({ itemId: "runtime-item" }),
    LEGACY_CREATED_AT,
    LEGACY_CREATED_AT,
  );
  legacy.prepare(`INSERT INTO catalog_repository_rulings(
    object_id,field_path,decision,value_json,actor,note,old_value_json,
    new_value_json,object_revision,created_at
  ) VALUES(?,'displayName','confirm','"保留名称"','operator','sanitized ruling',
    'null','"保留名称"',1,?)`).run(runtimeObject, LEGACY_CREATED_AT);
  legacy.prepare(`INSERT INTO catalog_evidence_audit_summaries(
    object_id,evidence_id,object_revision,action,summary_json,created_at
  ) VALUES(?,?,1,'adopt',?,?)`).run(
    runtimeObject,
    Number(evidence.lastInsertRowid),
    JSON.stringify({ message: "保留旧证据审计" }),
    LEGACY_CREATED_AT,
  );
  const traceCountsBefore = {
    evidence: Number(legacy.prepare("SELECT COUNT(*) AS count FROM catalog_repository_evidence").get().count),
    rulings: Number(legacy.prepare("SELECT COUNT(*) AS count FROM catalog_repository_rulings").get().count),
    evidenceAudits: Number(legacy.prepare("SELECT COUNT(*) AS count FROM catalog_evidence_audit_summaries").get().count),
  };
  const immutableBefore = legacy.prepare(`SELECT
    id,object_id,asset_hash,cache_key,source_type,resource_url,runtime_identifier,
    texture_uuid,crop_json,similarity_json,rank_score,created_at
    FROM catalog_icon_candidates ORDER BY id`).all();
  legacy.close();

  let database = new AutomationDatabase(filePath);
  const backupPath = `${filePath}.pre-v4.bak`;
  const status = database.getCatalogSchemaStatus();
  const candidates = Object.fromEntries(
    ["runtime-item", "screenshot-item", "upload-item"]
      .map((itemId) => [itemId, database.listIconCandidates(itemId)[0]]),
  );

  assert.equal(status.currentVersion, 4);
  assert.equal(status.preMigrationBackupPath, backupPath);
  assert.equal(fs.existsSync(backupPath), true);
  assert.deepEqual(immutableCandidateFields(database), immutableBefore);
  assert.deepEqual(
    {
      runtime: [candidates["runtime-item"].currency.status, candidates["runtime-item"].currency.reason],
      screenshot: [candidates["screenshot-item"].currency.status, candidates["screenshot-item"].currency.reason],
      upload: [candidates["upload-item"].currency.status, candidates["upload-item"].currency.reason],
    },
    {
      runtime: ["stale", "legacy-runtime-reconstruction-version-missing"],
      screenshot: ["current", "source-contract-does-not-require-runtime-reconstruction"],
      upload: ["current", "source-contract-does-not-require-runtime-reconstruction"],
    },
  );
  assert.deepEqual(candidates["runtime-item"].provenance, {
    producer: null,
    reconstructionVersion: null,
    qualityContractVersion: null,
  });
  assert.equal(tableCount(database, "catalog_icon_currency_history"), 3);
  assert.deepEqual({
    evidence: tableCount(database, "catalog_repository_evidence"),
    rulings: tableCount(database, "catalog_repository_rulings"),
    evidenceAudits: tableCount(database, "catalog_evidence_audit_summaries"),
  }, traceCountsBefore);
  const firstEvaluations = database.db.prepare(
    "SELECT id,currency_evaluated_at FROM catalog_icon_candidates ORDER BY id",
  ).all();
  const backupHash = crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");
  const backupMtime = fs.statSync(backupPath).mtimeMs;
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(Number(backup.prepare("PRAGMA user_version").get().user_version), 3);
  assert.equal(
    Number(backup.prepare("SELECT COUNT(*) AS count FROM catalog_icon_candidates").get().count),
    3,
  );
  backup.close();
  const restoredPath = path.join(directory, "restored-v3.db");
  fs.copyFileSync(backupPath, restoredPath);
  const restored = new DatabaseSync(restoredPath);
  assert.equal(restored.prepare("SELECT source_type FROM catalog_icon_candidates WHERE id=1").get().source_type, "cocos-runtime-resource");
  assert.equal(restored.prepare("SELECT icon_resource FROM items WHERE id='legacy-item'").get().icon_resource, "legacy/icon");
  restored.close();
  database.close();

  database = new AutomationDatabase(filePath);
  assert.deepEqual(
    database.db.prepare("SELECT id,currency_evaluated_at FROM catalog_icon_candidates ORDER BY id").all(),
    firstEvaluations,
  );
  assert.equal(tableCount(database, "catalog_icon_currency_history"), 3);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex"),
    backupHash,
  );
  assert.equal(fs.statSync(backupPath).mtimeMs, backupMtime);
  database.close();
}));

test("边界迁移清理 stale 自动选择并保护人工选择和人工空值", () => withDirectory((directory) => {
  const filePath = path.join(directory, "catalog.db");
  const legacy = createLegacyV3Database(filePath);

  const automaticObject = addLegacyItem(legacy, "automatic-item");
  addLegacyCandidate(legacy, {
    objectId: automaticObject,
    id: 10,
    sourceType: "cocos-runtime-resource",
    selected: true,
    selectionOrigin: null,
  });
  const availableIcon = path.join(directory, "available.png");
  fs.writeFileSync(availableIcon, "available icon fixture");
  addLegacyCandidate(legacy, {
    objectId: automaticObject,
    id: 11,
    sourceType: "screenshot-runtime",
    rankScore: 5,
    filePath: availableIcon,
  });
  addLegacyDecision(legacy, {
    objectId: automaticObject,
    selectedCandidateId: 10,
    revision: 2,
    selectionOrigin: null,
  });

  const manualObject = addLegacyItem(legacy, "manual-item");
  addLegacyCandidate(legacy, {
    objectId: manualObject,
    id: 20,
    sourceType: "cocos-runtime-resource",
    selected: true,
    selectionOrigin: "manual",
  });
  addLegacyDecision(legacy, {
    objectId: manualObject,
    selectedCandidateId: 20,
    revision: 2,
    selectionOrigin: "manual",
  });
  addLegacyHistory(legacy, {
    objectId: manualObject,
    candidateId: 20,
    action: "manual-select",
    revision: 2,
  });

  const revokedObject = addLegacyItem(legacy, "revoked-item");
  addLegacyCandidate(legacy, {
    objectId: revokedObject,
    id: 30,
    sourceType: "user-upload",
    rankScore: 10,
  });
  addLegacyDecision(legacy, {
    objectId: revokedObject,
    revision: 3,
  });
  addLegacyHistory(legacy, {
    objectId: revokedObject,
    previousCandidateId: 30,
    action: "manual-revoke",
    revision: 3,
  });

  const fillObject = addLegacyItem(legacy, "fill-item");
  addLegacyCandidate(legacy, {
    objectId: fillObject,
    id: 40,
    sourceType: "screenshot-runtime",
    rankScore: 4,
    filePath: availableIcon,
  });
  addLegacyCandidate(legacy, {
    objectId: fillObject,
    id: 41,
    sourceType: "user-upload",
    rankScore: 4,
    filePath: availableIcon,
  });
  addLegacyCandidate(legacy, {
    objectId: fillObject,
    id: 42,
    sourceType: "user-upload",
    rankScore: 100,
  });
  addLegacyCandidate(legacy, {
    objectId: fillObject,
    id: 43,
    sourceType: "screenshot-runtime",
    rankScore: 99,
    filePath: availableIcon,
    similarity: { qualityGate: { status: "rejected", reasons: ["fixture-rejection"] } },
  });
  addLegacyCandidate(legacy, {
    objectId: fillObject,
    id: 44,
    sourceType: "screenshot-runtime",
    rankScore: 1,
    filePath: availableIcon,
    assetHash: String(40).padStart(64, "0"),
  });
  addLegacyDecision(legacy, { objectId: fillObject });

  const missingAutomaticObject = addLegacyItem(legacy, "missing-automatic-item");
  addLegacyCandidate(legacy, {
    objectId: missingAutomaticObject,
    id: 60,
    sourceType: "user-upload",
    selected: true,
    selectionOrigin: "automatic",
  });
  addLegacyDecision(legacy, {
    objectId: missingAutomaticObject,
    selectedCandidateId: 60,
    revision: 2,
    selectionOrigin: "automatic",
  });

  const before = {
    assets: Number(legacy.prepare("SELECT COUNT(*) AS count FROM catalog_icon_assets").get().count),
    candidates: Number(legacy.prepare("SELECT COUNT(*) AS count FROM catalog_icon_candidates").get().count),
    decisions: Number(legacy.prepare("SELECT COUNT(*) AS count FROM catalog_icon_decisions").get().count),
    selectionAudits: Number(legacy.prepare("SELECT COUNT(*) AS count FROM catalog_icon_selection_history").get().count),
  };
  legacy.close();

  let database = new AutomationDatabase(filePath);
  const automatic = database.getCatalogObject("item-identity", "automatic-item").displayIcon;
  const manual = database.getCatalogObject("item-identity", "manual-item").displayIcon;
  const revoked = database.getCatalogObject("item-identity", "revoked-item").displayIcon;
  const fill = database.getCatalogObject("item-identity", "fill-item").displayIcon;
  const missingAutomatic = database.getCatalogObject(
    "item-identity",
    "missing-automatic-item",
  ).displayIcon;

  assert.equal(automatic.selectedCandidate.id, 11);
  assert.deepEqual(automatic.history.slice(-2).map((entry) => entry.action), [
    "automatic-invalidate-stale",
    "automatic-select-current",
  ]);
  assert.match(automatic.history.at(-2).note, /旧版运行时重建版本缺失/);
  assert.equal(manual.selectedCandidate.id, 20);
  assert.equal(manual.selectedCandidate.currency.status, "stale");
  assert.equal(manual.manualProtection, true);
  assert.equal(revoked.selectedIcon, null);
  assert.equal(revoked.manualProtection, true);
  assert.equal(revoked.protectedEmpty, true);
  assert.equal(fill.selectedCandidate.id, 40);
  assert.equal(fill.selectedCandidate.selectionOrigin, "automatic");
  assert.equal(missingAutomatic.selectedCandidate, null);
  assert.equal(missingAutomatic.history.at(-1).action, "automatic-invalidate-ineligible");
  assert.equal(tableCount(database, "catalog_icon_assets"), before.assets);
  assert.equal(tableCount(database, "catalog_icon_candidates"), before.candidates);
  assert.equal(tableCount(database, "catalog_icon_decisions"), before.decisions);
  assert.ok(tableCount(database, "catalog_icon_selection_history") >= before.selectionAudits);
  assert.equal(tableCount(database, "icon_harvest_jobs"), 1);
  assert.equal(
    database.db.prepare("SELECT status FROM icon_harvest_jobs WHERE id='unfinished-job'").get().status,
    "running",
  );
  assert.ok(database.db.prepare(`SELECT asset_hash,COUNT(*) AS count
    FROM catalog_icon_candidates GROUP BY asset_hash HAVING COUNT(*)>1`).get());

  const countsAfterFirst = {
    selectionAudits: tableCount(database, "catalog_icon_selection_history"),
    currencyAudits: tableCount(database, "catalog_icon_currency_history"),
  };
  database.close();

  database = new AutomationDatabase(filePath);
  assert.deepEqual({
    selectionAudits: tableCount(database, "catalog_icon_selection_history"),
    currencyAudits: tableCount(database, "catalog_icon_currency_history"),
  }, countsAfterFirst);
  assert.equal(database.getCatalogObject("item-identity", "manual-item").displayIcon.selectedCandidate.id, 20);
  assert.equal(database.getCatalogObject("item-identity", "revoked-item").displayIcon.protectedEmpty, true);
  database.close();
}));

test("同状态重新评估只更新策略投影且旧目录读写路径继续可用", () => withDirectory((directory) => {
  const filePath = path.join(directory, "catalog.db");
  const legacy = createLegacyV3Database(filePath);
  const objectId = addLegacyItem(legacy, "screenshot-item");
  addLegacyCandidate(legacy, { objectId, id: 50, sourceType: "screenshot-runtime" });
  addLegacyDecision(legacy, { objectId });
  legacy.close();

  let database = new AutomationDatabase(filePath);
  const auditCount = tableCount(database, "catalog_icon_currency_history");
  database.db.prepare(`UPDATE catalog_icon_candidates
    SET currency_policy_version='',currency_evaluated_at=? WHERE id=50`)
    .run("2026-07-02T00:00:00.000Z");
  database.close();

  database = new AutomationDatabase(filePath);
  const candidate = database.listIconCandidates("screenshot-item")[0];
  assert.equal(candidate.currency.status, "current");
  assert.notEqual(candidate.currency.policyVersion, "");
  assert.equal(tableCount(database, "catalog_icon_currency_history"), auditCount);
  assert.equal(database.getCatalogStats().items, 1);

  database.importCatalog({
    chains: [{
      id: "legacy-chain",
      minLevel: 1,
      maxLevel: 1,
      observedMaxLevel: 1,
      complete: true,
      itemIds: ["legacy-item"],
    }],
    items: [{
      id: "legacy-item",
      chainId: "legacy-chain",
      level: 1,
      baseUnits: 1,
      mergeTarget: null,
      iconResource: "legacy/icon-v2",
    }],
    producers: [],
  }, { sourceFile: "legacy-catalog.json" });
  assert.equal(
    database.db.prepare("SELECT icon_resource FROM items WHERE id='legacy-item'").get().icon_resource,
    "legacy/icon-v2",
  );
  database.close();

  database = new AutomationDatabase(filePath);
  database.db.prepare(`UPDATE catalog_icon_candidates SET
    quality_contract_version='obsolete-screenshot-quality',
    currency_status='current'
    WHERE id=50`).run();
  database.close();

  database = new AutomationDatabase(filePath);
  const stale = database.listIconCandidates("screenshot-item")[0];
  assert.equal(stale.currency.status, "stale");
  assert.equal(stale.currency.reason, "quality-contract-version-mismatch");
  assert.equal(tableCount(database, "catalog_icon_currency_history"), auditCount + 1);
  database.close();
}));
