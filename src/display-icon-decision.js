"use strict";

const fs = require("node:fs");
const { canonicalJson } = require("./canonical-json");
const {
  displayIconManualProtection,
  recordDisplayIconHistory,
  setDisplayIconSelection,
} = require("./display-icon-persistence");
const {
  automaticCandidateEligible,
  automaticCandidatePriority,
  evaluateIconEvidenceCurrency,
  provenanceForNewCandidate,
} = require("./icon-evidence-currency");

function parseJson(value) {
  return value == null ? null : JSON.parse(value);
}

class DisplayIconDecision {
  constructor({ db, transaction, objectResult, resolveAssetPath = (_hash, filePath) => filePath }) {
    this.db = db;
    this.transaction = transaction;
    this.objectResult = objectResult;
    this.resolveAssetPath = resolveAssetPath;
  }

  _candidate(row) {
    return row ? {
      id: Number(row.id),
      itemId: row.object_key,
      assetHash: row.asset_hash,
      cacheKey: row.cache_key,
      sourceType: row.source_type,
      provenance: {
        producer: row.producer || null,
        reconstructionVersion: row.reconstruction_version || null,
        qualityContractVersion: row.quality_contract_version || null,
      },
      currency: {
        status: row.currency_status,
        reason: row.currency_reason,
        policyVersion: row.currency_policy_version,
        evaluatedAt: row.currency_evaluated_at,
      },
      resourceUrl: row.resource_url,
      runtimeIdentifier: row.runtime_identifier,
      textureUuid: row.texture_uuid,
      crop: parseJson(row.crop_json),
      selected: !!row.selected,
      superseded: !!row.superseded,
      similarity: parseJson(row.similarity_json) || {},
      rankScore: Number(row.rank_score),
      selectionOrigin: row.selection_origin || null,
      mimeType: row.mime_type,
      width: Number(row.width),
      height: Number(row.height),
      byteSize: Number(row.byte_size),
      filePath: this.resolveAssetPath(row.asset_hash, row.file_path),
      createdAt: row.created_at,
    } : null;
  }

  _object(itemId) {
    return this.db.prepare(
      "SELECT * FROM catalog_repository_objects WHERE object_type='item-identity' AND object_id=?",
    ).get(String(itemId)) || null;
  }

  _ensure(object, now = new Date().toISOString()) {
    this.db.prepare(`INSERT OR IGNORE INTO catalog_icon_decisions(
      object_id,selected_candidate_id,revision,selection_origin,updated_at
    ) VALUES(?,NULL,1,NULL,?)`).run(object.id, now);
    return this.db.prepare("SELECT * FROM catalog_icon_decisions WHERE object_id=?").get(object.id);
  }

  _candidateSelect() {
    return `SELECT candidate.*,object.object_id AS object_key,
      asset.mime_type,asset.width,asset.height,asset.byte_size,asset.file_path,
      CASE WHEN decision.selected_candidate_id=candidate.id THEN 1 ELSE 0 END AS selected,
      CASE WHEN decision.selected_candidate_id=candidate.id THEN decision.selection_origin ELSE NULL END AS selection_origin,
      EXISTS(
        SELECT 1 FROM catalog_icon_candidate_lineage lineage
        WHERE lineage.predecessor_candidate_id=candidate.id
      ) AS superseded
      FROM catalog_icon_candidates candidate
      JOIN catalog_repository_objects object ON object.id=candidate.object_id
      JOIN catalog_icon_assets asset ON asset.hash=candidate.asset_hash
      LEFT JOIN catalog_icon_decisions decision ON decision.object_id=candidate.object_id`;
  }

  candidateByCacheKey(repositoryObjectId, cacheKey) {
    return this._candidate(this.db.prepare(`${this._candidateSelect()}
      WHERE candidate.object_id=? AND candidate.cache_key=?`).get(repositoryObjectId, String(cacheKey)));
  }

