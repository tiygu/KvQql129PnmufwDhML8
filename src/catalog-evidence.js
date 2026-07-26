"use strict";

const crypto = require("node:crypto");

function buildCatalogEvidenceIndex(database) {
  return {
    objects: database.listCatalogObjects().map((summary) => ({
      objectType: summary.objectType,
      objectId: summary.objectId,
      status: summary.status,
      disposition: summary.disposition,
      revision: summary.revision,
    })),
  };
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "")).filter(Boolean))].sort();
}

function productionProfileSnapshot(payload = {}, { producerItemId, outputItemIds = [], modeIds = [] }) {
  const distributionCandidate = payload.theoreticalDistribution?.outcomes || payload.planningDistribution?.outcomes || payload.drops;
  const legacyDistribution = Array.isArray(distributionCandidate) ? distributionCandidate : [];
  const existingCandidateOutputs = Array.isArray(payload.candidateOutputs) ? payload.candidateOutputs : [];
  const existingProductionModes = Array.isArray(payload.productionModes) ? payload.productionModes : [];
  const legacyModes = Array.isArray(payload.modes) ? payload.modes : [];
  const candidateOutputs = uniqueStrings([
    ...existingCandidateOutputs,
    ...legacyDistribution.map((output) => output?.itemId),
    payload.latestObservedOutputItemId,
    payload.outputItemId,
    ...outputItemIds,
  ]);
  const normalizedModes = uniqueStrings([
    ...existingProductionModes,
    ...legacyModes.map((mode) => mode?.modeId ?? mode),
    ...modeIds,
  ]);
  return {
    producerItemId: String(producerItemId ?? payload.producerItemId ?? payload.itemId ?? ""),
    candidateOutputs,
    productionModes: normalizedModes,
  };
}

