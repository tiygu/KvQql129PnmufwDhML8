"use strict";

const { sameJsonValue } = require("./canonical-json");

function inferenceBasis(item) {
  return item.inferenceBasis || {
    type: "structural-rule",
    rule: item.inferenceRule || "continuous-id-or-catalog-structure",
    itemId: String(item.id),
  };
}

function identityPayload(item) {
  return {
    itemId: String(item.id),
    descriptionKey: item.descriptionKey ?? null,
    itemType: item.itemType ?? null,
    level: Number(item.level),
    baseUnits: Number(item.baseUnits ?? (Number(item.level) > 0 ? 2 ** (Number(item.level) - 1) : 0)),
    chainId: String(item.chainId),
    iconResourceIdentifier: item.iconResource ?? null,
    iconEvidenceStatus: "missing",
    ...(item.inferred ? { inferenceBasis: inferenceBasis(item) } : {}),
  };
}

function relationPayload(item) {
  return {
    itemId: String(item.id),
    chainId: String(item.chainId),
    level: Number(item.level),
    mergeTarget: item.mergeTarget == null || item.mergeTarget === "" ? null : String(item.mergeTarget),
    ...(item.inferred ? { inferenceBasis: inferenceBasis(item) } : {}),
  };
}

function distributionFromDrops(drops, sampleSize, { configVersion = "unknown", extractionSource = "CreateData" } = {}) {
  return {
    source: "CreateData",
    configVersion: String(configVersion),
    extractionSource: String(extractionSource),
    sampleSpaceSize: Number(sampleSize || (drops || []).reduce((sum, drop) => sum + Number(drop.count || 0), 0)),
    outcomes: (drops || []).map((drop) => ({
      itemId: String(drop.itemId),
      weight: Number(drop.count ?? 0),
      probability: Number(drop.probability ?? 0),
    })),
  };
}

function observedDistribution(actions) {
  const counts = new Map();
  for (const action of actions) counts.set(String(action.outputItemId), (counts.get(String(action.outputItemId)) || 0) + 1);
  const sampleSize = actions.length;
  return {
    sampleSize,
    outcomes: [...counts].map(([itemId, count]) => ({ itemId, count, probability: sampleSize ? count / sampleSize : 0 })),
  };
}

function ensureMigratedVersion(database, objectType, objectId, payload, status, recordConflict) {
  const object = database.getCatalogObject(objectType, objectId);
  const matching = object.versions.some((version) => version.status === status && sameJsonValue(version.payload, payload));
  if (matching) return { changed: false, object };
  const authoritative = object.activeVersion || object.candidateVersion;
  const withoutObservedDistribution = (value) => {
    if (!value || typeof value !== "object") return value;
    const { observedDistribution, ...rest } = value;
    return rest;
  };
  const attributableObservationUpdate = objectType === "production-profile" && authoritative?.origin === "legacy-migration"
    && sameJsonValue(withoutObservedDistribution(authoritative.payload), withoutObservedDistribution(payload));
  if (authoritative && !sameJsonValue(authoritative.payload, payload) && !attributableObservationUpdate) {
    recordConflict(objectType, objectId, "migration-existing-version", {
      requestedStatus: status,
      existingStatus: authoritative.status,
      existingVersion: authoritative.version,
      existingPayload: authoritative.payload,
      migrationPayload: payload,
    });
    return { changed: false, object };
  }
  return { changed: true, object: database.saveCatalogVersion({ objectType, objectId, payload, status, expectedRevision: object.revision, origin: "legacy-migration" }) };
}