  findAcquisition(cacheKey) {
    return this._candidate(this.db.prepare(`${this._candidateSelect()}
      WHERE candidate.cache_key=? ORDER BY candidate.id LIMIT 1`).get(String(cacheKey)));
  }

  candidates(repositoryObjectId) {
    return this.db.prepare(`${this._candidateSelect()}
      WHERE candidate.object_id=? ORDER BY candidate.id`).all(repositoryObjectId).map((row) => this._candidate(row));
  }

  _automaticCandidates(repositoryObjectId) {
    return this.db.prepare(`${this._candidateSelect()}
      WHERE candidate.object_id=?`).all(repositoryObjectId)
      .map((candidate) => ({
        ...candidate,
        file_path: this.resolveAssetPath(candidate.asset_hash, candidate.file_path),
      }))
      .filter(automaticCandidateEligible)
      .sort(automaticCandidatePriority);
  }

  selected(repositoryObjectId) {
    const candidate = this._candidate(this.db.prepare(`${this._candidateSelect()}
      WHERE candidate.object_id=? AND decision.selected_candidate_id=candidate.id
      ORDER BY candidate.id DESC LIMIT 1`).get(repositoryObjectId));
    return candidate && fs.existsSync(candidate.filePath) ? candidate : null;
  }

  readByObjectId(repositoryObjectId) {
    const decision = this.db.prepare("SELECT * FROM catalog_icon_decisions WHERE object_id=?").get(repositoryObjectId);
    const selectedCandidate = decision?.selected_candidate_id == null
      ? null
      : this._candidate(this.db.prepare(`${this._candidateSelect()}
        WHERE candidate.id=? AND candidate.object_id=?`).get(
        decision.selected_candidate_id,
        repositoryObjectId,
      ));
    const history = this.db.prepare(`SELECT history.*,candidate.asset_hash,previous.asset_hash AS previous_asset_hash
      FROM catalog_icon_selection_history history
      LEFT JOIN catalog_icon_candidates candidate ON candidate.id=history.candidate_id
      LEFT JOIN catalog_icon_candidates previous ON previous.id=history.previous_candidate_id
      WHERE history.object_id=? ORDER BY history.id`).all(repositoryObjectId).map((entry) => ({
      id: Number(entry.id),
      candidateId: entry.candidate_id == null ? null : Number(entry.candidate_id),
      assetHash: entry.asset_hash || null,
      previousCandidateId: entry.previous_candidate_id == null ? null : Number(entry.previous_candidate_id),
      previousAssetHash: entry.previous_asset_hash || null,
      action: entry.action,
      actor: entry.actor,
      note: entry.note,
      revision: Number(entry.decision_revision || 1),
      objectRevision: Number(entry.object_revision),
      createdAt: entry.created_at,
    }));
    return {
      revision: Number(decision?.revision || 1),
      selectionOrigin: decision?.selection_origin || null,
      manualProtection: decision?.selection_origin === "manual",
      protectedEmpty: decision?.selection_origin === "manual"
        && decision?.selected_candidate_id == null,
      selectedCandidate,
      selectedIcon: this.selected(repositoryObjectId),
      candidates: this.candidates(repositoryObjectId),
      history,
    };
  }

  read(itemId) {
    const object = this._object(itemId);
    return object ? this.readByObjectId(object.id) : null;
  }

