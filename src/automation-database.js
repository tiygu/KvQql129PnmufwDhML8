"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { canonicalJson } = require("./canonical-json");
const { CATALOG_OBJECT_TYPES } = require("./catalog-domain");
const { createDistributionState, updateDistributionState, replaceTheory, projectPlanningDistribution } = require("./production-distributions");

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

function validateCatalogReviewPayload(identity, payload) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length === 0) {
    throw new TypeError("catalog review payload must be a complete object");
  }
  const value = structuredClone(payload);
  const payloadObjectId = identity.objectType === "production-profile"
    ? value.producerItemId ?? value.itemId
    : identity.objectType === "production-mode"
      ? `${value.producerItemId ?? value.itemId ?? ""}:${value.modeId ?? ""}`
      : value.itemId ?? value.id;
  if (String(payloadObjectId ?? "") !== identity.objectId) {
    throw new TypeError(`catalog review payload identity mismatch: ${identity.objectType}/${identity.objectId}`);
  }
  return value;
}

function catalogDisplayTitle(payload) {
  const value = payload || {};
  const name = value.name || value.displayName || value.title || value.description || value.descriptionKey;
  if (String(name || "").trim()) return String(name).trim();
  const level = Number(value.level);
  return Number.isFinite(level) && level > 0 ? `未命名物品（第 ${level} 级）` : "未命名物品";
}

