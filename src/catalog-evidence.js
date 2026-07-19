"use strict";

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

function collectPassiveCatalogEvidence(database, { state = null, actionDiff = null } = {}) {
  const observations = [];
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
      addObservation({
        objectType: "production-mode", objectId: `${producerItemId}:${modeId}`,
        payload: {
          producerItemId, modeId, energyCost: current ? Number(producer.energyCost) : null, outputs: [],
          unlocked: mode.unlocked !== false, current,
          switchEntry: producer.productionModeSwitchEntry || { status: "unknown", method: null },
        },
        sourceType: "passive-runtime", sourceRef: `board-production-mode:${producer.index}:${modeId}`, countDuplicate: false,
      });
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
  if (actionDiff?.type === "produce" && actionDiff.producerItemId != null && (actionDiff.outputItemId ?? actionDiff.actualOutputItemId) != null) {
    const producerItemId = String(actionDiff.producerItemId);
    const outputItemId = String(actionDiff.outputItemId ?? actionDiff.actualOutputItemId);
    addObservedItem(outputItemId, {}, "action-diff:production-output");
    const existing = existingObject("production-profile", producerItemId);
    addObservation({
      objectType: "production-profile", objectId: producerItemId,
      payload: { ...(existing?.effectiveValue || existing?.algorithmCandidate || {}), producerItemId, latestObservedOutputItemId: outputItemId },
      sourceType: "passive-action-diff", sourceRef: "verified-production", countDuplicate: false,
    });
  }
  if (actionDiff?.type === "produce" && actionDiff.verified === true && actionDiff.producerItemId != null && actionDiff.productionModeId != null && actionDiff.actualOutputItemIds?.length) {
    const producerItemId = String(actionDiff.producerItemId), modeId = String(actionDiff.productionModeId);
    const counts = new Map(actionDiff.actualOutputItemIds.map(String).map((itemId) => [itemId, 0]));
    for (const itemId of actionDiff.actualOutputItemIds.map(String)) counts.set(itemId, (counts.get(itemId) || 0) + 1);
    const existing = existingObject("production-mode", `${producerItemId}:${modeId}`);
    addObservation({
      objectType: "production-mode", objectId: `${producerItemId}:${modeId}`,
      payload: {
        ...(existing?.effectiveValue || existing?.algorithmCandidate || {}), producerItemId, modeId,
        outputs: [...counts].map(([itemId, count]) => ({ itemId, count, probability: 1 })),
      },
      sourceType: "verified-production-mode", sourceRef: `verified-production-mode:${producerItemId}:${modeId}`,
    });
  }
  if (!observations.length) return [];
  database.observeCatalogBatch(observations);
  return observations.map((observation) => `${observation.objectType}:${observation.objectId}`);
}

module.exports = { buildCatalogEvidenceIndex, collectPassiveCatalogEvidence };