function migrateLegacyCatalogInTransaction(database, catalog, { sourceFile = null, historicActions = [], recordSourceEvidence = true } = {}) {
  const conflictsBefore = database.listCatalogConflicts().length;
  const chainById = new Map((catalog.chains || []).map((chain) => [String(chain.id), chain]));
  const itemById = new Map((catalog.items || []).map((item) => [String(item.id), item]));
  const validItems = [];
  const invalidItemIds = new Set();
  const provisionalProducerIds = new Set();
  const recordConflict = (objectType, objectId, conflictType, details) => database.recordCatalogConflict({ objectType, objectId, conflictType, details, countDuplicate: false });

  for (const item of catalog.items || []) {
    const itemId = String(item.id || "");
    const chainId = String(item.chainId || "");
    const chain = chainById.get(chainId);
    const reasons = [];
    if (!itemId) reasons.push("missing-item-id");
    if (!chain) reasons.push("unknown-chain");
    if (!Number.isInteger(Number(item.level)) || Number(item.level) < 1) reasons.push("invalid-level");
    const expectedBaseUnits = Number.isInteger(Number(item.level)) && Number(item.level) > 0 ? 2 ** (Number(item.level) - 1) : null;
    if (!Number.isFinite(Number(item.baseUnits)) || Number(item.baseUnits) <= 0) reasons.push("invalid-base-units");
    else if (expectedBaseUnits != null && Number(item.baseUnits) !== expectedBaseUnits) reasons.push("base-units-level-mismatch");
    if (chain?.itemIds?.length && !chain.itemIds.map(String).includes(itemId)) reasons.push("chain-membership-mismatch");
    if (reasons.length) {
      invalidItemIds.add(itemId);
      if (itemId) database.observeCatalogObject({ objectType: "item-identity", objectId: itemId, payload: item, sourceType: "legacy-migration-invalid", sourceRef: sourceFile, countDuplicate: false });
      recordConflict("item-identity", itemId || "unknown", "migration-validation", { reasons, payload: item });
    } else validItems.push(item);
  }

  const validProducers = (catalog.producers || []).filter((producer) => {
    const producerId = String(producer.itemId || "");
    const reasons = [];
    if (!producerId || invalidItemIds.has(producerId) || !itemById.has(producerId)) reasons.push("unknown-producer-item");
    if (!Number.isFinite(Number(producer.energyCost)) || Number(producer.energyCost) < 0) reasons.push("invalid-energy-cost");
    const drops = producer.drops || [];
    const sampleSize = Number(producer.sampleSize);
    if (!drops.length) reasons.push("missing-theoretical-distribution");
    if (!Number.isInteger(sampleSize) || sampleSize < 1) reasons.push("invalid-theoretical-sample-size");
    let probabilitySum = 0, countSum = 0;
    for (const drop of drops) {
      const probability = Number(drop.probability), count = Number(drop.count);
      if (!drop.itemId) reasons.push("drop-missing-item-id");
      else if (!itemById.has(String(drop.itemId)) || invalidItemIds.has(String(drop.itemId))) reasons.push(`unknown-drop-item:${drop.itemId}`);
      if (!Number.isInteger(count) || count < 0) reasons.push(`invalid-drop-count:${drop.itemId}`);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) reasons.push(`invalid-drop-probability:${drop.itemId}`);
      probabilitySum += probability;
      countSum += count;
      if (sampleSize > 0 && Number.isFinite(probability) && Number.isInteger(count) && Math.abs(probability - count / sampleSize) > 1e-9) reasons.push(`drop-count-probability-mismatch:${drop.itemId}`);
    }
    if (Math.abs(probabilitySum - 1) > 1e-9) reasons.push("drop-probability-sum-mismatch");
    if (countSum !== sampleSize) reasons.push("drop-count-sum-mismatch");
    if (reasons.length) recordConflict("production-profile", producerId || "unknown", "migration-validation", { reasons, payload: producer });
    const fatal = reasons.some((reason) => reason === "unknown-producer-item" || reason === "invalid-energy-cost" || reason === "missing-theoretical-distribution" || reason === "invalid-theoretical-sample-size" || reason.startsWith("drop-missing-item-id") || reason.startsWith("invalid-drop-count") || reason.startsWith("invalid-drop-probability"));
    if (fatal) return false;
    if (reasons.length) provisionalProducerIds.add(producerId);
    return true;
  });

  if (recordSourceEvidence) {
    database.importCatalog({ ...catalog, items: validItems, producers: validProducers }, { sourceFile, sourceType: "legacy-migration" });
  } else {
    for (const item of validItems) {
      const itemId = String(item.id);
      if (!database.getCatalogObject("item-identity", itemId)) database.observeCatalogObject({ objectType: "item-identity", objectId: itemId, payload: item, sourceType: "legacy-projection-recovery", sourceRef: sourceFile, countDuplicate: false });
      if (!database.getCatalogObject("merge-relation", itemId)) database.observeCatalogObject({ objectType: "merge-relation", objectId: itemId, payload: relationPayload(item), sourceType: "legacy-projection-recovery", sourceRef: sourceFile, countDuplicate: false });
    }
    for (const producer of validProducers) {
      const producerId = String(producer.itemId);
      if (!database.getCatalogObject("production-profile", producerId)) database.observeCatalogObject({ objectType: "production-profile", objectId: producerId, payload: producer, sourceType: "legacy-projection-recovery", sourceRef: sourceFile, countDuplicate: false });
    }
  }

  let migrated = 0;
  for (const item of validItems) {
    const itemId = String(item.id);
    const identityStatus = item.inferred ? "provisional" : "active";
    if (ensureMigratedVersion(database, "item-identity", itemId, identityPayload(item), identityStatus, recordConflict).changed) migrated += 1;

    let relationStatus = item.inferred ? "provisional" : "active";
    if (item.mergeTarget != null && item.mergeTarget !== "") {
      const target = itemById.get(String(item.mergeTarget));
      if (!target) relationStatus = "provisional";
      else if (String(target.chainId) !== String(item.chainId) || Number(target.level) !== Number(item.level) + 1) {
        recordConflict("merge-relation", itemId, "migration-relation-mismatch", { item, target });
        continue;
      }
    }
    const relation = relationPayload(item);
    if (relationStatus === "provisional" && !relation.inferenceBasis) relation.inferenceBasis = { type: "incomplete-structure", reason: "merge-target-not-in-catalog", mergeTarget: relation.mergeTarget };
    if (ensureMigratedVersion(database, "merge-relation", itemId, relation, relationStatus, recordConflict).changed) migrated += 1;
  }

  const attributableActions = (historicActions || []).filter((action) => action?.attributable === true && action.producerItemId != null && action.outputItemId != null);
  for (const action of attributableActions) {
    const producerId = String(action.producerItemId);
    if (!validProducers.some((producer) => String(producer.itemId) === producerId)) {
      recordConflict("production-profile", producerId, "migration-unmatched-action", { action });
      continue;
    }
    database.observeCatalogObject({
      objectType: "production-profile",
      objectId: producerId,
      payload: { kind: "observed-production-action", producerItemId: producerId, outputItemId: String(action.outputItemId), actionId: action.id ?? null },
      sourceType: "historic-action",
      sourceRef: action.id == null ? `${sourceFile || "legacy"}:action:${historicActions.indexOf(action)}` : String(action.id),
      countDuplicate: false,
    });
  }

  for (const producer of validProducers) {
    const producerId = String(producer.itemId);
    const actions = attributableActions.filter((action) => String(action.producerItemId) === producerId);
    const payload = {
      producerItemId: producerId,
      chainId: producer.chainId == null ? null : String(producer.chainId),
      level: producer.level ?? null,
      energyCost: Number(producer.energyCost ?? 0),
      theoreticalDistribution: distributionFromDrops(producer.drops || [], producer.sampleSize, {
        configVersion: catalog.schemaVersion ?? catalog.version ?? "legacy-unknown",
        extractionSource: sourceFile ? `CreateData:${sourceFile}` : "CreateData",
      }),
      observedDistribution: observedDistribution(actions),
      ...(producer.inferred ? { inferenceBasis: inferenceBasis(producer) } : {}),
    };
    const profileStatus = producer.inferred || provisionalProducerIds.has(producerId) ? "provisional" : "active";
    if (profileStatus === "provisional" && !payload.inferenceBasis) payload.inferenceBasis = { type: "configuration-conflict", reason: "production-distribution-needs-review" };
    if (ensureMigratedVersion(database, "production-profile", producerId, payload, profileStatus, recordConflict).changed) migrated += 1;
  }

  return {
    migrated,
    conflicts: Math.max(0, database.listCatalogConflicts().length - conflictsBefore),
    repository: database.getCatalogRepositorySummary(),
  };
}