function collectPassiveCatalogEvidence(database, { state = null, actionDiff = null } = {}) {
  const observations = [];
  const conflicts = [];
  const observationKeys = new Set();
  const objectCache = new Map();
  const existingObject = (objectType, objectId) => {
    const key = `${objectType}:${objectId}`;
    if (!objectCache.has(key)) objectCache.set(key, database.getCatalogObject(objectType, objectId));
    return objectCache.get(key);
  };
  const addObservation = (observation) => {
    const key = `${observation.objectType}:${observation.objectId}:${observation.sourceType}:${observation.sourceRef}:${JSON.stringify(observation.payload)}`;
    if (observationKeys.has(key)) return;
    observationKeys.add(key);
    observations.push(observation);
  };
  const recordProductionObservation = (observation) => database.recordProductionActionObservation?.({
    ...observation,
    actionId: String(observation.actionId || `production:${crypto.randomUUID()}`),
  });
  const addIdentity = (itemId, detail = {}, sourceRef = "live-state") => {
    if (itemId == null || String(itemId) === "") return;
    const id = String(itemId);
    const existing = existingObject("item-identity", id);
    addObservation({
      objectType: "item-identity", objectId: id,
      payload: { ...(existing?.effectiveValue || existing?.algorithmCandidate || {}), itemId: id, ...(detail.level == null ? {} : { level: Number(detail.level) }) },
      sourceType: "passive-runtime", sourceRef, countDuplicate: false,
    });
  };
  const addObservedItem = (itemId, detail = {}, sourceRef = "live-state") => {
    addIdentity(itemId, detail, sourceRef);
    if (itemId == null || String(itemId) === "") return;
    const id = String(itemId);
    const existing = existingObject("merge-relation", id);
    addObservation({
      objectType: "merge-relation", objectId: id,
      payload: { ...(existing?.effectiveValue || existing?.algorithmCandidate || {}), itemId: id, ...(detail.level == null ? {} : { level: Number(detail.level) }) },
      sourceType: "passive-runtime", sourceRef, countDuplicate: false,
    });
  };
  for (const grid of state?.board?.grids || []) addObservedItem(grid.itemId, grid, "board-state");
  for (const order of state?.orders || []) for (const item of order.items || []) addObservedItem(item.itemId, item, "order-state");
  for (const producer of state?.producers || []) {
    const producerItemId = String(producer.itemId || "");
    if (!producerItemId) continue;
    for (const mode of producer.availableProductionModes || []) {
      const modeId = String(mode.modeId);
      const current = String(producer.currentProductionModeId) === modeId;
      const theoretical = mode.theoreticalDistribution || mode.productionDistribution;
      const energyCost = producer.energyCost == null ? null : Number(producer.energyCost);
      const outputsPerAction = Number(theoretical?.outputsPerAction ?? 1);
      const structuredOutputs = (theoretical?.outcomes || []).map((outcome) => ({
        itemId: String(outcome.itemId ?? ""),
        count: outputsPerAction,
        probability: Number(outcome.probability),
      }));
      const hasStructuredMode = current && Number.isFinite(energyCost) && energyCost >= 0
        && Number.isFinite(outputsPerAction) && outputsPerAction > 0 && structuredOutputs.length > 0
        && structuredOutputs.every((output) => output.itemId && Number.isFinite(output.probability) && output.probability > 0 && output.probability <= 1);
      addObservation({
        objectType: "production-mode", objectId: `${producerItemId}:${modeId}`,
        payload: {
          producerItemId, modeId, energyCost: current ? energyCost : null,
          outputs: hasStructuredMode ? structuredOutputs : [],
          unlocked: mode.unlocked !== false, current,
          switchEntry: producer.productionModeSwitchEntry || { status: "unknown", method: null },
        },
        sourceType: hasStructuredMode ? "structured-runtime" : "passive-runtime",
        sourceRef: `${hasStructuredMode ? "board-production-mode-structure" : "board-production-mode"}:${producer.index}:${modeId}`,
        countDuplicate: false,
      });
      if (typeof database.upsertTheoreticalProductionDistribution === "function") {
        if (theoretical?.outcomes?.length) {
          database.upsertTheoreticalProductionDistribution({
            producerItemId,
            modeId,
            theoreticalDistribution: {
              ...theoretical,
              configVersion: theoretical.configVersion || "runtime-unknown",
              extractionSource: theoretical.extractionSource || theoretical.source || "runtime-production-mode",
            },
          });
        }
      }
    }
  }

  if (actionDiff?.type === "merge" && actionDiff.itemId != null && actionDiff.actualTarget != null) {
    addObservedItem(actionDiff.itemId, actionDiff, "action-diff:merge-source");
    addObservedItem(actionDiff.actualTarget, {}, "action-diff:merge-target");
    const id = String(actionDiff.itemId);
    const identity = existingObject("item-identity", id);
    addObservation({
      objectType: "merge-relation", objectId: id,
      payload: { itemId: id, chainId: identity?.effectiveValue?.chainId ?? identity?.algorithmCandidate?.chainId ?? null, level: identity?.effectiveValue?.level ?? identity?.algorithmCandidate?.level ?? actionDiff.level ?? null, mergeTarget: String(actionDiff.actualTarget) },
      sourceType: "passive-action-diff", sourceRef: "verified-merge", countDuplicate: false,
    });
  }
  const actionOutputItemIds = uniqueStrings([
    ...(actionDiff?.actualOutputItemIds || []),
    actionDiff?.outputItemId,
    actionDiff?.actualOutputItemId,
  ]);
  const productionActionId = actionDiff?.type === "produce" && actionDiff.verified === true
    ? String(actionDiff.actionId || `production:${crypto.randomUUID()}`)
    : null;
  if (actionDiff?.type === "produce" && actionDiff.verified === true) {
    for (const outputItemId of actionOutputItemIds) addObservedItem(outputItemId, {}, "action-diff:production-output");
  }
  if (actionDiff?.type === "produce" && actionDiff.verified === true && actionDiff.attributable !== false
    && actionDiff.producerItemId != null && actionOutputItemIds.length) {
    const producerItemId = String(actionDiff.producerItemId);
    const existing = existingObject("production-profile", producerItemId);
    addObservation({
      objectType: "production-profile", objectId: producerItemId,
      payload: productionProfileSnapshot(existing?.effectiveValue || existing?.algorithmCandidate, {
        producerItemId,
        outputItemIds: actionOutputItemIds,
        modeIds: actionDiff.productionModeId == null ? [] : [actionDiff.productionModeId],
      }),
      sourceType: "verified-production-profile",
      sourceRef: `verified-production:${productionActionId}`,
      countDuplicate: false,
    });
  }
  if (actionDiff?.type === "produce" && actionDiff.verified === true && actionDiff.attributable !== false
    && actionDiff.producerItemId != null && actionDiff.productionModeId != null && actionOutputItemIds.length) {
    const producerItemId = String(actionDiff.producerItemId), modeId = String(actionDiff.productionModeId);
    const counts = new Map(actionOutputItemIds.map((itemId) => [itemId, 0]));
    for (const itemId of (actionDiff.actualOutputItemIds || actionOutputItemIds).map(String)) counts.set(itemId, (counts.get(itemId) || 0) + 1);
    const existing = existingObject("production-mode", `${producerItemId}:${modeId}`);
    addObservation({
      objectType: "production-mode", objectId: `${producerItemId}:${modeId}`,
      payload: {
        ...(existing?.effectiveValue || existing?.algorithmCandidate || {}), producerItemId, modeId,
        outputs: [...counts].map(([itemId, count]) => ({ itemId, count, probability: 1 })),
      },
      sourceType: "verified-production-mode",
      sourceRef: `verified-production-mode-action:${productionActionId}`,
      countDuplicate: false,
    });
    recordProductionObservation({ actionId: productionActionId, producerItemId, modeId, outcomeItemIds: actionOutputItemIds, attributable: true });
  }
  if (actionDiff?.type === "produce" && actionDiff.verified === true && actionDiff.producerItemId != null
    && actionDiff.attributionConflict) {
    const producerItemId = String(actionDiff.producerItemId);
    const existing = existingObject("production-profile", producerItemId);
    const payload = productionProfileSnapshot(existing?.effectiveValue || existing?.algorithmCandidate, {
      producerItemId,
    });
    addObservation({
      objectType: "production-profile",
      objectId: producerItemId,
      payload,
      sourceType: "production-attribution-conflict",
      sourceRef: `production-attribution-conflict:${actionDiff.actionId || "runtime"}`,
      countDuplicate: false,
    });
    conflicts.push({
      objectType: "production-profile",
      objectId: producerItemId,
      conflictType: "production-attribution-conflict",
      details: {
        actionId: actionDiff.actionId || null,
        productionModeId: actionDiff.productionModeId == null ? null : String(actionDiff.productionModeId),
        candidateProducerItemIds: uniqueStrings(actionDiff.attributionConflict.candidateProducerItemIds || [producerItemId]),
        sourceRefs: uniqueStrings(actionDiff.attributionConflict.sourceRefs || []),
        reason: actionDiff.attributionConflict.reason || "production-action-source-or-attribution-conflict",
      },
      countDuplicate: false,
    });
  }
  if (actionDiff?.uncertain === true || actionDiff?.type === "producer-touch" && actionDiff?.attributable === false
    || actionDiff?.attributionConflict) {
    recordProductionObservation({
      actionId: actionDiff.actionId,
      producerItemId: actionDiff.producerItemId ?? null,
      modeId: actionDiff.productionModeId ?? null,
      attributable: false,
      reason: actionDiff.reason || "production-action-uncertain",
    });
  }
  if (!observations.length && !conflicts.length) return [];
  database.observeCatalogBatch(observations);
  for (const conflict of conflicts) database.recordCatalogConflict(conflict);
  return observations.map((observation) => `${observation.objectType}:${observation.objectId}`);
}

module.exports = { buildCatalogEvidenceIndex, collectPassiveCatalogEvidence, productionProfileSnapshot };
