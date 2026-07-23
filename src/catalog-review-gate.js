"use strict";

const { distributionFromDrops, observedDistribution } = require("./catalog-migration");
const { canonicalJson } = require("./canonical-json");

const STRUCTURED_SOURCES = new Set(["runtime-capture", "structured-runtime", "legacy-migration"]);
const STRUCTURAL_INFERENCE_SOURCES = new Set(["structural-inference"]);
const VISUAL_EVIDENCE_SOURCES = new Set(["visual-evidence", "screenshot-evidence"]);
const VERIFIED_MODE_SOURCE = "verified-production-mode";

function currentPayload(object) {
  return object?.activeVersion?.payload || object?.candidateVersion?.payload || object?.versions?.at(-1)?.payload || {};
}

function identityPayload(payload) {
  const level = Number(payload.level);
  return {
    itemId: String(payload.itemId ?? payload.id ?? ""),
    chainId: payload.chainId == null ? null : String(payload.chainId),
    level,
    baseUnits: Number(payload.baseUnits ?? (level > 0 ? 2 ** (level - 1) : 0)),
    iconResourceIdentifier: payload.iconResourceIdentifier ?? payload.iconResource ?? null,
    iconEvidenceStatus: payload.iconEvidenceStatus || "missing",
    saleValue: Number(payload.saleValue ?? payload.price ?? 0),
  };
}

function relationPayload(payload) {
  return {
    itemId: String(payload.itemId ?? payload.id ?? ""),
    chainId: payload.chainId == null ? null : String(payload.chainId),
    level: Number(payload.level),
    mergeTarget: payload.mergeTarget == null || payload.mergeTarget === "" ? null : String(payload.mergeTarget),
  };
}

function profilePayload(payload) {
  if (payload.theoreticalDistribution) return payload;
  return {
    producerItemId: String(payload.producerItemId ?? payload.itemId ?? ""),
    chainId: payload.chainId == null ? null : String(payload.chainId),
    level: payload.level ?? null,
    energyCost: Number(payload.energyCost),
    theoreticalDistribution: distributionFromDrops(payload.drops || [], payload.sampleSize),
    observedDistribution: observedDistribution([]),
  };
}

function modePayload(payload) {
  return {
    producerItemId: String(payload.producerItemId ?? payload.itemId ?? ""),
    modeId: String(payload.modeId ?? ""),
    energyCost: Number(payload.energyCost),
    outputs: (payload.outputs || payload.drops || []).map((output) => ({
      itemId: String(output.itemId ?? ""), count: Number(output.count ?? output.weight ?? 0), probability: Number(output.probability ?? 1),
    })),
    unlocked: payload.unlocked !== false,
    switchEntry: payload.switchEntry ? { status: payload.switchEntry.status || "unknown", method: payload.switchEntry.method ?? null } : { status: "unknown", method: null },
    humanLocked: !!payload.humanLocked,
  };
}

class CatalogReviewGate {
  constructor(database) {
    this.database = database;
  }

  _eligibleEvidence(object) {
    return object.evidence.filter((evidence) => evidence.disposition === "eligible");
  }

  _structuredEvidence(evidence) {
    return [...evidence].reverse().find((item) => STRUCTURED_SOURCES.has(item.sourceType) || (item.sourceType === VERIFIED_MODE_SOURCE && Number(item.observationCount) >= 2)) || null;
  }

  _provisionalEvidence(evidence) {
    return [...evidence].reverse().find((item) => STRUCTURAL_INFERENCE_SOURCES.has(item.sourceType))
      || [...evidence].reverse().find((item) => VISUAL_EVIDENCE_SOURCES.has(item.sourceType))
      || [...evidence].reverse().find((item) => item.sourceType === VERIFIED_MODE_SOURCE)
      || null;
  }

