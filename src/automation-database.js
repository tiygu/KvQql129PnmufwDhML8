"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { canonicalJson } = require("./canonical-json");

const CATALOG_OBJECT_TYPES = new Set(["item-identity", "merge-relation", "production-profile"]);
const CATALOG_VERSION_STATES = new Set(["observed", "provisional", "active"]);
const CATALOG_VERSION_ORIGINS = new Set(["user", "legacy-migration", "inference-gate", "observation", "unspecified"]);
const CATALOG_DISPOSITIONS = new Set(["enabled", "paused", "rejected"]);
const CATALOG_EVIDENCE_DISPOSITIONS = new Set(["eligible", "paused", "rejected"]);
const CATALOG_RULING_DECISIONS = new Set(["confirm", "modify", "revoke"]);
const UNSAFE_FIELD_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

function fieldSegments(fieldPath) {
  const normalized = String(fieldPath || "").trim();
  const segments = normalized.split(".");
  if (!normalized || segments.some((segment) => !segment || UNSAFE_FIELD_SEGMENTS.has(segment))) throw new TypeError("catalog ruling fieldPath is invalid");
  return segments;
}

function fieldValue(payload, fieldPath) {
  let value = payload;
  for (const segment of fieldSegments(fieldPath)) value = value == null ? undefined : value[segment];
  return value;
}

function setFieldValue(payload, fieldPath, value) {
  const result = structuredClone(payload || {});
  const segments = fieldSegments(fieldPath);
  let target = result;
  for (const segment of segments.slice(0, -1)) {
    if (!target[segment] || typeof target[segment] !== "object") target[segment] = {};
    target = target[segment];
  }
  target[segments.at(-1)] = structuredClone(value);
  return result;
}

function validateCatalogIdentity(objectType, objectId) {
  const normalizedType = String(objectType || "");
  const normalizedId = String(objectId || "");
  if (!CATALOG_OBJECT_TYPES.has(normalizedType)) throw new TypeError(`unsupported catalog object type: ${normalizedType}`);
  if (!normalizedId) throw new TypeError("catalog object id is required");
  return { objectType: normalizedType, objectId: normalizedId };
}