  _assertRevision(decision, expectedRevision) {
    if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 1) {
      const required = new Error("expectedDisplayIconRevision is required");
      required.code = "DISPLAY_ICON_REVISION_REQUIRED";
      required.statusCode = 428;
      throw required;
    }
    if (Number(expectedRevision) === Number(decision.revision)) return;
    const conflict = new Error(`display icon revision conflict: expected ${expectedRevision}, actual ${decision.revision}`);
    conflict.code = "DISPLAY_ICON_REVISION_CONFLICT";
    conflict.statusCode = 409;
    conflict.currentDisplayIcon = this.readByObjectId(decision.object_id);
    throw conflict;
  }

  observeCandidate({
    itemId,
    cacheKey,
    sourceType,
    resourceUrl = null,
    runtimeIdentifier = null,
    textureUuid = null,
    crop = {},
    similarity = {},
    rankScore = 1,
    autoSelect = true,
    producer = null,
    reconstructionVersion = null,
    qualityContractVersion = null,
    asset,
  }) {
    if (!asset?.hash || !asset.mimeType || !Number.isInteger(Number(asset.width))
      || !Number.isInteger(Number(asset.height)) || !asset.filePath) {
      throw new TypeError("complete icon asset metadata is required");
    }
    return this.transaction(() => {
      const object = this._object(itemId);
      if (!object) throw new Error(`catalog object not found: item-identity/${itemId}`);
      const now = new Date().toISOString();
      const provenance = provenanceForNewCandidate({
        sourceType,
        producer,
        reconstructionVersion,
        qualityContractVersion,
      });
      const currency = evaluateIconEvidenceCurrency({
        sourceType,
        producer: provenance.producer,
        reconstructionVersion: provenance.reconstructionVersion,
        qualityContractVersion: provenance.qualityContractVersion,
      });
      this.db.prepare(`INSERT INTO catalog_icon_assets(hash,mime_type,width,height,byte_size,file_path,created_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(hash) DO NOTHING`)
        .run(String(asset.hash), String(asset.mimeType), Number(asset.width), Number(asset.height),
          Number(asset.byteSize), String(asset.filePath), now);
      const decision = this._ensure(object, now);
      const manualPreference = displayIconManualProtection(
        this.db,
        object.id,
        decision.selection_origin,
      );
      const selected = decision.selected_candidate_id == null
        ? null
        : this.db.prepare("SELECT * FROM catalog_icon_candidates WHERE id=?").get(decision.selected_candidate_id);
      this.db.prepare(`INSERT INTO catalog_icon_candidates(
        object_id,asset_hash,cache_key,source_type,producer,reconstruction_version,
        quality_contract_version,currency_status,currency_reason,currency_policy_version,
        currency_evaluated_at,resource_url,runtime_identifier,texture_uuid,
        crop_json,similarity_json,rank_score,selection_origin,selected,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,0,?)
      ON CONFLICT(object_id,cache_key) DO UPDATE SET
        asset_hash=excluded.asset_hash,
        resource_url=excluded.resource_url,
        runtime_identifier=excluded.runtime_identifier,
        texture_uuid=excluded.texture_uuid,
        crop_json=excluded.crop_json,
        similarity_json=excluded.similarity_json,
        rank_score=excluded.rank_score`)
        .run(
          object.id,
          String(asset.hash),
          String(cacheKey),
          String(sourceType),
          provenance.producer,
          provenance.reconstructionVersion,
          provenance.qualityContractVersion,
          currency.status,
          currency.reason,
          currency.policyVersion,
          now,
          resourceUrl,
          runtimeIdentifier,
          textureUuid,
          canonicalJson(crop || {}),
          canonicalJson(similarity || {}),
          Number(rankScore),
          now,
        );
      const candidate = this.db.prepare(
        "SELECT * FROM catalog_icon_candidates WHERE object_id=? AND cache_key=?",
      ).get(object.id, String(cacheKey));
      const automaticCandidates = this._automaticCandidates(object.id);
      const eligibleCandidate = automaticCandidates.find((entry) => entry.id === candidate.id);
      const eligibleSelected = selected
        ? automaticCandidates.find((entry) => entry.id === selected.id)
        : null;
      const shouldSelect = autoSelect && !manualPreference && eligibleCandidate
        && (!eligibleSelected
          || automaticCandidatePriority(eligibleCandidate, eligibleSelected) < 0);
      let decisionChange = null;
      if (shouldSelect && Number(decision.selected_candidate_id) !== Number(candidate.id)) {
        const { after } = setDisplayIconSelection(
          this.db,
          object,
          candidate.id,
          "automatic",
          now,
        );
        recordDisplayIconHistory(this.db, object, {
          candidateId: candidate.id,
          previousCandidateId: decision.selected_candidate_id == null
            ? null
            : Number(decision.selected_candidate_id),
          action: "automatic-select",
          actor: "runtime",
          note: `automatic candidate selected from ${sourceType}`,
          decisionRevision: after.revision,
          createdAt: now,
        });
        decisionChange = {
          action: "automatic-select",
          revision: Number(after.revision),
        };
      }
      return {
        candidate: this.candidateByCacheKey(object.id, cacheKey),
        decisionChange,
      };
    });
  }

  observeAndDecide(candidateInput, decisionInput) {
    return this.transaction(() => {
      const { candidate } = this.observeCandidate({ ...candidateInput, autoSelect: false });
      const object = this.decide(candidateInput.itemId, {
        ...decisionInput,
        kind: "select",
        candidateId: candidate.id,
      });
      return { candidate, object };
    });
  }

  decide(itemId, command) {
    if (!String(command?.actor || "").trim() || !String(command?.note || "").trim()) {
      throw new TypeError("icon selection actor and note are required");
    }
    return this.transaction(() => {
      const object = this._object(itemId);
      if (!object) throw new Error(`catalog object not found: item-identity/${itemId}`);
      const now = new Date().toISOString();
      const decision = this._ensure(object, now);
      this._assertRevision(decision, command.expectedDisplayIconRevision);
      let candidate = null;
      if (command.kind === "select") {
        candidate = this.db.prepare(
          "SELECT * FROM catalog_icon_candidates WHERE id=? AND object_id=?",
        ).get(Number(command.candidateId), object.id);
        if (!candidate) {
          throw Object.assign(new Error(`icon candidate not found: ${command.candidateId}`), { statusCode: 404 });
        }
      } else if (command.kind === "automatic") {
        candidate = this._automaticCandidates(object.id)[0] || null;
      } else if (command.kind !== "revoke") {
        throw new TypeError(`unsupported display icon decision: ${command.kind}`);
      }
      const previousCandidateId = decision.selected_candidate_id == null
        ? null
        : Number(decision.selected_candidate_id);
      const automatic = command.kind === "automatic";
      const { after } = setDisplayIconSelection(
        this.db,
        object,
        candidate?.id ?? null,
        automatic ? (candidate ? "automatic" : null) : "manual",
        now,
      );
      recordDisplayIconHistory(this.db, object, {
        candidateId: candidate?.id ?? null,
        previousCandidateId,
        action: automatic
          ? "automatic-control-return"
          : command.kind === "select" ? "manual-select" : "manual-revoke",
        actor: String(command.actor).trim(),
        note: String(command.note).trim(),
        decisionRevision: after.revision,
        createdAt: now,
      });
      return this.objectResult(this._object(itemId));
    });
  }

  invalidateAutomaticSelections(isEligible, { reason = "automatic-icon-quality-gate" } = {}) {
    if (typeof isEligible !== "function") throw new TypeError("icon eligibility predicate is required");
    return this.transaction(() => {
      const rows = this.db.prepare(`${this._candidateSelect()}
        WHERE decision.selected_candidate_id=candidate.id
          AND decision.selection_origin='automatic'`).all();
      const invalidated = [];
      for (const row of rows) {
        const candidate = this._candidate(row);
        if (isEligible(candidate)) continue;
        const object = this._object(candidate.itemId);
        const now = new Date().toISOString();
        const { after } = setDisplayIconSelection(this.db, object, null, null, now);
        recordDisplayIconHistory(this.db, object, {
          previousCandidateId: candidate.id,
          action: "automatic-invalidate",
          actor: "runtime-quality-gate",
          note: String(reason),
          decisionRevision: after.revision,
          createdAt: now,
        });
        invalidated.push({
          itemId: candidate.itemId,
          candidateId: candidate.id,
          sourceType: candidate.sourceType,
          displayIconRevision: Number(after.revision),
        });
      }
      return invalidated;
    });
  }
}

module.exports = { DisplayIconDecision };