  _recordEvidenceConflict(object, evidence) {
    const normalize = object.objectType === "item-identity" ? identityPayload
      : object.objectType === "merge-relation" ? relationPayload
        : object.objectType === "production-mode" ? modePayload : profilePayload;
    const latestBySourceType = new Map();
    for (const item of evidence) latestBySourceType.set(item.sourceType, item);
    const payloads = new Map();
    for (const item of latestBySourceType.values()) {
      const key = canonicalJson(normalize(item.payload));
      if (!payloads.has(key)) payloads.set(key, []);
      payloads.get(key).push({ evidenceId: item.id, sourceType: item.sourceType, sourceRef: item.sourceRef, fingerprint: item.fingerprint });
    }
    this.database.transaction(() => {
      if (payloads.size < 2) {
        this.database.resolveCatalogConflicts(object.objectType, object.objectId, "evidence-conflict");
        return;
      }
      const conflict = this.database.recordCatalogConflict({
        objectType: object.objectType,
        objectId: object.objectId,
        conflictType: "evidence-conflict",
        details: { variants: [...payloads.values()] },
        countDuplicate: false,
      });
      this.database.resolveCatalogConflicts(object.objectType, object.objectId, "evidence-conflict", { exceptFingerprint: conflict.fingerprint });
    });
  }

  decide(object) {
    const evidence = this._eligibleEvidence(object);
    if (!evidence.length) return { status: "observed", payload: currentPayload(object), reason: "no-eligible-evidence" };
    this._recordEvidenceConflict(object, evidence);
    const structured = this._structuredEvidence(evidence);
    const provisional = this._provisionalEvidence(evidence);
    const selected = structured || provisional || evidence.at(-1);

    if (object.objectType === "item-identity") {
      const payload = identityPayload(selected.payload);
      const consistent = payload.itemId === object.objectId && payload.chainId && Number.isInteger(payload.level) && payload.level > 0
        && Number.isFinite(payload.baseUnits) && payload.baseUnits > 0 && payload.baseUnits === 2 ** (payload.level - 1);
      if (structured && consistent) return { status: "active", payload, reason: "structured-runtime-consistent:item-identity" };
      if ((provisional || selected.sourceType === "historic-action") && consistent) return { status: "provisional", payload, reason: `provisional-only-source:${selected.sourceType}` };
      return { status: "observed", payload, reason: consistent ? "insufficient-source-authority:item-identity" : "identity-inconsistent" };
    }

    if (object.objectType === "merge-relation") {
      const payload = relationPayload(selected.payload);
      let shapeValid = payload.itemId === object.objectId && payload.chainId && Number.isInteger(payload.level) && payload.level > 0;
      const sourceIdentity = payload.itemId ? this.database.getCatalogObject("item-identity", payload.itemId) : null;
      if (shapeValid && payload.mergeTarget != null) {
        const target = this.database.getCatalogObject("item-identity", payload.mergeTarget);
        const targetPayload = currentPayload(target);
        if (target && (String(targetPayload.chainId) !== payload.chainId || Number(targetPayload.level) !== payload.level + 1)) shapeValid = false;
      }
      let dependenciesActive = sourceIdentity?.status === "active" && sourceIdentity.disposition === "enabled";
      if (dependenciesActive && payload.mergeTarget != null) {
        const target = this.database.getCatalogObject("item-identity", payload.mergeTarget);
        dependenciesActive = target?.status === "active" && target.disposition === "enabled";
      }
      if (structured && shapeValid && dependenciesActive) return { status: "active", payload, reason: "structured-runtime-consistent:merge-relation" };
      if (shapeValid) return { status: "provisional", payload, reason: structured ? "structured-runtime-incomplete:merge-relation" : `provisional-only-source:${selected.sourceType}` };
      return { status: "observed", payload, reason: "relation-inconsistent" };
    }

    if (object.objectType === "production-mode") {
      const payload = modePayload(selected.payload);
      const objectMatches = object.objectId === `${payload.producerItemId}:${payload.modeId}`;
      const producerIdentity = this.database.getCatalogObject("item-identity", payload.producerItemId);
      const outputsActive = payload.outputs.every((output) => {
        const identity = this.database.getCatalogObject("item-identity", output.itemId);
        return identity?.status === "active" && identity.disposition === "enabled";
      });
      const valid = objectMatches && payload.producerItemId && payload.modeId && Number.isFinite(payload.energyCost) && payload.energyCost >= 0
        && payload.outputs.length > 0 && payload.outputs.every((output) => output.itemId && Number.isFinite(output.count) && output.count > 0 && Number.isFinite(output.probability) && output.probability > 0 && output.probability <= 1)
        && ["available", "unavailable"].includes(payload.switchEntry.status);
      const dependenciesActive = producerIdentity?.status === "active" && producerIdentity.disposition === "enabled" && outputsActive;
      if (structured && valid && dependenciesActive) return { status: "active", payload, reason: "structured-runtime-consistent:production-mode" };
      if ((provisional || selected.sourceType === "historic-action") && valid) return { status: "provisional", payload, reason: `provisional-only-source:${selected.sourceType}` };
      return { status: "observed", payload, reason: valid ? "production-mode-dependencies-inactive" : "production-mode-inconsistent" };
    }

    const payload = profilePayload(selected.payload);
    const outcomes = Array.isArray(payload.theoreticalDistribution?.outcomes) ? payload.theoreticalDistribution.outcomes : [];
    const sampleSize = Number(payload.theoreticalDistribution?.sampleSpaceSize);
    const probabilitySum = outcomes.reduce((sum, outcome) => sum + Number(outcome.probability), 0);
    const countSum = outcomes.reduce((sum, outcome) => sum + Number(outcome.weight), 0);
    const producerIdentity = this.database.getCatalogObject("item-identity", String(payload.producerItemId));
    const outputsActive = outcomes.every((outcome) => {
      const identity = this.database.getCatalogObject("item-identity", String(outcome.itemId));
      return identity?.status === "active" && identity.disposition === "enabled";
    });
    const distributionValid = payload.producerItemId === object.objectId && Number.isFinite(payload.energyCost) && payload.energyCost >= 0
      && Number.isInteger(sampleSize) && sampleSize > 0 && outcomes.length > 0
      && outcomes.every((outcome) => Number.isInteger(Number(outcome.weight)) && Number(outcome.weight) >= 0 && Number.isFinite(Number(outcome.probability)) && Number(outcome.probability) >= 0 && Number(outcome.probability) <= 1)
      && Math.abs(probabilitySum - 1) <= 1e-9 && countSum === sampleSize;
    const dependenciesActive = producerIdentity?.status === "active" && producerIdentity.disposition === "enabled" && outputsActive;
    if (structured && distributionValid && dependenciesActive) return { status: "active", payload, reason: "structured-runtime-consistent:production-profile" };
    if (distributionValid) return { status: "provisional", payload, reason: structured ? "structured-runtime-incomplete:production-profile" : `provisional-only-source:${selected.sourceType}` };
    return { status: "observed", payload, reason: "distribution-inconsistent:production-profile" };
  }