class AutomationDatabase {
  constructor(filePath = "data/automation.db") {
    this.filePath = path.resolve(String(filePath));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.transactionDepth = 0;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  transaction(work) {
    if (typeof work !== "function") throw new TypeError("transaction work must be a function");
    if (this.transactionDepth > 0) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merge_chains (
        id TEXT PRIMARY KEY, title_key TEXT, min_level INTEGER, max_level INTEGER,
        observed_max_level INTEGER, complete INTEGER NOT NULL DEFAULT 0,
        source_json TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, chain_id TEXT, level INTEGER, merge_target TEXT,
        icon_resource TEXT, energy_cost REAL, base_units REAL,
        confidence TEXT NOT NULL DEFAULT 'observed', source_json TEXT, updated_at TEXT NOT NULL,
        FOREIGN KEY(chain_id) REFERENCES merge_chains(id)
      );
      CREATE TABLE IF NOT EXISTS producers (
        item_id TEXT PRIMARY KEY, chain_id TEXT, level INTEGER, energy_cost REAL,
        sample_size INTEGER, source_json TEXT, updated_at TEXT NOT NULL,
        FOREIGN KEY(item_id) REFERENCES items(id)
      );
      CREATE TABLE IF NOT EXISTS producer_drops (
        producer_item_id TEXT NOT NULL, item_id TEXT NOT NULL, probability REAL,
        sample_count INTEGER, chain_id TEXT, level INTEGER, base_units REAL,
        PRIMARY KEY(producer_item_id, item_id),
        FOREIGN KEY(producer_item_id) REFERENCES producers(item_id)
      );
      CREATE TABLE IF NOT EXISTS catalog_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        source_file TEXT, confidence TEXT NOT NULL, payload_json TEXT, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_repository_objects (
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
      CREATE TABLE IF NOT EXISTS catalog_repository_evidence (
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
      CREATE TABLE IF NOT EXISTS catalog_repository_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'unspecified',
        payload_json TEXT NOT NULL,
        evidence_summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(object_id, version),
        FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS catalog_repository_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        conflict_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        details_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(object_type, object_id, conflict_type, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS catalog_repository_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id INTEGER NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        from_disposition TEXT NOT NULL,
        to_disposition TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(object_id,to_status,to_disposition,reason,evidence_revision),
        FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS catalog_repository_rulings (
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
      CREATE TABLE IF NOT EXISTS automation_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, started_at TEXT NOT NULL,
        ended_at TEXT, status TEXT NOT NULL, settings_json TEXT
      );
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, sequence INTEGER,
        action_type TEXT NOT NULL, reason TEXT, ok INTEGER, before_json TEXT, after_json TEXT,
        details_json TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES automation_sessions(id)
      );
      CREATE TABLE IF NOT EXISTS order_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, slot TEXT, task_id TEXT,
        reward_coins REAL, estimated_energy REAL, actual_energy REAL, status TEXT,
        started_at TEXT, ended_at TEXT, details_json TEXT
      );
      CREATE TABLE IF NOT EXISTS map_mission_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, mission_id TEXT,
        next_mission_id TEXT, coins_spent REAL, status TEXT, started_at TEXT, ended_at TEXT,
        details_json TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER,
        coins REAL, energy REAL, diamonds REAL, scene TEXT, observed_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES automation_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_actions_session_sequence ON actions(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_observations_entity ON catalog_observations(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_state ON catalog_repository_objects(status, object_type);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_evidence_object ON catalog_repository_evidence(object_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_versions_object ON catalog_repository_versions(object_id, version);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_conflicts_status ON catalog_repository_conflicts(status, object_type);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_transitions_object ON catalog_repository_transitions(object_id, id);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_rulings_object_field ON catalog_repository_rulings(object_id, field_path, id);
      CREATE INDEX IF NOT EXISTS idx_resource_samples_observed ON resource_samples(observed_at);
    `);
    const versionColumns = new Set(this.db.prepare("PRAGMA table_info(catalog_repository_versions)").all().map((column) => column.name));
    if (!versionColumns.has("origin")) this.db.exec("ALTER TABLE catalog_repository_versions ADD COLUMN origin TEXT NOT NULL DEFAULT 'unspecified'");
    const objectColumns = new Set(this.db.prepare("PRAGMA table_info(catalog_repository_objects)").all().map((column) => column.name));
    if (!objectColumns.has("disposition")) this.db.exec("ALTER TABLE catalog_repository_objects ADD COLUMN disposition TEXT NOT NULL DEFAULT 'enabled'");
    const evidenceColumns = new Set(this.db.prepare("PRAGMA table_info(catalog_repository_evidence)").all().map((column) => column.name));
    if (!evidenceColumns.has("disposition")) this.db.exec("ALTER TABLE catalog_repository_evidence ADD COLUMN disposition TEXT NOT NULL DEFAULT 'eligible'");
  }

  _catalogObjectRow(objectType, objectId) {
    return this.db.prepare("SELECT * FROM catalog_repository_objects WHERE object_type=? AND object_id=?").get(objectType, objectId) || null;
  }

  _assertCatalogRevision(object, expectedRevision, fieldPath = null) {
    if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 1) {
      const required = new Error("catalog expectedRevision is required");
      required.code = "CATALOG_REVISION_REQUIRED";
      required.statusCode = 428;
      throw required;
    }
    if (Number(expectedRevision) === Number(object.revision)) return;
    const conflict = new Error(`catalog revision conflict: expected ${expectedRevision}, actual ${object.revision}`);
    conflict.code = "CATALOG_REVISION_CONFLICT";
    conflict.statusCode = 409;
    conflict.currentObject = this._catalogObjectResult(object);
    if (fieldPath) conflict.fieldPath = fieldPath;
    throw conflict;
  }

  _catalogEvidenceSummary(repositoryObjectId) {
    const rows = this.db.prepare(`SELECT source_type,source_ref,observation_count
      FROM catalog_repository_evidence WHERE object_id=? ORDER BY source_type,source_ref`).all(repositoryObjectId);
    return {
      evidenceCount: rows.length,
      observationCount: rows.reduce((sum, row) => sum + Number(row.observation_count), 0),
      sources: rows.map((row) => ({ sourceType: row.source_type, sourceRef: row.source_ref || null, observationCount: Number(row.observation_count) })),
    };
  }

  _catalogVersion(versionId) {
    if (versionId == null) return null;
    const row = this.db.prepare("SELECT * FROM catalog_repository_versions WHERE id=?").get(versionId);
    return row ? {
      id: Number(row.id), version: Number(row.version), status: row.status,
      origin: row.origin, payload: parseJson(row.payload_json), evidenceSummary: parseJson(row.evidence_summary_json), createdAt: row.created_at,
    } : null;
  }

  _catalogTransition(row) {
    return row ? {
      id: Number(row.id), fromStatus: row.from_status, toStatus: row.to_status,
      fromDisposition: row.from_disposition, toDisposition: row.to_disposition,
      reason: row.reason, evidenceRevision: Number(row.evidence_revision), createdAt: row.created_at,
    } : null;
  }

  _latestCatalogTransition(repositoryObjectId) {
    return this._catalogTransition(this.db.prepare("SELECT * FROM catalog_repository_transitions WHERE object_id=? ORDER BY id DESC LIMIT 1").get(repositoryObjectId));
  }

  _catalogRulingRow(row) {
    return row ? {
      id: Number(row.id), fieldPath: row.field_path, decision: row.decision,
      value: parseJson(row.value_json), actor: row.actor, note: row.note,
      oldValue: parseJson(row.old_value_json), newValue: parseJson(row.new_value_json),
      objectRevision: Number(row.object_revision), createdAt: row.created_at,
    } : null;
  }

  _catalogRulings(repositoryObjectId) {
    return this.db.prepare("SELECT * FROM catalog_repository_rulings WHERE object_id=? ORDER BY id").all(repositoryObjectId).map((row) => this._catalogRulingRow(row));
  }

  _activeCatalogRulings(repositoryObjectId) {
    const active = new Map();
    for (const ruling of this._catalogRulings(repositoryObjectId)) {
      if (ruling.decision === "revoke") active.delete(ruling.fieldPath);
      else active.set(ruling.fieldPath, ruling);
    }
    return active;
  }

  _catalogAlgorithmCandidate(row) {
    const version = this._catalogVersion(row.active_version_id) || this._catalogVersion(row.candidate_version_id)
      || this._catalogVersion(this.db.prepare("SELECT id FROM catalog_repository_versions WHERE object_id=? ORDER BY version DESC LIMIT 1").get(row.id)?.id);
    return version?.payload || {};
  }

  _catalogReviewReasons(row, algorithmCandidate, activeRulings) {
    const reasons = [];
    const versionCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM catalog_repository_versions WHERE object_id=?").get(row.id).count);
    if (row.status === "observed") reasons.push({ type: "new-observation", message: "新观测等待更多证据或人工检查" });
    if (versionCount > 1) reasons.push({ type: "inference-change", message: "算法候选或生效状态已变化" });
    for (const conflict of this.db.prepare("SELECT conflict_type,details_json FROM catalog_repository_conflicts WHERE object_type=? AND object_id=? AND status='open' ORDER BY id").all(row.object_type, row.object_id)) {
      reasons.push({ type: "evidence-conflict", conflictType: conflict.conflict_type, details: parseJson(conflict.details_json), message: "证据来源存在冲突" });
    }
    if (row.object_type === "item-identity" && (algorithmCandidate.iconEvidenceStatus === "missing" || (!algorithmCandidate.iconResourceIdentifier && !algorithmCandidate.iconResource))) {
      reasons.push({ type: "icon-gap", fieldPath: "iconResourceIdentifier", message: "缺少物品图标证据" });
    }
    for (const ruling of activeRulings.values()) {
      const candidate = fieldValue(algorithmCandidate, ruling.fieldPath);
      if (canonicalJson(candidate ?? null) !== canonicalJson(ruling.value ?? null)) {
        reasons.push({ type: "human-ruling-conflict", fieldPath: ruling.fieldPath, candidate, humanValue: ruling.value, message: "算法证据与人工裁决冲突" });
      }
    }
    return reasons;
  }

  _catalogObjectResult(row, { includeHistory = true } = {}) {
    if (!row) return null;
    const result = {
      objectType: row.object_type,
      objectId: row.object_id,
      status: row.status,
      disposition: row.disposition,
      revision: Number(row.revision),
      evidenceSummary: this._catalogEvidenceSummary(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestTransition: this._latestCatalogTransition(row.id),
    };
    if (!includeHistory) return result;
    result.candidateVersion = this._catalogVersion(row.candidate_version_id);
    result.activeVersion = this._catalogVersion(row.active_version_id);
    result.evidence = this.db.prepare("SELECT * FROM catalog_repository_evidence WHERE object_id=? ORDER BY id").all(row.id).map((evidence) => ({
      id: Number(evidence.id), fingerprint: evidence.fingerprint, sourceType: evidence.source_type,
      sourceRef: evidence.source_ref || null, payload: parseJson(evidence.payload_json), disposition: evidence.disposition,
      observationCount: Number(evidence.observation_count),
      firstObservedAt: evidence.first_observed_at, lastObservedAt: evidence.last_observed_at,
    }));
    result.versions = this.db.prepare("SELECT * FROM catalog_repository_versions WHERE object_id=? ORDER BY version").all(row.id).map((version) => ({
      id: Number(version.id), version: Number(version.version), status: version.status,
      origin: version.origin, payload: parseJson(version.payload_json), evidenceSummary: parseJson(version.evidence_summary_json), createdAt: version.created_at,
    }));
    result.transitions = this.db.prepare("SELECT * FROM catalog_repository_transitions WHERE object_id=? ORDER BY id").all(row.id).map((transition) => this._catalogTransition(transition));
    result.algorithmCandidate = this._catalogAlgorithmCandidate(row);
    const activeRulings = this._activeCatalogRulings(row.id);
    result.humanValues = Object.fromEntries(activeRulings);
    result.effectiveValue = [...activeRulings.values()].reduce((payload, ruling) => setFieldValue(payload, ruling.fieldPath, ruling.value), result.algorithmCandidate);
    result.rulingHistory = this._catalogRulings(row.id);
    result.reviewReasons = this._catalogReviewReasons(row, result.algorithmCandidate, activeRulings);
    result.reviewStatus = result.reviewReasons.length ? "needs-review" : "clear";
    return result;
  }

  _observeCatalogObject(input) {
    const { objectType, objectId } = validateCatalogIdentity(input.objectType, input.objectId);
    if (input.payload == null || typeof input.payload !== "object") throw new TypeError("catalog observation payload is required");
    const sourceType = String(input.sourceType || "runtime");
    const sourceRef = input.sourceRef == null ? "" : String(input.sourceRef);
    const payloadJson = canonicalJson(input.payload);
    const fingerprint = crypto.createHash("sha256").update(payloadJson).digest("hex");
    const now = input.observedAt || new Date().toISOString();
    let object = this._catalogObjectRow(objectType, objectId);
    if (object && input.countDuplicate === false) {
      const existingEvidence = this.db.prepare(`SELECT id FROM catalog_repository_evidence
        WHERE object_id=? AND fingerprint=? AND source_type=? AND source_ref=?`).get(object.id, fingerprint, sourceType, sourceRef);
      if (existingEvidence) return this._catalogObjectResult(object);
    }
    if (!object) {
      const inserted = this.db.prepare(`INSERT INTO catalog_repository_objects(object_type,object_id,status,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).run(objectType, objectId, "observed", 1, now, now);
      object = this.db.prepare("SELECT * FROM catalog_repository_objects WHERE id=?").get(Number(inserted.lastInsertRowid));
    } else {
      this.db.prepare("UPDATE catalog_repository_objects SET revision=revision+1,updated_at=? WHERE id=?").run(now, object.id);
    }
    this.db.prepare(`INSERT INTO catalog_repository_evidence(object_id,fingerprint,source_type,source_ref,payload_json,observation_count,first_observed_at,last_observed_at)
      VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(object_id,fingerprint,source_type,source_ref)
      DO UPDATE SET observation_count=observation_count+1,last_observed_at=excluded.last_observed_at`)
      .run(object.id, fingerprint, sourceType, sourceRef, payloadJson, now, now);
    const versionCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM catalog_repository_versions WHERE object_id=?").get(object.id).count);
    if (versionCount === 0) {
      const summary = this._catalogEvidenceSummary(object.id);
      this.db.prepare(`INSERT INTO catalog_repository_versions(object_id,version,status,origin,payload_json,evidence_summary_json,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(object.id, 1, "observed", "observation", payloadJson, JSON.stringify(summary), now);
    }
    return this._catalogObjectResult(this._catalogObjectRow(objectType, objectId));
  }

  observeCatalogObject(input) {
    return this.transaction(() => this._observeCatalogObject(input));
  }

  observeCatalogBatch(observations) {
    if (!Array.isArray(observations)) throw new TypeError("catalog observations must be an array");
    return this.transaction(() => observations.map((observation) => this._observeCatalogObject(observation)));
  }

  saveCatalogVersion({ objectType, objectId, payload, status = "provisional", expectedRevision = null, origin = "user" }) {
    const identity = validateCatalogIdentity(objectType, objectId);
    if (!CATALOG_VERSION_STATES.has(status)) throw new TypeError(`unsupported catalog version status: ${status}`);
    if (!CATALOG_VERSION_ORIGINS.has(String(origin))) throw new TypeError(`unsupported catalog version origin: ${origin}`);
    if (payload == null || typeof payload !== "object") throw new TypeError("catalog version payload is required");
    return this.transaction(() => {
      const object = this._catalogObjectRow(identity.objectType, identity.objectId);
      if (!object) throw new Error(`catalog object not found: ${identity.objectType}/${identity.objectId}`);
      this._assertCatalogRevision(object, expectedRevision);
      const nextVersion = Number(this.db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM catalog_repository_versions WHERE object_id=?").get(object.id).version);
      const now = new Date().toISOString();
      const inserted = this.db.prepare(`INSERT INTO catalog_repository_versions(object_id,version,status,origin,payload_json,evidence_summary_json,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(object.id, nextVersion, status, String(origin || "user"), canonicalJson(payload), JSON.stringify(this._catalogEvidenceSummary(object.id)), now);
      const versionId = Number(inserted.lastInsertRowid);
      if (status === "active") {
        this.db.prepare("UPDATE catalog_repository_objects SET status='active',active_version_id=?,revision=revision+1,updated_at=? WHERE id=?").run(versionId, now, object.id);
      } else if (status === "provisional") {
        this.db.prepare("UPDATE catalog_repository_objects SET status='provisional',candidate_version_id=?,active_version_id=NULL,revision=revision+1,updated_at=? WHERE id=?").run(versionId, now, object.id);
      } else {
        this.db.prepare("UPDATE catalog_repository_objects SET status='observed',candidate_version_id=NULL,active_version_id=NULL,revision=revision+1,updated_at=? WHERE id=?").run(now, object.id);
      }
      return this._catalogObjectResult(this._catalogObjectRow(identity.objectType, identity.objectId));
    });
  }

  activateCatalogCandidate(objectType, objectId, { expectedRevision = null } = {}) {
    const identity = validateCatalogIdentity(objectType, objectId);
    const object = this._catalogObjectRow(identity.objectType, identity.objectId);
    if (!object?.candidate_version_id) throw new Error(`catalog candidate not found: ${identity.objectType}/${identity.objectId}`);
    this._assertCatalogRevision(object, expectedRevision);
    const candidate = this._catalogVersion(object.candidate_version_id);
    return this.saveCatalogVersion({ ...identity, payload: candidate.payload, status: "active", expectedRevision });
  }

  _recordCatalogTransition(object, { fromStatus, fromDisposition, reason, evidenceRevision }) {
    this.db.prepare(`INSERT OR IGNORE INTO catalog_repository_transitions(object_id,from_status,to_status,from_disposition,to_disposition,reason,evidence_revision,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      object.id, fromStatus, object.status, fromDisposition, object.disposition,
      String(reason), Number(evidenceRevision), new Date().toISOString(),
    );
  }

  transitionCatalogObject({ objectType, objectId, status, payload, reason, expectedRevision, origin = "inference-gate" }) {
    const identity = validateCatalogIdentity(objectType, objectId);
    if (!CATALOG_VERSION_STATES.has(String(status))) throw new TypeError(`unsupported catalog version status: ${status}`);
    if (!reason) throw new TypeError("catalog transition reason is required");
    return this.transaction(() => {
      const before = this._catalogObjectRow(identity.objectType, identity.objectId);
      if (!before) throw new Error(`catalog object not found: ${identity.objectType}/${identity.objectId}`);
      this._assertCatalogRevision(before, expectedRevision);
      const currentVersion = before.active_version_id ? this._catalogVersion(before.active_version_id)
        : before.candidate_version_id ? this._catalogVersion(before.candidate_version_id)
          : this.db.prepare("SELECT * FROM catalog_repository_versions WHERE object_id=? ORDER BY version DESC LIMIT 1").get(before.id);
      const currentPayload = currentVersion?.payload ?? parseJson(currentVersion?.payload_json);
      let after;
      if (before.status === status && canonicalJson(currentPayload) === canonicalJson(payload)) {
        after = before;
      } else {
        this.saveCatalogVersion({ ...identity, status, payload, expectedRevision: before.revision, origin });
        after = this._catalogObjectRow(identity.objectType, identity.objectId);
      }
      this._recordCatalogTransition(after, {
        fromStatus: before.status,
        fromDisposition: before.disposition,
        reason,
        evidenceRevision: after.revision,
      });
      return this._catalogObjectResult(after);
    });
  }

  setCatalogObjectDisposition(objectType, objectId, disposition, { reason, expectedRevision } = {}) {
    const identity = validateCatalogIdentity(objectType, objectId);
    if (!CATALOG_DISPOSITIONS.has(String(disposition))) throw new TypeError(`unsupported catalog object disposition: ${disposition}`);
    if (!reason) throw new TypeError("catalog disposition reason is required");
    return this.transaction(() => {
      const before = this._catalogObjectRow(identity.objectType, identity.objectId);
      if (!before) throw new Error(`catalog object not found: ${identity.objectType}/${identity.objectId}`);
      this._assertCatalogRevision(before, expectedRevision);
      if (before.disposition === disposition) return this._catalogObjectResult(before);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE catalog_repository_objects SET disposition=?,revision=revision+1,updated_at=? WHERE id=?").run(String(disposition), now, before.id);
      const after = this._catalogObjectRow(identity.objectType, identity.objectId);
      this._recordCatalogTransition(after, { fromStatus: before.status, fromDisposition: before.disposition, reason, evidenceRevision: after.revision });
      return this._catalogObjectResult(after);
    });
  }

  setCatalogEvidenceDisposition(objectType, objectId, evidenceId, disposition, { reason, expectedRevision } = {}) {
    const identity = validateCatalogIdentity(objectType, objectId);
    if (!CATALOG_EVIDENCE_DISPOSITIONS.has(String(disposition))) throw new TypeError(`unsupported catalog evidence disposition: ${disposition}`);
    if (!reason) throw new TypeError("catalog evidence disposition reason is required");
    return this.transaction(() => {
      const before = this._catalogObjectRow(identity.objectType, identity.objectId);
      if (!before) throw new Error(`catalog object not found: ${identity.objectType}/${identity.objectId}`);
      this._assertCatalogRevision(before, expectedRevision);
      const evidence = this.db.prepare("SELECT * FROM catalog_repository_evidence WHERE id=? AND object_id=?").get(Number(evidenceId), before.id);
      if (!evidence) throw new Error(`catalog evidence not found: ${evidenceId}`);
      if (evidence.disposition === disposition) return this._catalogObjectResult(before);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE catalog_repository_evidence SET disposition=? WHERE id=?").run(String(disposition), evidence.id);
      this.db.prepare("UPDATE catalog_repository_objects SET revision=revision+1,updated_at=? WHERE id=?").run(now, before.id);
      const after = this._catalogObjectRow(identity.objectType, identity.objectId);
      this._recordCatalogTransition(after, { fromStatus: before.status, fromDisposition: before.disposition, reason: `evidence-${disposition}:${reason}`, evidenceRevision: after.revision });
      return this._catalogObjectResult(after);
    });
  }

  _catalogRulingMutation(input, revoke = false) {
    const identity = validateCatalogIdentity(input.objectType, input.objectId);
    const fieldPath = String(input.fieldPath || "").trim();
    fieldSegments(fieldPath);
    const decision = revoke ? "revoke" : String(input.decision || "modify");
    if (!CATALOG_RULING_DECISIONS.has(decision) || (!revoke && decision === "revoke")) throw new TypeError(`unsupported catalog ruling decision: ${decision}`);
    const actor = String(input.actor || "").trim();
    const note = String(input.note || "").trim();
    if (!actor) throw new TypeError("catalog ruling actor is required");
    if (!note) throw new TypeError("catalog ruling note is required");
    return this.transaction(() => {
      const before = this._catalogObjectRow(identity.objectType, identity.objectId);
      if (!before) throw new Error(`catalog object not found: ${identity.objectType}/${identity.objectId}`);
      const activeRulings = this._activeCatalogRulings(before.id);
      const currentRuling = activeRulings.get(fieldPath) || null;
      this._assertCatalogRevision(before, input.expectedRevision, fieldPath);
      if (revoke && !currentRuling) throw new Error(`active catalog ruling not found: ${fieldPath}`);
      const algorithmCandidate = this._catalogAlgorithmCandidate(before);
      const effectiveBefore = [...activeRulings.values()].reduce((payload, ruling) => setFieldValue(payload, ruling.fieldPath, ruling.value), algorithmCandidate);
      const oldValue = fieldValue(effectiveBefore, fieldPath);
      const value = revoke ? null : input.value;
      const newValue = revoke ? fieldValue(algorithmCandidate, fieldPath) : input.value;
      const nextRevision = Number(before.revision) + 1;
      const now = new Date().toISOString();
      const json = (candidate) => JSON.stringify(candidate === undefined ? null : candidate);
      this.db.prepare(`INSERT INTO catalog_repository_rulings(object_id,field_path,decision,value_json,actor,note,old_value_json,new_value_json,object_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(before.id, fieldPath, decision, revoke ? null : json(value), actor, note, json(oldValue), json(newValue), nextRevision, now);
      this.db.prepare("UPDATE catalog_repository_objects SET revision=?,updated_at=? WHERE id=?").run(nextRevision, now, before.id);
      return this._catalogObjectResult(this._catalogObjectRow(identity.objectType, identity.objectId));
    });
  }

  applyCatalogRuling(input) {
    return this._catalogRulingMutation(input, false);
  }

  revokeCatalogRuling(input) {
    return this._catalogRulingMutation({ ...input, decision: "revoke" }, true);
  }

  getCatalogObject(objectType, objectId) {
    const identity = validateCatalogIdentity(objectType, objectId);
    return this._catalogObjectResult(this._catalogObjectRow(identity.objectType, identity.objectId));
  }

  listCatalogObjects({ objectType = null, status = null } = {}) {
    const clauses = [], values = [];
    if (objectType != null) { validateCatalogIdentity(objectType, "filter"); clauses.push("object_type=?"); values.push(String(objectType)); }
    if (status != null) { clauses.push("status=?"); values.push(String(status)); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM catalog_repository_objects${where} ORDER BY object_type,object_id`).all(...values);
    const summaries = new Map();
    for (const evidence of this.db.prepare(`SELECT object_id,source_type,source_ref,COUNT(*) AS evidence_count,SUM(observation_count) AS observation_count
      FROM catalog_repository_evidence GROUP BY object_id,source_type,source_ref ORDER BY source_type,source_ref`).all()) {
      const summary = summaries.get(Number(evidence.object_id)) || { evidenceCount: 0, observationCount: 0, sources: [] };
      summary.evidenceCount += Number(evidence.evidence_count);
      summary.observationCount += Number(evidence.observation_count);
      summary.sources.push({ sourceType: evidence.source_type, sourceRef: evidence.source_ref || null, observationCount: Number(evidence.observation_count) });
      summaries.set(Number(evidence.object_id), summary);
    }
    const latestTransitions = new Map();
    for (const transition of this.db.prepare("SELECT * FROM catalog_repository_transitions ORDER BY id DESC").all()) {
      if (!latestTransitions.has(Number(transition.object_id))) latestTransitions.set(Number(transition.object_id), this._catalogTransition(transition));
    }
    return rows.map((row) => ({
      objectType: row.object_type,
      objectId: row.object_id,
      status: row.status,
      disposition: row.disposition,
      revision: Number(row.revision),
      evidenceSummary: summaries.get(Number(row.id)) || { evidenceCount: 0, observationCount: 0, sources: [] },
      latestTransition: latestTransitions.get(Number(row.id)) || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getCatalogReviewQueue() {
    return this.db.prepare("SELECT * FROM catalog_repository_objects ORDER BY updated_at DESC,object_type,object_id").all()
      .map((row) => {
        const object = this._catalogObjectResult(row);
        return {
          objectType: object.objectType,
          objectId: object.objectId,
          revision: object.revision,
          status: object.status,
          disposition: object.disposition,
          reviewStatus: object.reviewStatus,
          reasons: object.reviewReasons,
          updatedAt: object.updatedAt,
        };
      })
      .filter((entry) => entry.reasons.length > 0);
  }

  getCatalogRepositorySummary() {
    const counts = { observed: 0, provisional: 0, active: 0 };
    for (const row of this.db.prepare("SELECT status,COUNT(*) AS count FROM catalog_repository_objects GROUP BY status").all()) counts[row.status] = Number(row.count);
    return {
      objects: Object.values(counts).reduce((sum, count) => sum + count, 0),
      states: counts,
      evidence: Number(this.db.prepare("SELECT COUNT(*) AS count FROM catalog_repository_evidence").get().count),
      observations: Number(this.db.prepare("SELECT COALESCE(SUM(observation_count),0) AS count FROM catalog_repository_evidence").get().count),
      versions: Number(this.db.prepare("SELECT COUNT(*) AS count FROM catalog_repository_versions").get().count),
      conflicts: Number(this.db.prepare("SELECT COUNT(*) AS count FROM catalog_repository_conflicts WHERE status='open'").get().count),
    };
  }

  recordCatalogConflict({ objectType, objectId, conflictType, details, countDuplicate = true }) {
    const normalizedType = String(objectType || "catalog-migration");
    const normalizedId = String(objectId || "unknown");
    const normalizedConflict = String(conflictType || "migration-conflict");
    const detailsJson = canonicalJson(details || {});
    const fingerprint = crypto.createHash("sha256").update(detailsJson).digest("hex");
    const now = new Date().toISOString();
    const conflictAction = countDuplicate
      ? "DO UPDATE SET occurrence_count=occurrence_count+1,last_seen_at=excluded.last_seen_at"
      : "DO NOTHING";
    this.db.prepare(`INSERT INTO catalog_repository_conflicts(object_type,object_id,conflict_type,fingerprint,details_json,status,occurrence_count,created_at,last_seen_at)
      VALUES(?,?,?,?,?,'open',1,?,?) ON CONFLICT(object_type,object_id,conflict_type,fingerprint) ${conflictAction}`)
      .run(normalizedType, normalizedId, normalizedConflict, fingerprint, detailsJson, now, now);
    return this.db.prepare(`SELECT * FROM catalog_repository_conflicts
      WHERE object_type=? AND object_id=? AND conflict_type=? AND fingerprint=?`).get(normalizedType, normalizedId, normalizedConflict, fingerprint);
  }

  listCatalogConflicts({ status = "open" } = {}) {
    const rows = status == null
      ? this.db.prepare("SELECT * FROM catalog_repository_conflicts ORDER BY id").all()
      : this.db.prepare("SELECT * FROM catalog_repository_conflicts WHERE status=? ORDER BY id").all(String(status));
    return rows.map((row) => ({
      id: Number(row.id), objectType: row.object_type, objectId: row.object_id,
      conflictType: row.conflict_type, details: parseJson(row.details_json), status: row.status,
      occurrenceCount: Number(row.occurrence_count), createdAt: row.created_at, lastSeenAt: row.last_seen_at,
    }));
  }

  resolveCatalogConflicts(objectType, objectId, conflictType) {
    this.db.prepare("UPDATE catalog_repository_conflicts SET status='resolved',last_seen_at=? WHERE object_type=? AND object_id=? AND conflict_type=? AND status='open'")
      .run(new Date().toISOString(), String(objectType), String(objectId), String(conflictType));
  }

  _importCatalogProjection(catalog, { sourceFile, observedAt }) {
    const chainStmt = this.db.prepare(`INSERT INTO merge_chains(id,title_key,min_level,max_level,observed_max_level,complete,source_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title_key=excluded.title_key,min_level=excluded.min_level,max_level=excluded.max_level,observed_max_level=excluded.observed_max_level,complete=excluded.complete,source_json=excluded.source_json,updated_at=excluded.updated_at`);
    const itemStmt = this.db.prepare(`INSERT INTO items(id,chain_id,level,merge_target,icon_resource,energy_cost,base_units,confidence,source_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET chain_id=excluded.chain_id,level=excluded.level,merge_target=excluded.merge_target,icon_resource=excluded.icon_resource,energy_cost=excluded.energy_cost,base_units=excluded.base_units,confidence=excluded.confidence,source_json=excluded.source_json,updated_at=excluded.updated_at`);
    const producerStmt = this.db.prepare(`INSERT INTO producers(item_id,chain_id,level,energy_cost,sample_size,source_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET chain_id=excluded.chain_id,level=excluded.level,energy_cost=excluded.energy_cost,sample_size=excluded.sample_size,source_json=excluded.source_json,updated_at=excluded.updated_at`);
    const dropStmt = this.db.prepare(`INSERT INTO producer_drops(producer_item_id,item_id,probability,sample_count,chain_id,level,base_units)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(producer_item_id,item_id) DO UPDATE SET probability=excluded.probability,sample_count=excluded.sample_count,chain_id=excluded.chain_id,level=excluded.level,base_units=excluded.base_units`);
    const observationStmt = this.db.prepare("INSERT INTO catalog_observations(entity_type,entity_id,source_file,confidence,payload_json,observed_at) VALUES(?,?,?,?,?,?)");
    for (const chain of catalog.chains || []) chainStmt.run(String(chain.id), chain.titleKey ?? null, chain.minLevel ?? null, chain.maxLevel ?? null, chain.observedMaxLevel ?? null, chain.complete ? 1 : 0, JSON.stringify(chain), observedAt);
    for (const item of catalog.items || []) itemStmt.run(String(item.id), item.chainId == null ? null : String(item.chainId), item.level ?? null, item.mergeTarget == null ? null : String(item.mergeTarget), item.iconResource ?? null, item.energyCost ?? null, item.baseUnits ?? null, item.inferred ? "inferred" : "observed", JSON.stringify(item), observedAt);
    for (const producer of catalog.producers || []) {
      producerStmt.run(String(producer.itemId), producer.chainId == null ? null : String(producer.chainId), producer.level ?? null, producer.energyCost ?? null, producer.sampleSize ?? null, JSON.stringify(producer), observedAt);
      for (const drop of producer.drops || []) dropStmt.run(String(producer.itemId), String(drop.itemId), drop.probability ?? null, drop.count ?? null, drop.chainId == null ? null : String(drop.chainId), drop.level ?? null, drop.baseUnits ?? null);
      observationStmt.run("producer", String(producer.itemId), sourceFile, "observed", JSON.stringify(producer), observedAt);
    }
  }

  _importCatalogRepositoryEvidence(catalog, { sourceFile, sourceType, observedAt }) {
    for (const item of catalog.items || []) {
      this._observeCatalogObject({ objectType: "item-identity", objectId: String(item.id), payload: item, sourceType, sourceRef: sourceFile, observedAt, countDuplicate: false });
      this._observeCatalogObject({
        objectType: "merge-relation",
        objectId: String(item.id),
        payload: { itemId: String(item.id), chainId: item.chainId ?? null, level: item.level ?? null, mergeTarget: item.mergeTarget ?? null },
        sourceType,
        sourceRef: sourceFile,
        observedAt,
        countDuplicate: false,
      });
    }
    for (const producer of catalog.producers || []) this._observeCatalogObject({ objectType: "production-profile", objectId: String(producer.itemId), payload: producer, sourceType, sourceRef: sourceFile, observedAt, countDuplicate: false });
  }

  importCatalog(catalog, { sourceFile = null, sourceType = "legacy-json" } = {}) {
    const observedAt = new Date().toISOString();
    return this.transaction(() => {
      this._importCatalogProjection(catalog, { sourceFile, observedAt });
      this._importCatalogRepositoryEvidence(catalog, { sourceFile, sourceType, observedAt });
      return this.getCatalogStats();
    });
  }

  getCatalogStats() {
    const count = (table) => Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    return { chains: count("merge_chains"), items: count("items"), producers: count("producers"), drops: count("producer_drops"), observations: count("catalog_observations") };
  }

  startSession(mode, settings = {}) {
    const result = this.db.prepare("INSERT INTO automation_sessions(mode,started_at,status,settings_json) VALUES(?,?,?,?)").run(String(mode), new Date().toISOString(), "running", JSON.stringify(settings));
    return Number(result.lastInsertRowid);
  }

  logAction({ sessionId = null, sequence = null, type, reason = null, ok = null, before = null, after = null, details = null }) {
    const result = this.db.prepare("INSERT INTO actions(session_id,sequence,action_type,reason,ok,before_json,after_json,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(sessionId, sequence, String(type), reason, ok == null ? null : ok ? 1 : 0, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), details == null ? null : JSON.stringify(details), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  endSession(sessionId, status) {
    this.db.prepare("UPDATE automation_sessions SET ended_at=?, status=? WHERE id=?").run(new Date().toISOString(), String(status), Number(sessionId));
  }

  setSetting(key, value) {
    this.db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
      .run(String(key), JSON.stringify(value), new Date().toISOString());
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key=?").get(String(key));
    return row ? JSON.parse(row.value_json) : fallback;
  }

  listRecentActions(limit = 100) {
    return this.db.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").all(Math.max(1, Number(limit)));
  }

  listAttributableProductionActions() {
    const actions = [];
    for (const row of this.db.prepare("SELECT id,details_json FROM actions WHERE action_type='produce' AND ok=1 ORDER BY id").all()) {
      const details = parseJson(row.details_json) || {};
      const evidence = details.diff || details;
      const producerItemId = evidence.producerItemId ?? details.producerItemId;
      const outputItemId = evidence.outputItemId ?? evidence.actualOutputItemId ?? details.outputItemId;
      if (producerItemId == null || outputItemId == null) continue;
      actions.push({ id: `action:${row.id}`, producerItemId: String(producerItemId), outputItemId: String(outputItemId), attributable: true });
    }
    return actions;
  }

  logResourceSample({ sessionId = null, coins = null, energy = null, diamonds = null, scene = null, observedAt = null }) {
    const result = this.db.prepare("INSERT INTO resource_samples(session_id,coins,energy,diamonds,scene,observed_at) VALUES(?,?,?,?,?,?)")
      .run(sessionId, coins, energy, diamonds, scene, observedAt || new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  listResourceSamples(limit = 120) {
    return this.db.prepare("SELECT * FROM resource_samples ORDER BY id DESC LIMIT ?").all(Math.max(1, Number(limit))).reverse();
  }

  close() { this.db.close(); }
}

module.exports = { AutomationDatabase };