function meaningfulCatalogDifferences(before, after) {
  const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...fields].sort().flatMap((fieldPath) => {
    const oldValue = before?.[fieldPath];
    const newValue = after?.[fieldPath];
    return canonicalJson(oldValue ?? null) === canonicalJson(newValue ?? null)
      ? []
      : [{ fieldPath, oldValue: oldValue ?? null, newValue: newValue ?? null }];
  });
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
      CREATE TABLE IF NOT EXISTS catalog_review_resolutions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id INTEGER NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        decision TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        optional_note TEXT,
        object_revision INTEGER NOT NULL,
        planning_result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS catalog_audit_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resolution_id INTEGER NOT NULL UNIQUE,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(resolution_id) REFERENCES catalog_review_resolutions(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS catalog_icon_assets (
        hash TEXT PRIMARY KEY,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_icon_candidates (
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
      CREATE TABLE IF NOT EXISTS catalog_icon_selection_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id INTEGER NOT NULL,
        candidate_id INTEGER,
        previous_candidate_id INTEGER,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        note TEXT NOT NULL,
        object_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(object_id) REFERENCES catalog_repository_objects(id) ON DELETE RESTRICT,
        FOREIGN KEY(candidate_id) REFERENCES catalog_icon_candidates(id) ON DELETE RESTRICT,
        FOREIGN KEY(previous_candidate_id) REFERENCES catalog_icon_candidates(id) ON DELETE RESTRICT
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
      CREATE TABLE IF NOT EXISTS production_distribution_states (
        producer_item_id TEXT NOT NULL, mode_id TEXT NOT NULL,
        state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        PRIMARY KEY(producer_item_id, mode_id)
      );
      CREATE TABLE IF NOT EXISTS production_action_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL UNIQUE,
        producer_item_id TEXT, mode_id TEXT, attributable INTEGER NOT NULL,
        outcome_json TEXT NOT NULL, reason TEXT, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS production_distribution_review_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, producer_item_id TEXT NOT NULL, mode_id TEXT NOT NULL,
        event_type TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, details_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_actions_session_sequence ON actions(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_observations_entity ON catalog_observations(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_state ON catalog_repository_objects(status, object_type);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_evidence_object ON catalog_repository_evidence(object_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_versions_object ON catalog_repository_versions(object_id, version);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_conflicts_status ON catalog_repository_conflicts(status, object_type);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_transitions_object ON catalog_repository_transitions(object_id, id);
      CREATE INDEX IF NOT EXISTS idx_catalog_repository_rulings_object_field ON catalog_repository_rulings(object_id, field_path, id);
      CREATE INDEX IF NOT EXISTS idx_catalog_review_resolutions_object ON catalog_review_resolutions(object_id, id);
      CREATE INDEX IF NOT EXISTS idx_catalog_audit_summaries_created ON catalog_audit_summaries(created_at, id);
      CREATE INDEX IF NOT EXISTS idx_catalog_icon_candidates_object ON catalog_icon_candidates(object_id, selected, id);
      CREATE INDEX IF NOT EXISTS idx_catalog_icon_candidates_asset ON catalog_icon_candidates(asset_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_icon_candidates_one_selected ON catalog_icon_candidates(object_id) WHERE selected=1;
      CREATE INDEX IF NOT EXISTS idx_catalog_icon_selection_history_object ON catalog_icon_selection_history(object_id,id);
      CREATE INDEX IF NOT EXISTS idx_resource_samples_observed ON resource_samples(observed_at);
      CREATE INDEX IF NOT EXISTS idx_production_actions_attributable ON production_action_observations(attributable, observed_at);
      CREATE INDEX IF NOT EXISTS idx_production_distribution_reviews_status ON production_distribution_review_events(status, created_at);
    `);
    const versionColumns = new Set(this.db.prepare("PRAGMA table_info(catalog_repository_versions)").all().map((column) => column.name));
    if (!versionColumns.has("origin")) this.db.exec("ALTER TABLE catalog_repository_versions ADD COLUMN origin TEXT NOT NULL DEFAULT 'unspecified'");
    const iconCandidateColumns = new Set(this.db.prepare("PRAGMA table_info(catalog_icon_candidates)").all().map((column) => column.name));
    if (!iconCandidateColumns.has("similarity_json")) this.db.exec("ALTER TABLE catalog_icon_candidates ADD COLUMN similarity_json TEXT NOT NULL DEFAULT '{}'");
    if (!iconCandidateColumns.has("rank_score")) this.db.exec("ALTER TABLE catalog_icon_candidates ADD COLUMN rank_score REAL NOT NULL DEFAULT 1");
    if (!iconCandidateColumns.has("selection_origin")) this.db.exec("ALTER TABLE catalog_icon_candidates ADD COLUMN selection_origin TEXT");
    const objectColumns = new Set(this.db.prepare("PRAGMA table_info(catalog_repository_objects)").all().map((column) => column.name));
    if (!objectColumns.has("disposition")) this.db.exec("ALTER TABLE catalog_repository_objects ADD COLUMN disposition TEXT NOT NULL DEFAULT 'enabled'");
    const evidenceColumns = new Set(this.db.prepare("PRAGMA table_info(catalog_repository_evidence)").all().map((column) => column.name));
    if (!evidenceColumns.has("disposition")) this.db.exec("ALTER TABLE catalog_repository_evidence ADD COLUMN disposition TEXT NOT NULL DEFAULT 'eligible'");
    this.db.exec("UPDATE catalog_repository_objects SET candidate_version_id=NULL WHERE status='active' AND active_version_id IS NOT NULL AND candidate_version_id IS NOT NULL");
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
    if (row.status === "observed") reasons.push({ type: "new-observation", message: "新观测等待更多证据或人工检查" });
    if (row.candidate_version_id != null) reasons.push({ type: "inference-change", message: "存在尚未生效的算法候选" });
    for (const conflict of this.db.prepare("SELECT conflict_type,details_json FROM catalog_repository_conflicts WHERE object_type=? AND object_id=? AND status='open' ORDER BY id").all(row.object_type, row.object_id)) {
      reasons.push({ type: "evidence-conflict", conflictType: conflict.conflict_type, details: parseJson(conflict.details_json), message: "证据来源存在冲突" });
    }
    for (const ruling of activeRulings.values()) {
      const candidate = fieldValue(algorithmCandidate, ruling.fieldPath);
      if (canonicalJson(candidate ?? null) !== canonicalJson(ruling.value ?? null)) {
        reasons.push({ type: "human-ruling-conflict", fieldPath: ruling.fieldPath, candidate, humanValue: ruling.value, message: "算法证据与人工裁决冲突" });
      }
    }
    return reasons;
  }

  _catalogCompletenessGaps(row) {
    const gaps = [];
    if (row.object_type === "item-identity" && !this._selectedIconCandidate(row.id)) {
      gaps.push({ type: "icon-gap", fieldPath: "iconResourceIdentifier", message: "缺少物品图标证据" });
    }
    return gaps;
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
    if (row.object_type === "item-identity") {
      result.iconCandidates = this._iconCandidates(row.id);
      result.selectedIcon = this._selectedIconCandidate(row.id);
      result.iconSelectionHistory = this.db.prepare(`SELECT history.*,candidate.asset_hash,previous.asset_hash AS previous_asset_hash
        FROM catalog_icon_selection_history history
        LEFT JOIN catalog_icon_candidates candidate ON candidate.id=history.candidate_id
        LEFT JOIN catalog_icon_candidates previous ON previous.id=history.previous_candidate_id
        WHERE history.object_id=? ORDER BY history.id`).all(row.id).map((history) => ({
          id: Number(history.id), candidateId: history.candidate_id == null ? null : Number(history.candidate_id), assetHash: history.asset_hash || null,
          previousCandidateId: history.previous_candidate_id == null ? null : Number(history.previous_candidate_id), previousAssetHash: history.previous_asset_hash || null,
          action: history.action, actor: history.actor, note: history.note, objectRevision: Number(history.object_revision), createdAt: history.created_at,
        }));
    }
    result.algorithmCandidate = this._catalogAlgorithmCandidate(row);
    const activeRulings = this._activeCatalogRulings(row.id);
    result.humanValues = Object.fromEntries(activeRulings);
    result.effectiveValue = [...activeRulings.values()].reduce((payload, ruling) => setFieldValue(payload, ruling.fieldPath, ruling.value), result.algorithmCandidate);
    result.rulingHistory = this._catalogRulings(row.id);
    result.reviewReasons = this._catalogReviewReasons(row, result.algorithmCandidate, activeRulings);
    result.completenessGaps = this._catalogCompletenessGaps(row);
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
        this.db.prepare("UPDATE catalog_repository_objects SET status='active',candidate_version_id=NULL,active_version_id=?,revision=revision+1,updated_at=? WHERE id=?").run(versionId, now, object.id);
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

  completeCatalogReview(input) {
    const identity = validateCatalogIdentity(input.objectType, input.objectId);
    const decision = String(input.decision || "");
    if (!["confirm", "modify"].includes(decision)) throw new TypeError(`unsupported catalog review decision: ${decision}`);
    const actor = String(input.actor || "").trim();
    const note = String(input.note || "").trim();
    if (!actor) throw new TypeError("catalog review actor is required");
    const hasExplicitRequestId = String(input.requestId || "").trim().length > 0;
    const requestId = String(input.requestId || `legacy-review:${crypto.randomUUID()}`).trim();
    if (!requestId) throw new TypeError("catalog review requestId is required");
    return this.transaction(() => {
      const before = this._catalogObjectRow(identity.objectType, identity.objectId);
      if (!before) throw new Error(`catalog object not found: ${identity.objectType}/${identity.objectId}`);
      const algorithmCandidate = this._catalogAlgorithmCandidate(before);
      const submittedSnapshot = input.snapshot ?? input.payload ?? (decision === "confirm" ? algorithmCandidate : null);
      const payload = validateCatalogReviewPayload(identity, submittedSnapshot);
      const requestFingerprint = canonicalJson({
        objectType: identity.objectType,
        objectId: identity.objectId,
        decision,
        snapshot: payload,
        actor,
        optionalNote: note || null,
      });
      const existingResolution = this.db.prepare("SELECT * FROM catalog_review_resolutions WHERE request_id=?").get(requestId);
      if (existingResolution) {
        if (existingResolution.request_fingerprint !== requestFingerprint) {
          const conflict = new Error(`catalog idempotency conflict: ${requestId}`);
          conflict.code = "CATALOG_IDEMPOTENCY_CONFLICT";
          conflict.statusCode = 409;
          throw conflict;
        }
        return this._catalogReviewCompletionResult(
          this._catalogObjectRow(identity.objectType, identity.objectId),
          existingResolution,
          true,
        );
      }
      this._assertCatalogRevision(before, input.expectedRevision);
      const activeRulings = this._activeCatalogRulings(before.id);
      const effectiveBefore = [...activeRulings.values()].reduce((value, ruling) => setFieldValue(value, ruling.fieldPath, ruling.value), algorithmCandidate);
      const triggerReasons = this._catalogReviewReasons(before, algorithmCandidate, activeRulings);
      const evidenceReferences = this.db.prepare("SELECT id,source_type,source_ref FROM catalog_repository_evidence WHERE object_id=? ORDER BY id").all(before.id)
        .map((evidence) => ({ id: Number(evidence.id), sourceType: evidence.source_type, sourceRef: evidence.source_ref || null }));
      const nextRevision = Number(before.revision) + 1;
      const now = input.createdAt || new Date().toISOString();
      const json = (value) => JSON.stringify(value === undefined ? null : value);
      const rulingNote = note || (decision === "confirm" ? "系统生成：确认完整候选快照" : "系统生成：修改后确认完整候选快照");
      const insertRuling = this.db.prepare(`INSERT INTO catalog_repository_rulings(object_id,field_path,decision,value_json,actor,note,old_value_json,new_value_json,object_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const ruling of activeRulings.values()) {
        insertRuling.run(before.id, ruling.fieldPath, "revoke", null, actor, `整对象审核替代旧裁决：${rulingNote}`, json(fieldValue(effectiveBefore, ruling.fieldPath)), json(fieldValue(algorithmCandidate, ruling.fieldPath)), nextRevision, now);
      }
      for (const fieldPath of Object.keys(payload).sort()) {
        insertRuling.run(before.id, fieldPath, decision, json(payload[fieldPath]), actor, rulingNote, json(fieldValue(effectiveBefore, fieldPath)), json(payload[fieldPath]), nextRevision, now);
      }
      const nextVersion = Number(this.db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM catalog_repository_versions WHERE object_id=?").get(before.id).version);
      const inserted = this.db.prepare(`INSERT INTO catalog_repository_versions(object_id,version,status,origin,payload_json,evidence_summary_json,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(before.id, nextVersion, "active", "user", canonicalJson(payload), JSON.stringify(this._catalogEvidenceSummary(before.id)), now);
      const versionId = Number(inserted.lastInsertRowid);
      this.db.prepare("UPDATE catalog_repository_objects SET status='active',candidate_version_id=NULL,active_version_id=?,revision=?,updated_at=? WHERE id=?")
        .run(versionId, nextRevision, now, before.id);
      const after = this._catalogObjectRow(identity.objectType, identity.objectId);
      this._recordCatalogTransition(after, {
        fromStatus: before.status,
        fromDisposition: before.disposition,
        reason: `human-review-${decision}:${actor}`,
        evidenceRevision: nextRevision,
      });
      const planningResult = hasExplicitRequestId
        ? { status: "pending", recovered: false }
        : { status: "not-requested", recovered: true };
      const insertedResolution = this.db.prepare(`INSERT INTO catalog_review_resolutions(
        object_id,request_id,request_fingerprint,decision,snapshot_json,actor,optional_note,object_revision,planning_result_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        before.id,
        requestId,
        requestFingerprint,
        decision,
        canonicalJson(payload),
        actor,
        note || null,
        nextRevision,
        canonicalJson(planningResult),
        now,
      );
      const resolutionId = Number(insertedResolution.lastInsertRowid);
      const auditSummary = {
        resolutionId,
        requestId,
        objectType: identity.objectType,
        objectId: identity.objectId,
        objectRevision: nextRevision,
        actor,
        action: decision,
        displayTitle: catalogDisplayTitle(payload),
        meaningfulDifferences: meaningfulCatalogDifferences(effectiveBefore, payload),
        triggerReasons,
        planningResult,
        evidenceReferences,
        optionalNote: note || null,
        createdAt: now,
      };
      this.db.prepare(`INSERT INTO catalog_audit_summaries(resolution_id,summary_json,created_at,updated_at)
        VALUES(?,?,?,?)`).run(resolutionId, canonicalJson(auditSummary), now, now);
      return this._catalogReviewCompletionResult(
        after,
        this.db.prepare("SELECT * FROM catalog_review_resolutions WHERE id=?").get(resolutionId),
        false,
      );
    });
  }

  _catalogReviewCompletionResult(objectRow, resolutionRow, idempotentReplay) {
    const result = this._catalogObjectResult(objectRow);
    const auditRow = this.db.prepare("SELECT * FROM catalog_audit_summaries WHERE resolution_id=?").get(resolutionRow.id);
    const planningResult = parseJson(resolutionRow.planning_result_json);
    return Object.assign(result, {
      reviewResolution: {
        id: Number(resolutionRow.id),
        requestId: resolutionRow.request_id,
        decision: resolutionRow.decision,
        snapshot: parseJson(resolutionRow.snapshot_json),
        actor: resolutionRow.actor,
        optionalNote: resolutionRow.optional_note || null,
        objectRevision: Number(resolutionRow.object_revision),
        planningResult,
        createdAt: resolutionRow.created_at,
      },
      catalogAuditSummary: auditRow
        ? { id: Number(auditRow.id), ...parseJson(auditRow.summary_json), planningResult }
        : null,
      idempotentReplay: !!idempotentReplay,
    });
  }

  listCatalogReviewResolutions({ objectType = null, objectId = null } = {}) {
    const clauses = [], values = [];
    if (objectType != null) { clauses.push("object.object_type=?"); values.push(String(objectType)); }
    if (objectId != null) { clauses.push("object.object_id=?"); values.push(String(objectId)); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT resolution.*,object.object_type,object.object_id
      FROM catalog_review_resolutions resolution
      JOIN catalog_repository_objects object ON object.id=resolution.object_id
      ${where} ORDER BY resolution.id`).all(...values).map((row) => ({
      id: Number(row.id),
      requestId: row.request_id,
      objectType: row.object_type,
      objectId: row.object_id,
      decision: row.decision,
      snapshot: parseJson(row.snapshot_json),
      actor: row.actor,
      optionalNote: row.optional_note || null,
      objectRevision: Number(row.object_revision),
      planningResult: parseJson(row.planning_result_json),
      createdAt: row.created_at,
    }));
  }

  listCatalogAuditSummaries({ objectType = null, objectId = null } = {}) {
    const clauses = [], values = [];
    if (objectType != null) { clauses.push("object.object_type=?"); values.push(String(objectType)); }
    if (objectId != null) { clauses.push("object.object_id=?"); values.push(String(objectId)); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT audit.id,audit.summary_json,resolution.planning_result_json
      FROM catalog_audit_summaries audit
      JOIN catalog_review_resolutions resolution ON resolution.id=audit.resolution_id
      JOIN catalog_repository_objects object ON object.id=resolution.object_id
      ${where} ORDER BY audit.id`).all(...values)
      .map((row) => ({
        id: Number(row.id),
        ...parseJson(row.summary_json),
        planningResult: parseJson(row.planning_result_json),
      }));
  }

  finalizeCatalogReviewPlanning(requestId, planningResult) {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) throw new TypeError("catalog review requestId is required");
    const normalizedPlanningResult = structuredClone(planningResult || {});
    return this.transaction(() => {
      const resolution = this.db.prepare("SELECT * FROM catalog_review_resolutions WHERE request_id=?").get(normalizedRequestId);
      if (!resolution) throw new Error(`catalog review resolution not found: ${normalizedRequestId}`);
      const audit = this.db.prepare("SELECT * FROM catalog_audit_summaries WHERE resolution_id=?").get(resolution.id);
      const summary = parseJson(audit.summary_json);
      this.db.prepare("UPDATE catalog_review_resolutions SET planning_result_json=? WHERE id=?")
        .run(canonicalJson(normalizedPlanningResult), resolution.id);
      return this._catalogReviewCompletionResult(
        this._catalogObjectRow(summary.objectType, summary.objectId),
        this.db.prepare("SELECT * FROM catalog_review_resolutions WHERE id=?").get(resolution.id),
        false,
      );
    });
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
      const now = input.createdAt || new Date().toISOString();
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
    const object = this._catalogObjectRow(identity.objectType, identity.objectId);
    const resolution = object && this.db.prepare(
      "SELECT * FROM catalog_review_resolutions WHERE object_id=? ORDER BY id DESC LIMIT 1",
    ).get(object.id);
    return resolution
      ? this._catalogReviewCompletionResult(object, resolution, false)
      : this._catalogObjectResult(object);
  }

  assertCatalogObjectRevision(objectType, objectId, expectedRevision) {
    const object = this._catalogObjectRow(objectType, objectId);
    if (!object) throw Object.assign(new Error(`catalog object not found: ${objectType}/${objectId}`), { statusCode: 404 });
    this._assertCatalogRevision(object, expectedRevision);
    return true;
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
    const rows = this.db.prepare("SELECT * FROM catalog_repository_objects ORDER BY updated_at DESC,object_type,object_id").all();
    const conflictsByObject = new Map();
    for (const conflict of this.db.prepare("SELECT object_type,object_id,conflict_type,details_json FROM catalog_repository_conflicts WHERE status='open' ORDER BY id").all()) {
      const key = `${conflict.object_type}:${conflict.object_id}`;
      if (!conflictsByObject.has(key)) conflictsByObject.set(key, []);
      conflictsByObject.get(key).push(conflict);
    }
    const versions = this.db.prepare("SELECT id,object_id,version,payload_json FROM catalog_repository_versions ORDER BY object_id,version").all();
    const versionById = new Map(versions.map((version) => [Number(version.id), version]));
    const latestVersionByObject = new Map(versions.map((version) => [Number(version.object_id), version]));
    const activeRulingsByObject = new Map();
    for (const ruling of this.db.prepare("SELECT * FROM catalog_repository_rulings ORDER BY object_id,id").all()) {
      const objectId = Number(ruling.object_id);
      if (!activeRulingsByObject.has(objectId)) activeRulingsByObject.set(objectId, new Map());
      const active = activeRulingsByObject.get(objectId);
      if (ruling.decision === "revoke") active.delete(ruling.field_path);
      else active.set(ruling.field_path, this._catalogRulingRow(ruling));
    }
    const latestResolutionByObject = new Map();
    for (const resolution of this.db.prepare("SELECT object_id,planning_result_json FROM catalog_review_resolutions ORDER BY id DESC").all()) {
      const objectId = Number(resolution.object_id);
      if (!latestResolutionByObject.has(objectId)) latestResolutionByObject.set(objectId, parseJson(resolution.planning_result_json));
    }
    return rows.map((row) => {
      const semanticReasons = [];
      if (row.status === "observed") semanticReasons.push({ type: "new-observation", message: "新观测等待更多证据或人工检查" });
      if (row.candidate_version_id != null) semanticReasons.push({ type: "inference-change", message: "存在尚未生效的算法候选" });
      for (const conflict of conflictsByObject.get(`${row.object_type}:${row.object_id}`) || []) {
        semanticReasons.push({ type: "evidence-conflict", conflictType: conflict.conflict_type, details: parseJson(conflict.details_json), message: "证据来源存在冲突" });
      }
      const version = versionById.get(Number(row.active_version_id)) || versionById.get(Number(row.candidate_version_id)) || latestVersionByObject.get(Number(row.id));
      const algorithmCandidate = parseJson(version?.payload_json) || {};
      for (const ruling of (activeRulingsByObject.get(Number(row.id)) || new Map()).values()) {
        const candidate = fieldValue(algorithmCandidate, ruling.fieldPath);
        if (canonicalJson(candidate ?? null) !== canonicalJson(ruling.value ?? null)) {
          semanticReasons.push({ type: "human-ruling-conflict", fieldPath: ruling.fieldPath, candidate, humanValue: ruling.value, message: "算法证据与人工裁决冲突" });
        }
      }
      const planningResult = latestResolutionByObject.get(Number(row.id)) || null;
      const planningIncomplete = planningResult && planningResult.recovered !== true;
      const reasons = planningIncomplete
        ? [...semanticReasons, {
            type: "planning-recovery-pending",
            message: planningResult.status === "failed" ? "审核结论已保存，规划尚未恢复" : "审核结论已保存，正在重新规划",
          }]
        : semanticReasons;
      const title = catalogDisplayTitle(algorithmCandidate);
      const displayTitle = row.candidate_version_id != null && !title.startsWith("未命名物品")
        ? `疑似“${title}”`
        : title;
      return {
        objectType: row.object_type,
        objectId: row.object_id,
        displayTitle,
        revision: Number(row.revision),
        status: row.status,
        disposition: row.disposition,
        reviewStatus: semanticReasons.length ? "needs-review" : "clear",
        actionStatus: semanticReasons.length ? "需要处理" : "已确认",
        reasons,
        updatedAt: row.updated_at,
      };
    }).filter((entry) => entry.reasons.length > 0);
  }

  _iconCandidate(row) {
    return row ? {
      id: Number(row.id), itemId: row.object_key, assetHash: row.asset_hash, cacheKey: row.cache_key,
      sourceType: row.source_type, resourceUrl: row.resource_url, runtimeIdentifier: row.runtime_identifier,
      textureUuid: row.texture_uuid, crop: parseJson(row.crop_json), selected: !!row.selected,
      similarity: parseJson(row.similarity_json) || {}, rankScore: Number(row.rank_score), selectionOrigin: row.selection_origin || null,
      mimeType: row.mime_type, width: Number(row.width), height: Number(row.height), byteSize: Number(row.byte_size),
      filePath: row.file_path, createdAt: row.created_at,
    } : null;
  }

  _iconCandidates(repositoryObjectId) {
    return this.db.prepare(`SELECT candidate.*,object.object_id AS object_key,asset.mime_type,asset.width,asset.height,asset.byte_size,asset.file_path
      FROM catalog_icon_candidates candidate
      JOIN catalog_repository_objects object ON object.id=candidate.object_id
      JOIN catalog_icon_assets asset ON asset.hash=candidate.asset_hash
      WHERE candidate.object_id=? ORDER BY candidate.id`).all(repositoryObjectId).map((row) => this._iconCandidate(row));
  }

  _selectedIconCandidate(repositoryObjectId) {
    const row = this.db.prepare(`SELECT candidate.*,object.object_id AS object_key,asset.mime_type,asset.width,asset.height,asset.byte_size,asset.file_path
      FROM catalog_icon_candidates candidate
      JOIN catalog_repository_objects object ON object.id=candidate.object_id
      JOIN catalog_icon_assets asset ON asset.hash=candidate.asset_hash
      WHERE candidate.object_id=? AND candidate.selected=1 ORDER BY candidate.id DESC LIMIT 1`).get(repositoryObjectId);
    const candidate = this._iconCandidate(row);
    return candidate && fs.existsSync(candidate.filePath) ? candidate : null;
  }

  saveIconCandidate({ itemId, cacheKey, sourceType, resourceUrl = null, runtimeIdentifier = null, textureUuid = null, crop = {}, similarity = {}, rankScore = 1, autoSelect = true, asset }) {
    if (!asset?.hash || !asset.mimeType || !Number.isInteger(Number(asset.width)) || !Number.isInteger(Number(asset.height)) || !asset.filePath) throw new TypeError("complete icon asset metadata is required");
    return this.transaction(() => {
      const object = this._catalogObjectRow("item-identity", String(itemId));
      if (!object) throw new Error(`catalog object not found: item-identity/${itemId}`);
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO catalog_icon_assets(hash,mime_type,width,height,byte_size,file_path,created_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(hash) DO NOTHING`).run(String(asset.hash), String(asset.mimeType), Number(asset.width), Number(asset.height), Number(asset.byteSize), String(asset.filePath), now);
      const manualPreference = this.db.prepare("SELECT action FROM catalog_icon_selection_history WHERE object_id=? AND action IN ('manual-select','manual-revoke') ORDER BY id DESC LIMIT 1").get(object.id);
      const selected = this.db.prepare("SELECT * FROM catalog_icon_candidates WHERE object_id=? AND selected=1").get(object.id);
      const shouldSelect = autoSelect && !manualPreference && (!selected || Number(rankScore) >= Number(selected.rank_score));
      if (shouldSelect) this.db.prepare("UPDATE catalog_icon_candidates SET selected=0,selection_origin=NULL WHERE object_id=?").run(object.id);
      this.db.prepare(`INSERT INTO catalog_icon_candidates(object_id,asset_hash,cache_key,source_type,resource_url,runtime_identifier,texture_uuid,crop_json,similarity_json,rank_score,selection_origin,selected,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(object_id,cache_key) DO UPDATE SET asset_hash=excluded.asset_hash,source_type=excluded.source_type,resource_url=excluded.resource_url,runtime_identifier=excluded.runtime_identifier,texture_uuid=excluded.texture_uuid,crop_json=excluded.crop_json,similarity_json=excluded.similarity_json,rank_score=excluded.rank_score,selection_origin=CASE WHEN excluded.selected=1 THEN excluded.selection_origin ELSE catalog_icon_candidates.selection_origin END,selected=CASE WHEN excluded.selected=1 THEN 1 ELSE catalog_icon_candidates.selected END`)
        .run(object.id, String(asset.hash), String(cacheKey), String(sourceType), resourceUrl, runtimeIdentifier, textureUuid, canonicalJson(crop || {}), canonicalJson(similarity || {}), Number(rankScore), shouldSelect ? "automatic" : null, shouldSelect ? 1 : 0, now);
      this.db.prepare("UPDATE catalog_repository_objects SET revision=revision+1,updated_at=? WHERE id=?").run(now, object.id);
      const after = this._catalogObjectRow("item-identity", String(itemId));
      this._recordCatalogTransition(after, { fromStatus: object.status, fromDisposition: object.disposition, reason: `${shouldSelect ? "icon-candidate-selected" : "icon-candidate-added"}:${asset.hash}`, evidenceRevision: after.revision });
      return this._iconCandidate(this.db.prepare(`SELECT candidate.*,object.object_id AS object_key,asset.mime_type,asset.width,asset.height,asset.byte_size,asset.file_path
        FROM catalog_icon_candidates candidate JOIN catalog_repository_objects object ON object.id=candidate.object_id JOIN catalog_icon_assets asset ON asset.hash=candidate.asset_hash
        WHERE candidate.object_id=? AND candidate.cache_key=?`).get(object.id, String(cacheKey)));
    });
  }

  selectIconCandidate(itemId, candidateId, { actor, note, expectedRevision } = {}) {
    if (!String(actor || "").trim() || !String(note || "").trim()) throw new TypeError("icon selection actor and note are required");
    return this.transaction(() => {
      const object = this._catalogObjectRow("item-identity", String(itemId));
      if (!object) throw new Error(`catalog object not found: item-identity/${itemId}`);
      this._assertCatalogRevision(object, expectedRevision);
      const candidate = this.db.prepare("SELECT * FROM catalog_icon_candidates WHERE id=? AND object_id=?").get(Number(candidateId), object.id);
      if (!candidate) throw Object.assign(new Error(`icon candidate not found: ${candidateId}`), { statusCode: 404 });
      const previous = this.db.prepare("SELECT id FROM catalog_icon_candidates WHERE object_id=? AND selected=1").get(object.id);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE catalog_icon_candidates SET selected=0,selection_origin=NULL WHERE object_id=?").run(object.id);
      this.db.prepare("UPDATE catalog_icon_candidates SET selected=1,selection_origin='manual' WHERE id=?").run(candidate.id);
      this.db.prepare("UPDATE catalog_repository_objects SET revision=revision+1,updated_at=? WHERE id=?").run(now, object.id);
      const after = this._catalogObjectRow("item-identity", String(itemId));
      this.db.prepare(`INSERT INTO catalog_icon_selection_history(object_id,candidate_id,previous_candidate_id,action,actor,note,object_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(object.id, candidate.id, previous?.id || null, "manual-select", String(actor).trim(), String(note).trim(), after.revision, now);
      this._recordCatalogTransition(after, { fromStatus: object.status, fromDisposition: object.disposition, reason: `icon-manual-select:${candidate.asset_hash}`, evidenceRevision: after.revision });
      return this._catalogObjectResult(after);
    });
  }

  revokeIconSelection(itemId, { actor, note, expectedRevision } = {}) {
    if (!String(actor || "").trim() || !String(note || "").trim()) throw new TypeError("icon selection actor and note are required");
    return this.transaction(() => {
      const object = this._catalogObjectRow("item-identity", String(itemId));
      if (!object) throw new Error(`catalog object not found: item-identity/${itemId}`);
      this._assertCatalogRevision(object, expectedRevision);
      const previous = this.db.prepare("SELECT id FROM catalog_icon_candidates WHERE object_id=? AND selected=1").get(object.id);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE catalog_icon_candidates SET selected=0,selection_origin=NULL WHERE object_id=?").run(object.id);
      this.db.prepare("UPDATE catalog_repository_objects SET revision=revision+1,updated_at=? WHERE id=?").run(now, object.id);
      const after = this._catalogObjectRow("item-identity", String(itemId));
      this.db.prepare(`INSERT INTO catalog_icon_selection_history(object_id,candidate_id,previous_candidate_id,action,actor,note,object_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(object.id, null, previous?.id || null, "manual-revoke", String(actor).trim(), String(note).trim(), after.revision, now);
      this._recordCatalogTransition(after, { fromStatus: object.status, fromDisposition: object.disposition, reason: "icon-manual-revoke", evidenceRevision: after.revision });
      return this._catalogObjectResult(after);
    });
  }

  findIconAcquisition(cacheKey) {
    const row = this.db.prepare(`SELECT candidate.*,object.object_id AS object_key,asset.mime_type,asset.width,asset.height,asset.byte_size,asset.file_path
      FROM catalog_icon_candidates candidate
      JOIN catalog_repository_objects object ON object.id=candidate.object_id
      JOIN catalog_icon_assets asset ON asset.hash=candidate.asset_hash
      WHERE candidate.cache_key=? ORDER BY candidate.id LIMIT 1`).get(String(cacheKey));
    return this._iconCandidate(row);
  }

  listIconCandidates(itemId) {
    const object = this._catalogObjectRow("item-identity", String(itemId));
    return object ? this._iconCandidates(object.id) : [];
  }

  getSelectedIconCandidate(itemId) {
    const object = this._catalogObjectRow("item-identity", String(itemId));
    return object ? this._selectedIconCandidate(object.id) : null;
  }

  invalidateAutomaticIconSelections(isEligible, { reason = "automatic-icon-quality-gate" } = {}) {
    if (typeof isEligible !== "function") throw new TypeError("icon eligibility predicate is required");
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT candidate.*,object.object_id AS object_key,asset.mime_type,asset.width,asset.height,asset.byte_size,asset.file_path
        FROM catalog_icon_candidates candidate
        JOIN catalog_repository_objects object ON object.id=candidate.object_id
        JOIN catalog_icon_assets asset ON asset.hash=candidate.asset_hash
        WHERE candidate.selected=1 AND candidate.selection_origin='automatic'`).all();
      const invalidated = [];
      for (const row of rows) {
        const candidate = this._iconCandidate(row);
        if (isEligible(candidate)) continue;
        const object = this._catalogObjectRow("item-identity", candidate.itemId);
        const now = new Date().toISOString();
        this.db.prepare("UPDATE catalog_icon_candidates SET selected=0,selection_origin=NULL WHERE id=?").run(candidate.id);
        this.db.prepare("UPDATE catalog_repository_objects SET revision=revision+1,updated_at=? WHERE id=?").run(now, object.id);
        const after = this._catalogObjectRow("item-identity", candidate.itemId);
        this.db.prepare(`INSERT INTO catalog_icon_selection_history(object_id,candidate_id,previous_candidate_id,action,actor,note,object_revision,created_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(object.id, null, candidate.id, "automatic-invalidate", "runtime-quality-gate", String(reason), after.revision, now);
        this._recordCatalogTransition(after, { fromStatus: object.status, fromDisposition: object.disposition, reason: `${reason}:${candidate.assetHash}`, evidenceRevision: after.revision });
        invalidated.push({ itemId: candidate.itemId, candidateId: candidate.id, sourceType: candidate.sourceType });
      }
      return invalidated;
    });
  }

  listIconAssets() {
    return this.db.prepare("SELECT * FROM catalog_icon_assets ORDER BY hash").all().map((row) => ({ hash: row.hash, mimeType: row.mime_type, width: Number(row.width), height: Number(row.height), byteSize: Number(row.byte_size), filePath: row.file_path, createdAt: row.created_at }));
  }

  getIconAsset(hash) {
    const row = this.db.prepare("SELECT * FROM catalog_icon_assets WHERE hash=?").get(String(hash));
    return row ? { hash: row.hash, mimeType: row.mime_type, width: Number(row.width), height: Number(row.height), byteSize: Number(row.byte_size), filePath: row.file_path, createdAt: row.created_at } : null;
  }

  getSelectedIconHashes() {
    return Object.fromEntries(this.db.prepare(`SELECT object.object_id,candidate.asset_hash
      FROM catalog_icon_candidates candidate
      JOIN catalog_repository_objects object ON object.id=candidate.object_id
      WHERE object.object_type='item-identity' AND candidate.selected=1
      ORDER BY object.object_id`).all().map((row) => [String(row.object_id), String(row.asset_hash)]));
  }

  getCatalogRevision() {
    const objects = this.db.prepare("SELECT object_type,object_id,status,disposition,revision FROM catalog_repository_objects ORDER BY object_type,object_id").all();
    const conflicts = this.db.prepare("SELECT object_type,object_id,conflict_type,fingerprint,status FROM catalog_repository_conflicts ORDER BY object_type,object_id,conflict_type,fingerprint").all();
    const productionDistributions = this.db.prepare("SELECT producer_item_id,mode_id,revision FROM production_distribution_states ORDER BY producer_item_id,mode_id").all();
    return crypto.createHash("sha256").update(canonicalJson({ objects, conflicts, productionDistributions })).digest("hex");
  }

  getCatalogPresentationRevision() {
    const objects = this.db.prepare("SELECT object_type,object_id,status,disposition,candidate_version_id,active_version_id FROM catalog_repository_objects ORDER BY object_type,object_id").all();
    const conflicts = this.db.prepare("SELECT object_type,object_id,conflict_type,fingerprint,status FROM catalog_repository_conflicts ORDER BY object_type,object_id,conflict_type,fingerprint").all();
    const productionDistributions = this.db.prepare("SELECT producer_item_id,mode_id,revision FROM production_distribution_states ORDER BY producer_item_id,mode_id").all();
    const selectedIcons = this.db.prepare(`SELECT object.object_id,candidate.id,candidate.asset_hash
      FROM catalog_icon_candidates candidate
      JOIN catalog_repository_objects object ON object.id=candidate.object_id
      WHERE candidate.selected=1
      ORDER BY object.object_id`).all();
    return crypto.createHash("sha256").update(canonicalJson({ objects, conflicts, productionDistributions, selectedIcons })).digest("hex");
  }

  getCatalogSemanticRevision() {
    const objects = this.db.prepare("SELECT object_type,object_id,status,disposition,candidate_version_id,active_version_id FROM catalog_repository_objects ORDER BY object_type,object_id").all();
    const conflicts = this.db.prepare("SELECT object_type,object_id,conflict_type,fingerprint,status FROM catalog_repository_conflicts ORDER BY object_type,object_id,conflict_type,fingerprint").all();
    const productionDistributions = this.db.prepare("SELECT producer_item_id,mode_id,revision FROM production_distribution_states ORDER BY producer_item_id,mode_id").all();
    return crypto.createHash("sha256").update(canonicalJson({ objects, conflicts, productionDistributions })).digest("hex");
  }

  getCatalogUiRevision() {
    const objects = this.db.prepare("SELECT object_type,object_id,status,disposition,candidate_version_id,active_version_id FROM catalog_repository_objects ORDER BY object_type,object_id").all();
    const conflicts = this.db.prepare("SELECT object_type,object_id,conflict_type,fingerprint,status FROM catalog_repository_conflicts ORDER BY object_type,object_id,conflict_type,fingerprint").all();
    const productionDistributions = this.db.prepare("SELECT producer_item_id,mode_id,revision FROM production_distribution_states ORDER BY producer_item_id,mode_id").all();
    const iconCandidates = this.db.prepare(`SELECT object.object_id,candidate.id,candidate.asset_hash,candidate.rank_score,candidate.selected,candidate.selection_origin
      FROM catalog_icon_candidates candidate
      JOIN catalog_repository_objects object ON object.id=candidate.object_id
      ORDER BY object.object_id,candidate.id`).all();
    return crypto.createHash("sha256").update(canonicalJson({ objects, conflicts, productionDistributions, iconCandidates })).digest("hex");
  }

  upsertTheoreticalProductionDistribution({ producerItemId, modeId, theoreticalDistribution, observedAt = new Date().toISOString() }) {
    const producer = String(producerItemId || ""), mode = String(modeId || "");
    if (!producer || !mode) throw new TypeError("producerItemId and modeId are required");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM production_distribution_states WHERE producer_item_id=? AND mode_id=?").get(producer, mode);
      let state = row
        ? replaceTheory(parseJson(row.state_json), theoreticalDistribution)
        : createDistributionState({ producerItemId: producer, modeId: mode, theoreticalDistribution });
      if (row && canonicalJson(parseJson(row.state_json).theoreticalDistribution) === canonicalJson(state.theoreticalDistribution)) return this.getProductionDistribution(producer, mode);
      if (!row) {
        const pending = this.db.prepare(`SELECT action_id,outcome_json FROM production_action_observations
          WHERE attributable=1 AND producer_item_id=? AND mode_id=? ORDER BY id`).all(producer, mode);
        for (const action of pending) state = updateDistributionState(state, { actionId: action.action_id, outcomeItemIds: parseJson(action.outcome_json), attributable: true });
      }
      this.db.prepare(`INSERT INTO production_distribution_states(producer_item_id,mode_id,state_json,revision,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(producer_item_id,mode_id) DO UPDATE SET state_json=excluded.state_json,revision=production_distribution_states.revision+1,updated_at=excluded.updated_at`)
        .run(producer, mode, JSON.stringify(state), 1, observedAt);
      this._recordProductionDistributionReview(state, observedAt);
      return this.getProductionDistribution(producer, mode);
    });
  }

  recordProductionActionObservation({ actionId, producerItemId = null, modeId = null, outcomeItemIds = [], attributable = false, reason = null, observedAt = new Date().toISOString() }) {
    const normalizedActionId = String(actionId || "");
    if (!normalizedActionId) throw new TypeError("production observation actionId is required");
    return this.transaction(() => {
      const duplicate = this.db.prepare("SELECT id FROM production_action_observations WHERE action_id=?").get(normalizedActionId);
      if (duplicate) return { duplicate: true, state: producerItemId != null && modeId != null ? this.getProductionDistribution(producerItemId, modeId) : null };
      const attributableAction = attributable === true;
      const producer = attributableAction ? String(producerItemId || "") : (producerItemId == null ? null : String(producerItemId));
      const mode = attributableAction ? String(modeId || "") : (modeId == null ? null : String(modeId));
      const assignedOutcomes = attributableAction ? outcomeItemIds.map(String).filter(Boolean) : [];
      if (attributableAction && (!producer || !mode || !assignedOutcomes.length)) throw new TypeError("attributable production observations require producer, mode, and outcomes");
      this.db.prepare(`INSERT INTO production_action_observations(action_id,producer_item_id,mode_id,attributable,outcome_json,reason,observed_at)
        VALUES(?,?,?,?,?,?,?)`).run(normalizedActionId, producer, mode, attributableAction ? 1 : 0, JSON.stringify(assignedOutcomes), reason, observedAt);
      if (!attributableAction) return { duplicate: false, uncertain: true, state: null };
      const row = this.db.prepare("SELECT * FROM production_distribution_states WHERE producer_item_id=? AND mode_id=?").get(producer, mode);
      if (!row) return { duplicate: false, uncertain: false, pendingTheory: true, state: null };
      const previous = parseJson(row.state_json);
      const state = updateDistributionState(previous, { actionId: normalizedActionId, outcomeItemIds: assignedOutcomes, attributable: true });
      this.db.prepare("UPDATE production_distribution_states SET state_json=?,revision=revision+1,updated_at=? WHERE producer_item_id=? AND mode_id=?")
        .run(JSON.stringify(state), observedAt, producer, mode);
      this._recordProductionDistributionReview(state, observedAt);
      return { duplicate: false, uncertain: false, state };
    });
  }

  _recordProductionDistributionReview(state, observedAt) {
    if (!state.confidence.reviewRequired) return null;
    const details = { theoreticalDistribution: state.theoreticalDistribution, observedDistribution: state.observedDistribution, confidence: state.confidence };
    const fingerprint = crypto.createHash("sha256").update(canonicalJson({ producer: state.producerItemId, mode: state.modeId, configVersion: state.theoreticalDistribution.configVersion, extractionSource: state.theoreticalDistribution.extractionSource })).digest("hex");
    return this.db.prepare(`INSERT INTO production_distribution_review_events(producer_item_id,mode_id,event_type,fingerprint,details_json,status,created_at)
      VALUES(?,?,?,?,?,'open',?) ON CONFLICT(fingerprint) DO UPDATE SET details_json=excluded.details_json,status='open'`)
      .run(state.producerItemId, state.modeId, "theory-observation-conflict", fingerprint, JSON.stringify(details), observedAt);
  }

  getProductionDistribution(producerItemId, modeId, { executionMode = null } = {}) {
    const row = this.db.prepare("SELECT * FROM production_distribution_states WHERE producer_item_id=? AND mode_id=?").get(String(producerItemId), String(modeId));
    if (!row) return null;
    const state = parseJson(row.state_json);
    return { ...state, revision: Number(row.revision), updatedAt: row.updated_at, ...(executionMode ? { planningDistribution: projectPlanningDistribution(state, executionMode) } : {}) };
  }

  listProductionDistributions({ executionMode = null } = {}) {
    return this.db.prepare("SELECT producer_item_id,mode_id FROM production_distribution_states ORDER BY producer_item_id,mode_id").all()
      .map((row) => this.getProductionDistribution(row.producer_item_id, row.mode_id, { executionMode }));
  }

  listUncertainProductionActions() {
    return this.db.prepare("SELECT * FROM production_action_observations WHERE attributable=0 ORDER BY id").all().map((row) => ({
      id: Number(row.id), actionId: row.action_id, producerItemId: row.producer_item_id, modeId: row.mode_id,
      attributable: false, assignedOutcomeItemIds: parseJson(row.outcome_json), reason: row.reason, observedAt: row.observed_at,
    }));
  }

  listProductionDistributionReviewEvents({ status = "open" } = {}) {
    const rows = status == null
      ? this.db.prepare("SELECT * FROM production_distribution_review_events ORDER BY id").all()
      : this.db.prepare("SELECT * FROM production_distribution_review_events WHERE status=? ORDER BY id").all(String(status));
    return rows.map((row) => ({ id: Number(row.id), producerItemId: row.producer_item_id, modeId: row.mode_id, eventType: row.event_type, details: parseJson(row.details_json), status: row.status, createdAt: row.created_at }));
  }

  getCatalogProjection({ includeProvisional = false, executionMode = "assisted" } = {}) {
    const objects = this.listCatalogObjects();
    const byType = (objectType) => objects.filter((object) => object.objectType === objectType);
    const planningPayload = (summary) => {
      const object = this.getCatalogObject(summary.objectType, summary.objectId);
      if (!object || object.disposition !== "enabled") return null;
      if (object.status === "active" || (includeProvisional && object.status === "provisional")) return object.effectiveValue;
      return null;
    };
    const relations = new Map(byType("merge-relation").map((summary) => [summary.objectId, planningPayload(summary)]));
    let items = byType("item-identity").map((summary) => {
      const identity = planningPayload(summary);
      const relation = relations.get(summary.objectId);
      if (!identity || !relation) return null;
      const selectedIcon = this.getSelectedIconCandidate(summary.objectId);
      return {
        id: String(identity.itemId ?? summary.objectId),
        chainId: identity.chainId == null ? null : String(identity.chainId),
        level: Number(identity.level),
        baseUnits: Number(identity.baseUnits),
        mergeTarget: relation.mergeTarget == null || relation.mergeTarget === "" ? null : String(relation.mergeTarget),
        iconResource: identity.iconResourceIdentifier ?? identity.iconResource ?? null,
        iconHash: selectedIcon?.assetHash || null,
        descriptionKey: identity.descriptionKey ?? null,
        itemType: identity.itemType ?? null,
        saleValue: Number(identity.saleValue || 0),
        inferred: summary.status === "provisional",
        repositoryRevision: summary.revision,
      };
    }).filter(Boolean);
    for (;;) {
      const ids = new Set(items.map((item) => item.id));
      const filtered = items.filter((item) => item.mergeTarget == null || ids.has(item.mergeTarget));
      if (filtered.length === items.length) break;
      items = filtered;
    }
    const itemById = new Map(items.map((item) => [item.id, item]));
    const productionModes = byType("production-mode").map((summary) => {
      const mode = planningPayload(summary);
      if (!mode || !itemById.has(String(mode.producerItemId))) return null;
      const distributionState = this.getProductionDistribution(mode.producerItemId, mode.modeId, { executionMode });
      const planningDistribution = distributionState?.planningDistribution || null;
      const proposedOutputs = planningDistribution?.outcomes || mode.outputs || [];
      const outputs = proposedOutputs.filter((output) => itemById.has(String(output.itemId)));
      if (!outputs.length || (!planningDistribution && outputs.length !== proposedOutputs.length)) return null;
      const unavailableOutcomeMass = proposedOutputs.filter((output) => !itemById.has(String(output.itemId))).reduce((sum, output) => sum + Number(output.probability || 0), 0);
      return {
        producerItemId: String(mode.producerItemId), modeId: String(mode.modeId), energyCost: Number(mode.energyCost),
        unlocked: mode.unlocked !== false, switchEntry: mode.switchEntry ? { ...mode.switchEntry } : { status: "unknown", method: null },
        humanLocked: !!mode.humanLocked, inferred: summary.status === "provisional", repositoryRevision: summary.revision,
        theoreticalDistribution: distributionState?.theoreticalDistribution || null,
        observedDistribution: distributionState?.observedDistribution || null,
        planningDistribution,
        confidence: distributionState?.confidence || null,
        uncertaintyMass: planningDistribution ? Math.min(1, Number(planningDistribution.uncertaintyMass || 0) + unavailableOutcomeMass) : null,
        drops: outputs.map((output) => {
          const item = itemById.get(String(output.itemId));
          return { itemId: String(output.itemId), count: Number(output.count ?? 1), probability: Number(output.probability), expectedProbability: Number(output.expectedProbability ?? output.probability), uncertainty: output.uncertainty || null, chainId: item.chainId, level: item.level, baseUnits: item.baseUnits };
        }),
      };
    }).filter(Boolean);
    const producers = byType("production-profile").map((summary) => {
      const profile = planningPayload(summary);
      const planningDistribution = profile?.planningDistribution || profile?.theoreticalDistribution;
      const outcomes = planningDistribution?.outcomes;
      if (!profile || !Array.isArray(outcomes) || !itemById.has(String(profile.producerItemId)) || !outcomes.every((outcome) => itemById.has(String(outcome.itemId)))) return null;
      return {
        itemId: String(profile.producerItemId),
        chainId: profile.chainId == null ? null : String(profile.chainId),
        level: profile.level ?? null,
        energyCost: Number(profile.energyCost),
        sampleSize: Number(planningDistribution.sampleSpaceSize ?? planningDistribution.sampleSize),
        drops: outcomes.map((outcome) => {
          const item = itemById.get(String(outcome.itemId));
          return { itemId: String(outcome.itemId), count: Number(outcome.weight ?? outcome.count), probability: Number(outcome.probability), chainId: item.chainId, level: item.level, baseUnits: item.baseUnits };
        }),
        inferred: summary.status === "provisional",
        repositoryRevision: summary.revision,
        modes: productionModes.filter((mode) => mode.producerItemId === String(profile.producerItemId)).sort((left, right) => left.modeId.localeCompare(right.modeId)),
      };
    }).filter(Boolean);
    const chains = [...new Set(items.map((item) => item.chainId).filter(Boolean))].sort().map((chainId) => {
      const members = items.filter((item) => item.chainId === chainId).sort((left, right) => left.level - right.level || left.id.localeCompare(right.id));
      const levels = members.map((item) => item.level);
      const contiguous = levels.every((level, index) => index === 0 || level === levels[index - 1] + 1);
      return { id: chainId, minLevel: Math.min(...levels), maxLevel: Math.max(...levels), observedMaxLevel: Math.max(...levels), complete: contiguous && members.at(-1)?.mergeTarget == null, itemIds: members.map((item) => item.id) };
    });
    const coverage = { completeChains: chains.filter((chain) => chain.complete).map((chain) => chain.id), incompleteChains: chains.filter((chain) => !chain.complete).map((chain) => chain.id), producerConfigurations: producers.length };
    return { revision: this.getCatalogRevision(), coverage, chains, items, producers, stats: { chains: chains.length, items: items.length, producers: producers.length, drops: producers.reduce((sum, producer) => sum + producer.drops.length, 0), observations: this.getCatalogRepositorySummary().observations } };
  }

  exportCatalogSnapshot() {
    const portableCandidate = (candidate) => {
      if (!candidate) return candidate;
      const { filePath, ...portable } = candidate;
      return portable;
    };
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source: { type: "sqlite-catalog-repository", revision: this.getCatalogRevision() },
      projection: this.getCatalogProjection({ includeProvisional: true }),
      repository: this.getCatalogRepositorySummary(),
      objects: this.listCatalogObjects().map((summary) => {
        const object = this.getCatalogObject(summary.objectType, summary.objectId);
        if (object.objectType !== "item-identity") return object;
        return { ...object, iconCandidates: object.iconCandidates.map(portableCandidate), selectedIcon: portableCandidate(object.selectedIcon) };
      }),
      conflicts: this.listCatalogConflicts({ status: null }),
      icons: { assets: this.listIconAssets().map(({ filePath, ...asset }) => ({ ...asset, contentBase64: fs.readFileSync(filePath).toString("base64") })) },
    };
  }

  _restoreCatalogObjectSnapshot(exported) {
    const identity = validateCatalogIdentity(exported.objectType, exported.objectId);
    if (!CATALOG_VERSION_STATES.has(exported.status) || !CATALOG_DISPOSITIONS.has(exported.disposition)) throw new TypeError(`invalid catalog snapshot state: ${identity.objectType}/${identity.objectId}`);
    const createdAt = exported.createdAt || new Date().toISOString();
    const updatedAt = exported.updatedAt || createdAt;
    const inserted = this.db.prepare(`INSERT INTO catalog_repository_objects(object_type,object_id,status,disposition,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(identity.objectType, identity.objectId, exported.status, exported.disposition, Number(exported.revision), createdAt, updatedAt);
    const repositoryObjectId = Number(inserted.lastInsertRowid);
    for (const evidence of exported.evidence || []) {
      const payloadJson = canonicalJson(evidence.payload || {});
      const fingerprint = evidence.fingerprint || crypto.createHash("sha256").update(payloadJson).digest("hex");
      this.db.prepare(`INSERT INTO catalog_repository_evidence(object_id,fingerprint,source_type,source_ref,payload_json,disposition,observation_count,first_observed_at,last_observed_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(repositoryObjectId, fingerprint, evidence.sourceType, evidence.sourceRef || "", payloadJson, evidence.disposition || "eligible", Number(evidence.observationCount || 1), evidence.firstObservedAt || evidence.lastObservedAt || createdAt, evidence.lastObservedAt || evidence.firstObservedAt || createdAt);
    }
    const versionIds = new Map();
    for (const version of exported.versions || []) {
      const restored = this.db.prepare(`INSERT INTO catalog_repository_versions(object_id,version,status,origin,payload_json,evidence_summary_json,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(repositoryObjectId, Number(version.version), version.status, version.origin || "unspecified", canonicalJson(version.payload || {}), canonicalJson(version.evidenceSummary || {}), version.createdAt || createdAt);
      versionIds.set(Number(version.id), Number(restored.lastInsertRowid));
    }
    this.db.prepare("UPDATE catalog_repository_objects SET candidate_version_id=?,active_version_id=? WHERE id=?")
      .run(versionIds.get(Number(exported.candidateVersion?.id)) ?? null, versionIds.get(Number(exported.activeVersion?.id)) ?? null, repositoryObjectId);
    const json = (value) => JSON.stringify(value === undefined ? null : value);
    for (const ruling of exported.rulingHistory || []) {
      this.db.prepare(`INSERT INTO catalog_repository_rulings(object_id,field_path,decision,value_json,actor,note,old_value_json,new_value_json,object_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(repositoryObjectId, ruling.fieldPath, ruling.decision, ruling.decision === "revoke" ? null : json(ruling.value), ruling.actor, ruling.note, json(ruling.oldValue), json(ruling.newValue), Number(ruling.objectRevision), ruling.createdAt || createdAt);
    }
    for (const transition of exported.transitions || []) {
      this.db.prepare(`INSERT INTO catalog_repository_transitions(object_id,from_status,to_status,from_disposition,to_disposition,reason,evidence_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(repositoryObjectId, transition.fromStatus, transition.toStatus, transition.fromDisposition, transition.toDisposition, transition.reason, Number(transition.evidenceRevision), transition.createdAt || createdAt);
    }
    const iconCandidates = exported.iconCandidates || [];
    if (iconCandidates.filter((candidate) => candidate.selected).length > 1) throw new TypeError(`catalog snapshot has multiple selected icons: ${identity.objectId}`);
    const iconCandidateIds = new Map();
    for (const candidate of iconCandidates) {
      const insertedCandidate = this.db.prepare(`INSERT INTO catalog_icon_candidates(object_id,asset_hash,cache_key,source_type,resource_url,runtime_identifier,texture_uuid,crop_json,similarity_json,rank_score,selection_origin,selected,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(repositoryObjectId, candidate.assetHash, candidate.cacheKey, candidate.sourceType, candidate.resourceUrl, candidate.runtimeIdentifier, candidate.textureUuid, canonicalJson(candidate.crop || {}), canonicalJson(candidate.similarity || {}), Number(candidate.rankScore ?? 1), candidate.selectionOrigin || null, candidate.selected ? 1 : 0, candidate.createdAt || createdAt);
      iconCandidateIds.set(Number(candidate.id), Number(insertedCandidate.lastInsertRowid));
    }
    for (const history of exported.iconSelectionHistory || []) {
      this.db.prepare(`INSERT INTO catalog_icon_selection_history(object_id,candidate_id,previous_candidate_id,action,actor,note,object_revision,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(repositoryObjectId, iconCandidateIds.get(Number(history.candidateId)) ?? null, iconCandidateIds.get(Number(history.previousCandidateId)) ?? null, history.action, history.actor, history.note, Number(history.objectRevision), history.createdAt || createdAt);
    }
  }

  importCatalogSnapshot(snapshot, { sourceFile = null } = {}) {
    if (!snapshot || Number(snapshot.schemaVersion) !== 1 || snapshot.source?.type !== "sqlite-catalog-repository" || !Array.isArray(snapshot.objects)) throw new TypeError("unsupported catalog snapshot format");
    return this.transaction(() => {
      if (this.getCatalogRepositorySummary().objects === 0) {
        for (const asset of snapshot.icons?.assets || []) {
          const bytes = Buffer.from(String(asset.contentBase64 || ""), "base64");
          if (!bytes.length || crypto.createHash("sha256").update(bytes).digest("hex") !== asset.hash) throw new TypeError(`catalog snapshot icon content hash mismatch: ${asset.hash}`);
          const directory = path.join(path.dirname(this.filePath), "icon-cache", String(asset.hash).slice(0, 2));
          const filePath = path.join(directory, `${asset.hash}.png`);
          fs.mkdirSync(directory, { recursive: true });
          if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, bytes);
          this.db.prepare(`INSERT INTO catalog_icon_assets(hash,mime_type,width,height,byte_size,file_path,created_at)
            VALUES(?,?,?,?,?,?,?)`).run(asset.hash, asset.mimeType, Number(asset.width), Number(asset.height), Number(asset.byteSize), filePath, asset.createdAt);
        }
        for (const exported of snapshot.objects) this._restoreCatalogObjectSnapshot(exported);
        for (const conflict of snapshot.conflicts || []) {
          const detailsJson = canonicalJson(conflict.details || {});
          const fingerprint = conflict.fingerprint || crypto.createHash("sha256").update(detailsJson).digest("hex");
          this.db.prepare(`INSERT INTO catalog_repository_conflicts(object_type,object_id,conflict_type,fingerprint,details_json,status,occurrence_count,created_at,last_seen_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(conflict.objectType, conflict.objectId, conflict.conflictType, fingerprint, detailsJson, conflict.status, Number(conflict.occurrenceCount || 1), conflict.createdAt, conflict.lastSeenAt);
        }
        return { imported: snapshot.objects.length, preserved: 0, revision: this.getCatalogRevision(), repository: this.getCatalogRepositorySummary() };
      }
      let imported = 0, preserved = 0;
      const importedObjects = new Set();
      for (const exported of snapshot.objects) {
        const identity = validateCatalogIdentity(exported.objectType, exported.objectId);
        let existing = this.getCatalogObject(identity.objectType, identity.objectId);
        const preserveAuthority = !!existing;
        const evidence = exported.evidence?.length ? exported.evidence : [{ payload: exported.algorithmCandidate || {}, sourceType: "json-import", sourceRef: sourceFile }];
        for (const item of evidence) {
          const importedSourceType = preserveAuthority ? "json-import" : item.sourceType || "json-import";
          const importedSourceRef = `${sourceFile || "catalog-snapshot"}#${item.sourceType || "unknown"}:${item.sourceRef || "evidence"}`;
          this._observeCatalogObject({ ...identity, payload: item.payload || {}, sourceType: importedSourceType, sourceRef: importedSourceRef, observedAt: item.lastObservedAt, countDuplicate: false });
          if (!preserveAuthority && item.disposition && item.disposition !== "eligible") {
            const current = this.getCatalogObject(identity.objectType, identity.objectId);
            const restoredEvidence = current.evidence.find((candidate) => candidate.sourceType === importedSourceType && candidate.sourceRef === importedSourceRef);
            this.setCatalogEvidenceDisposition(identity.objectType, identity.objectId, restoredEvidence.id, item.disposition, { reason: "restored-from-json", expectedRevision: current.revision });
          }
        }
        if (existing) { preserved += 1; continue; }
        existing = this.getCatalogObject(identity.objectType, identity.objectId);
        const versions = (exported.versions || []).slice(1);
        for (const version of versions) {
          existing = this.saveCatalogVersion({ ...identity, payload: version.payload || {}, status: version.status, expectedRevision: existing.revision, origin: version.origin || "legacy-migration" });
        }
        if (!versions.length && ["active", "provisional"].includes(exported.status)) {
          existing = this.saveCatalogVersion({ ...identity, payload: exported.algorithmCandidate || {}, status: exported.status, expectedRevision: existing.revision, origin: "legacy-migration" });
        }
        for (const ruling of exported.rulingHistory || []) {
          const current = this.getCatalogObject(identity.objectType, identity.objectId);
          if (ruling.decision === "revoke") {
            if (current.humanValues?.[ruling.fieldPath]) this.revokeCatalogRuling({ ...identity, fieldPath: ruling.fieldPath, actor: ruling.actor || "json-import", note: ruling.note || "restored from JSON", expectedRevision: current.revision, createdAt: ruling.createdAt });
          } else {
            this.applyCatalogRuling({ ...identity, fieldPath: ruling.fieldPath, decision: ruling.decision || "modify", value: ruling.value, actor: ruling.actor || "json-import", note: ruling.note || "restored from JSON", expectedRevision: current.revision, createdAt: ruling.createdAt });
          }
        }
        const current = this.getCatalogObject(identity.objectType, identity.objectId);
        if (exported.disposition && exported.disposition !== "enabled") this.setCatalogObjectDisposition(identity.objectType, identity.objectId, exported.disposition, { reason: "restored-from-json", expectedRevision: current.revision });
        importedObjects.add(`${identity.objectType}:${identity.objectId}`);
        imported += 1;
      }
      for (const conflict of snapshot.conflicts || []) {
        if (!importedObjects.has(`${conflict.objectType}:${conflict.objectId}`)) continue;
        const restoredConflict = this.recordCatalogConflict({ objectType: conflict.objectType, objectId: conflict.objectId, conflictType: conflict.conflictType, details: conflict.details, countDuplicate: false });
        if (conflict.status === "resolved") this.resolveCatalogConflictFingerprint(conflict.objectType, conflict.objectId, conflict.conflictType, restoredConflict.fingerprint);
      }
      return { imported, preserved, revision: this.getCatalogRevision(), repository: this.getCatalogRepositorySummary() };
    });
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
      ? "DO UPDATE SET status='open',occurrence_count=occurrence_count+1,last_seen_at=excluded.last_seen_at"
      : "DO UPDATE SET status='open',last_seen_at=excluded.last_seen_at";
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
      id: Number(row.id), objectType: row.object_type, objectId: row.object_id, fingerprint: row.fingerprint,
      conflictType: row.conflict_type, details: parseJson(row.details_json), status: row.status,
      occurrenceCount: Number(row.occurrence_count), createdAt: row.created_at, lastSeenAt: row.last_seen_at,
    }));
  }

  resolveCatalogConflicts(objectType, objectId, conflictType, { exceptFingerprint = null } = {}) {
    const except = exceptFingerprint == null ? "" : " AND fingerprint<>?";
    const values = [new Date().toISOString(), String(objectType), String(objectId), String(conflictType)];
    if (exceptFingerprint != null) values.push(String(exceptFingerprint));
    this.db.prepare(`UPDATE catalog_repository_conflicts SET status='resolved',last_seen_at=? WHERE object_type=? AND object_id=? AND conflict_type=? AND status='open'${except}`)
      .run(...values);
  }

  resolveCatalogConflictFingerprint(objectType, objectId, conflictType, fingerprint) {
    this.db.prepare("UPDATE catalog_repository_conflicts SET status='resolved',last_seen_at=? WHERE object_type=? AND object_id=? AND conflict_type=? AND fingerprint=? AND status='open'")
      .run(new Date().toISOString(), String(objectType), String(objectId), String(conflictType), String(fingerprint));
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

  listSessions(limit = 50) {
    return this.db.prepare("SELECT * FROM automation_sessions ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(500, Number(limit) || 50))).map((row) => ({
      id: Number(row.id), mode: row.mode, startedAt: row.started_at, endedAt: row.ended_at, status: row.status, settings: JSON.parse(row.settings_json || "{}"),
    }));
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