  evaluateObject(objectType, objectId) {
    const object = this.database.getCatalogObject(objectType, objectId);
    if (!object) throw new Error(`catalog object not found: ${objectType}/${objectId}`);
    if (object.activeVersion?.origin === "user" || object.candidateVersion?.origin === "user") {
      this._recordEvidenceConflict(object, this._eligibleEvidence(object));
      return this.database.getCatalogObject(objectType, objectId);
    }
    const decision = this.decide(object);
    return this.database.transitionCatalogObject({
      objectType, objectId, status: decision.status, payload: decision.payload,
      reason: decision.reason, expectedRevision: object.revision, origin: "inference-gate",
    });
  }

  evaluateAll({ objectIds = null } = {}) {
    const ids = objectIds ? new Set(objectIds.map(String)) : null;
    const objects = this.database.listCatalogObjects().filter((object) => !ids || ids.has(String(object.objectId)));
    const order = { "item-identity": 0, "merge-relation": 1, "production-profile": 2 };
    return objects.sort((left, right) => order[left.objectType] - order[right.objectType] || left.objectId.localeCompare(right.objectId))
      .map((object) => this.evaluateObject(object.objectType, object.objectId));
  }

  setObjectDisposition(objectType, objectId, disposition, reason, expectedRevision) {
    return this.database.setCatalogObjectDisposition(objectType, objectId, disposition, { reason, expectedRevision });
  }

  setEvidenceDisposition(objectType, objectId, evidenceId, disposition, reason, expectedRevision) {
    return this.database.transaction(() => {
      this.database.setCatalogEvidenceDisposition(objectType, objectId, evidenceId, disposition, { reason, expectedRevision });
      return this.evaluateObject(objectType, objectId);
    });
  }
}

function buildPlanningCatalogFromRepository(database, legacyCatalog, { includeProvisional = false, executionMode = "assisted" } = {}) {
  return database.getCatalogProjection({ includeProvisional, executionMode });
}

module.exports = { CatalogReviewGate, buildPlanningCatalogFromRepository, identityPayload, relationPayload, profilePayload, modePayload };