function migrateLegacyCatalog(database, catalog, options = {}) {
  return database.transaction(() => migrateLegacyCatalogInTransaction(database, catalog, options));
}

function buildMigratedPlanningCatalog(database, legacyCatalog) {
  const items = [];
  for (const legacyItem of legacyCatalog.items || []) {
    const identityObject = database.getCatalogObject("item-identity", String(legacyItem.id));
    const relationObject = database.getCatalogObject("merge-relation", String(legacyItem.id));
    const identity = identityObject?.activeVersion?.payload || identityObject?.candidateVersion?.payload;
    const relation = relationObject?.activeVersion?.payload || relationObject?.candidateVersion?.payload;
    if (!identity || !relation) continue;
    items.push({
      id: String(identity.itemId), chainId: String(identity.chainId), level: Number(identity.level),
      baseUnits: Number(identity.baseUnits), mergeTarget: relation.mergeTarget,
      iconResource: identity.iconResourceIdentifier, inferred: identityObject.status === "provisional",
    });
  }
  const itemById = new Map(items.map((item) => [String(item.id), item]));
  const producers = [];
  for (const legacyProducer of legacyCatalog.producers || []) {
    const object = database.getCatalogObject("production-profile", String(legacyProducer.itemId));
    const profile = object?.activeVersion?.payload || object?.candidateVersion?.payload;
    if (!profile) continue;
    producers.push({
      itemId: String(profile.producerItemId), chainId: profile.chainId, level: profile.level,
      energyCost: profile.energyCost, sampleSize: profile.theoreticalDistribution.sampleSpaceSize,
      drops: profile.theoreticalDistribution.outcomes.map((outcome) => {
        const item = itemById.get(String(outcome.itemId));
        return { itemId: String(outcome.itemId), count: outcome.weight, probability: outcome.probability, chainId: item?.chainId ?? null, level: item?.level ?? null, baseUnits: item?.baseUnits ?? null };
      }),
    });
  }
  return { ...legacyCatalog, items, producers };
}

module.exports = { migrateLegacyCatalog, buildMigratedPlanningCatalog, identityPayload, relationPayload, distributionFromDrops, observedDistribution };
