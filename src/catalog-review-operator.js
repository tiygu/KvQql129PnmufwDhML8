"use strict";

const { buildOptimizationPlan } = require("./order-optimizer");
const { mergeRelationWaitingForObservation } = require("./catalog-review-state");
const { canonicalJson } = require("./canonical-json");

function buildCatalogPlanningImpact(database, state, object) {
  const details = new Map();
  const getDetail = (objectType, objectId) => {
    const key = `${objectType}:${objectId}`;
    if (!details.has(key)) details.set(key, database.getCatalogObject(objectType, String(objectId)));
    return details.get(key);
  };
  const payloadOf = (entry) => entry?.effectiveValue || entry?.algorithmCandidate || {};
  const objectPayload = payloadOf(object);
  const affectedItemIds = new Set();
  if (object.objectType === "item-identity") affectedItemIds.add(String(object.objectId));
  if (object.objectType === "merge-relation") {
    affectedItemIds.add(String(objectPayload.itemId || object.objectId));
    if (objectPayload.mergeTarget != null && objectPayload.mergeTarget !== "") affectedItemIds.add(String(objectPayload.mergeTarget));
  }
  if (object.objectType === "production-profile") {
    affectedItemIds.add(String(objectPayload.producerItemId || object.objectId));
    for (const itemId of objectPayload.candidateOutputs || []) affectedItemIds.add(String(itemId));
  }
  if (object.objectType === "production-mode") {
    if (objectPayload.producerItemId) affectedItemIds.add(String(objectPayload.producerItemId));
    for (const output of objectPayload.outputs || []) if (output?.itemId) affectedItemIds.add(String(output.itemId));
  }

  const relationEntries = database.listCatalogObjects({ objectType: "merge-relation" }).map((summary) => {
    const relation = getDetail(summary.objectType, summary.objectId);
    const payload = payloadOf(relation);
    return {
      objectId: String(summary.objectId),
      sourceItemId: String(payload.itemId || summary.objectId),
      targetItemId: payload.mergeTarget == null || payload.mergeTarget === "" ? null : String(payload.mergeTarget),
      disposition: relation?.disposition || summary.disposition,
    };
  });
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const relation of relationEntries) {
      if (!affectedItemIds.has(relation.sourceItemId) && (!relation.targetItemId || !affectedItemIds.has(relation.targetItemId))) continue;
      for (const itemId of [relation.sourceItemId, relation.targetItemId].filter(Boolean)) {
        if (affectedItemIds.has(itemId)) continue;
        affectedItemIds.add(itemId);
        expanded = true;
      }
    }
  }

  const itemLabel = (itemId) => {
    const value = payloadOf(getDetail("item-identity", itemId));
    const name = [value.name, value.displayName, value.title, value.description, value.descriptionKey]
      .find((candidate) => String(candidate || "").trim());
    const level = Number(value.level);
    return `${String(name || itemId).trim()}${Number.isInteger(level) && level > 0 ? `（第 ${level} 级）` : ""}`;
  };
  const relations = relationEntries
    .filter((relation) => affectedItemIds.has(relation.sourceItemId)
      || (relation.targetItemId && affectedItemIds.has(relation.targetItemId)))
    .map((relation) => ({
      objectId: relation.objectId,
      sourceItemId: relation.sourceItemId,
      sourceLabel: itemLabel(relation.sourceItemId),
      targetItemId: relation.targetItemId,
      targetLabel: relation.targetItemId ? itemLabel(relation.targetItemId) : "最高等级或未观测结果",
      disposition: relation.disposition,
    }));
  const orders = (state?.orders || []).map((order, index) => {
    const requiredItemIds = [...new Set([
      ...(order.requiredItemIds || []),
      ...(order.items || []).map((item) => item.itemId),
    ].filter(Boolean).map(String))];
    const impactedItemIds = requiredItemIds.filter((itemId) => affectedItemIds.has(itemId));
    if (!impactedItemIds.length) return null;
    return {
      slot: String(order.slot ?? index + 1),
      impactedItemIds,
      impactedItems: impactedItemIds.map(itemLabel),
    };
  }).filter(Boolean);
  return {
    summary: orders.length || relations.length
      ? `暂停后，${orders.length} 个当前订单和 ${relations.length} 条合成关系将暂时失去该对象提供的规划路径。`
      : "当前未发现直接受影响的订单或合成关系；暂停仍会让该对象立即退出规划。",
    orders,
    relations,
    affectedItemIds: [...affectedItemIds],
  };
}

function meaningfulSnapshotDifferences(before, after) {
  const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...fields].sort().flatMap((fieldPath) => {
    const oldValue = before?.[fieldPath] ?? null;
    const newValue = after?.[fieldPath] ?? null;
    return canonicalJson(oldValue) === canonicalJson(newValue)
      ? []
      : [{ fieldPath, oldValue, newValue }];
  });
}

class CatalogReviewOperator {
  constructor({
    database,
    catalogGate,
    getSettings,
    getState,
    getPlanningCatalog,
    publishPlan,
    invalidateCatalogView,
    onEvent = null,
  }) {
    if (!database) throw new TypeError("catalog review database is required");
    if (!catalogGate) throw new TypeError("catalog review gate is required");
    if (typeof getSettings !== "function" || typeof getState !== "function"
      || typeof getPlanningCatalog !== "function" || typeof publishPlan !== "function"
      || typeof invalidateCatalogView !== "function") {
      throw new TypeError("catalog review runtime accessors are required");
    }
    this.database = database;
    this.catalogGate = catalogGate;
    this.getSettings = getSettings;
    this.getState = getState;
    this.getPlanningCatalog = getPlanningCatalog;
    this.publishPlan = publishPlan;
    this.invalidateCatalogView = invalidateCatalogView;
    this.onEvent = onEvent;
    this.replanner = null;
    this.reviewSession = { revision: 0, commandRevision: 0, skippedObjectKeys: [], resumeObjectKey: null };
  }

  emit(type, payload = {}) {
    this.onEvent?.(type, payload);
  }

  get reviewRevision() {
    return this.reviewSession.revision;
  }

  getReviewSession() {
    return {
      revision: this.reviewSession.revision,
      commandRevision: this.reviewSession.commandRevision,
      skippedObjectKeys: [...this.reviewSession.skippedObjectKeys],
      resumeObjectKey: this.reviewSession.resumeObjectKey,
    };
  }

  getReviewProjection() {
    const reviewQueue = this.database.getCatalogReviewQueue().map((entry) => {
      if (entry.objectType !== "merge-relation") return entry;
      const relation = this.database.getCatalogObject(entry.objectType, entry.objectId);
      const candidate = relation?.algorithmCandidate || relation?.effectiveValue || {};
      const target = candidate.mergeTarget == null
        ? null
        : this.database.getCatalogObject("item-identity", candidate.mergeTarget);
      const waiting = mergeRelationWaitingForObservation({
        relationCandidate: candidate,
        relationEvidence: relation?.evidence || [],
        targetIdentity: target,
      });
      return waiting.waiting
        ? { ...entry, actionStatus: "等待更多线索", waitingForMoreClues: waiting }
        : entry;
    });
    return {
      reviewQueue: this.projectCatalogReviewQueue(reviewQueue),
      reviewSession: this.getReviewSession(),
    };
  }

  projectCatalogReviewQueue(reviewQueue) {
    const entriesByKey = new Map(reviewQueue.map((entry) => [`${entry.objectType}:${entry.objectId}`, entry]));
    const skippedObjectKeys = this.reviewSession.skippedObjectKeys.filter((key) => entriesByKey.has(key));
    if (skippedObjectKeys.length !== this.reviewSession.skippedObjectKeys.length) {
      const resumeObjectKey = entriesByKey.has(this.reviewSession.resumeObjectKey)
        ? this.reviewSession.resumeObjectKey
        : reviewQueue[0] ? `${reviewQueue[0].objectType}:${reviewQueue[0].objectId}` : null;
      this.reviewSession = {
        revision: this.reviewSession.revision + 1,
        commandRevision: this.reviewSession.commandRevision,
        skippedObjectKeys,
        resumeObjectKey,
      };
    }
    const skippedSet = new Set(skippedObjectKeys);
    return [
      ...reviewQueue.filter((entry) => !skippedSet.has(`${entry.objectType}:${entry.objectId}`)),
      ...skippedObjectKeys.map((key) => ({ ...entriesByKey.get(key), actionStatus: "已跳过" })),
    ];
  }

  skipCatalogReview({ objectType, objectId }) {
    const key = `${objectType}:${objectId}`;
    const currentQueue = this.getReviewProjection().reviewQueue;
    const currentIndex = currentQueue.findIndex((entry) => `${entry.objectType}:${entry.objectId}` === key);
    if (currentIndex < 0) {
      throw Object.assign(new Error(`catalog review target not found: ${objectType}/${objectId}`), {
        code: "CATALOG_REVIEW_TARGET_NOT_FOUND",
        statusCode: 404,
      });
    }
    const nextObjectKey = currentQueue.length > 1
      ? `${currentQueue[(currentIndex + 1) % currentQueue.length].objectType}:${currentQueue[(currentIndex + 1) % currentQueue.length].objectId}`
      : null;
    this.reviewSession = {
      revision: this.reviewSession.revision + 1,
      commandRevision: this.reviewSession.commandRevision + 1,
      skippedObjectKeys: [
        ...this.reviewSession.skippedObjectKeys.filter((candidate) => candidate !== key),
        key,
      ],
      resumeObjectKey: nextObjectKey,
    };
    this.invalidateCatalogView();
    const repository = this.getReviewProjection();
    const nextReviewTarget = repository.reviewQueue.find((entry) => `${entry.objectType}:${entry.objectId}` === nextObjectKey) || null;
    return {
      ok: true,
      reviewQueue: repository.reviewQueue,
      reviewSession: repository.reviewSession,
      nextReviewTarget,
    };
  }

  getCatalogObject(objectType, objectId) {
    const object = this.database.getCatalogObject(objectType, objectId);
    if (!object) return object;
    const catalogEvidenceAuditSummaries = this.database.listCatalogEvidenceAuditSummaries({ objectType, objectId });
    const catalogAuditSummary = [object.catalogAuditSummary, catalogEvidenceAuditSummaries.at(-1)]
      .filter(Boolean)
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")))
      .at(-1) || null;
    const enrichedObject = {
      ...object,
      planningImpact: buildCatalogPlanningImpact(this.database, this.getState(), object),
      catalogEvidenceAuditSummaries,
      ...(catalogAuditSummary ? { catalogAuditSummary } : {}),
    };
    const iconUrl = (candidate) => candidate ? { ...candidate, url: `/api/catalog/icon/${candidate.assetHash}` } : candidate;
    if (objectType === "item-identity") {
      const displayIcon = {
        ...object.displayIcon,
        candidates: (object.displayIcon?.candidates || []).map(iconUrl),
        selectedIcon: iconUrl(object.displayIcon?.selectedIcon),
      };
      return {
        ...enrichedObject,
        displayIcon,
        iconCandidates: displayIcon.candidates,
        selectedIcon: displayIcon.selectedIcon,
        iconSelectionHistory: displayIcon.history,
      };
    }
    if (objectType === "production-mode") {
      const mode = object.effectiveValue || object.algorithmCandidate || {};
      const producerItemId = String(mode.producerItemId || "");
      const modeId = String(mode.modeId || "");
      const executionMode = this.getSettings().mode;
      const distribution = producerItemId && modeId
        ? this.database.getProductionDistribution(producerItemId, modeId, { executionMode })
        : null;
      const itemIds = new Set([
        ...(distribution?.theoreticalDistribution?.outcomes || []).map((entry) => entry.itemId),
        ...(distribution?.observedDistribution?.outcomes || []).map((entry) => entry.itemId),
        ...(distribution?.planningDistribution?.outcomes || []).map((entry) => entry.itemId),
      ].map(String));
      const items = Object.fromEntries([...itemIds].map((itemId) => {
        const identity = this.database.getCatalogObject("item-identity", itemId);
        const value = identity?.effectiveValue || identity?.algorithmCandidate || {};
        const name = [value.name, value.displayName, value.title, value.description, value.descriptionKey]
          .find((candidate) => String(candidate || "").trim());
        const level = Number(value.level);
        return [itemId, {
          name: String(name || "未命名物品").trim(),
          level: Number.isInteger(level) && level > 0 ? level : null,
        }];
      }));
      return {
        ...enrichedObject,
        productionModeContext: {
          producerItemId,
          modeId,
          energyCost: Number(mode.energyCost),
          unlocked: mode.unlocked !== false,
          executionMode,
          distribution,
          items,
        },
      };
    }
    if (objectType === "production-profile") {
      const profile = object.effectiveValue || object.algorithmCandidate || {};
      const describeItem = (itemId) => {
        const identity = this.database.getCatalogObject("item-identity", String(itemId));
        const value = identity?.effectiveValue || identity?.algorithmCandidate || {};
        const name = [value.name, value.displayName, value.title, value.description, value.descriptionKey]
          .find((candidate) => String(candidate || "").trim());
        const level = Number(value.level);
        const selectedIcon = this.database.getSelectedIconCandidate(String(itemId));
        return {
          itemKey: String(itemId),
          name: String(name || "未命名物品").trim(),
          level: Number.isInteger(level) && level > 0 ? level : null,
          iconUrl: selectedIcon ? `/api/catalog/icon/${selectedIcon.assetHash}` : null,
          reviewStatus: identity?.reviewStatus || "clear",
        };
      };
      const productionModes = (profile.productionModes || []).map(String).map((modeId) => {
        const mode = this.database.getCatalogObject("production-mode", `${object.objectId}:${modeId}`);
        const value = mode?.effectiveValue || mode?.algorithmCandidate || {};
        return {
          modeKey: `${object.objectId}:${modeId}`,
          modeId,
          status: mode?.status || "observed",
          unlocked: value.unlocked !== false,
        };
      });
      return {
        ...enrichedObject,
        productionProfileContext: {
          producer: describeItem(profile.producerItemId || object.objectId),
          candidateOutputs: (profile.candidateOutputs || []).map(describeItem),
          productionModes,
        },
      };
    }
    if (objectType !== "merge-relation") return enrichedObject;
    const items = this.database.listCatalogObjects({ objectType: "item-identity" }).map((summary) => {
      const identity = this.database.getCatalogObject(summary.objectType, summary.objectId);
      const value = identity?.effectiveValue || identity?.algorithmCandidate || {};
      const name = [value.name, value.displayName, value.title, value.description, value.descriptionKey]
        .find((candidate) => String(candidate || "").trim());
      const level = Number(value.level);
      const selectedIcon = this.database.getSelectedIconCandidate(summary.objectId);
      return {
        objectId: summary.objectId,
        name: String(name || "未命名物品").trim(),
        level: Number.isInteger(level) && level > 0 ? level : null,
        chainId: value.chainId == null ? null : String(value.chainId),
        iconUrl: selectedIcon ? `/api/catalog/icon/${selectedIcon.assetHash}` : null,
        reviewStatus: identity?.reviewStatus || "clear",
      };
    });
    const relations = this.database.listCatalogObjects({ objectType: "merge-relation" }).map((summary) => {
      const relation = this.database.getCatalogObject(summary.objectType, summary.objectId);
      const value = relation?.effectiveValue || relation?.algorithmCandidate || {};
      return {
        objectId: summary.objectId,
        itemId: String(value.itemId ?? summary.objectId),
        requiredCount: Number(value.requiredCount ?? 2),
        mergeTarget: value.mergeTarget == null || value.mergeTarget === "" ? null : String(value.mergeTarget),
        reviewStatus: relation?.reviewStatus || "clear",
      };
    });
    return { ...enrichedObject, relationContext: { items, relations } };
  }

  async setCatalogObjectDisposition(objectType, objectId, disposition, reason, expectedRevision) {
    const changed = this.catalogGate.setObjectDisposition(objectType, objectId, disposition, reason, expectedRevision);
    let planningResult;
    try {
      planningResult = await this.replanAfterCatalogReview();
    } catch (error) {
      planningResult = {
        status: "failed",
        recovered: false,
        boundaryReason: "catalog-disposition-replan-failed",
        recommendedOrderSlot: null,
        error: error.message,
      };
    }
    const planningEligible = changed.disposition === "enabled"
      && (changed.status === "active" || (changed.status === "provisional" && this.getSettings().mode === "observation"));
    const object = {
      ...this.getCatalogObject(objectType, objectId),
      planningEligible,
      planningResult,
    };
    this.emit("catalog-state-updated", { object, planningEligible, planningResult });
    return object;
  }

  setCatalogEvidenceDisposition(objectType, objectId, evidenceId, disposition, reason, expectedRevision, audit = {}) {
    const changed = this.catalogGate.setEvidenceDisposition(objectType, objectId, evidenceId, disposition, reason, expectedRevision, audit);
    const object = {
      ...this.getCatalogObject(objectType, objectId),
      catalogAuditSummary: changed.catalogAuditSummary,
      catalogEvidenceAuditSummaries: changed.catalogEvidenceAuditSummaries,
    };
    this.emit("catalog-state-updated", { object });
    return object;
  }

  applyCatalogRuling(input) {
    return this.database.applyCatalogRuling(input);
  }

  async adaptLegacyCatalogRuling(input, options = {}) {
    const committed = this.database.adaptLegacyCatalogRuling(input, options);
    return this.completeCatalogReview({
      objectType: committed.objectType,
      objectId: committed.objectId,
      decision: committed.reviewResolution.decision,
      snapshot: committed.reviewResolution.snapshot,
      actor: input.actor,
      note: input.note,
      requestId: committed.reviewResolution.requestId,
      expectedRevision: Number(input.expectedRevision),
      compatibilitySource: committed.reviewResolution.compatibilitySource,
      compatibilityAction: committed.compatibilityAction,
    });
  }

  previewCatalogReview(input) {
    const preview = this.database.previewCatalogReview(input);
    const current = this.getCatalogObject(preview.objectType, preview.objectId);
    const previewObject = {
      ...current,
      effectiveValue: structuredClone(preview.snapshot),
      algorithmCandidate: structuredClone(preview.snapshot),
    };
    const planningImpact = buildCatalogPlanningImpact(this.database, this.getState(), previewObject);
    return {
      ...preview,
      planningImpact: {
        ...planningImpact,
        summary: planningImpact.orders.length || planningImpact.relations.length
          ? `该快照关联 ${planningImpact.orders.length} 个当前订单和 ${planningImpact.relations.length} 条合成关系；保存后会立即重新规划。`
          : "当前没有直接关联的订单或合成关系；保存后仍会立即重新规划。",
      },
    };
  }

  async completeCatalogReview(input) {
    let committed;
    try {
      committed = this.database.completeCatalogReview(input);
    } catch (error) {
      if (error?.code === "CATALOG_REVISION_CONFLICT") {
        const currentObject = this.getCatalogObject(input.objectType, input.objectId);
        const currentSnapshot = currentObject?.effectiveValue || currentObject?.algorithmCandidate || {};
        error.currentObject = currentObject;
        error.meaningfulDifferences = meaningfulSnapshotDifferences(currentSnapshot, input.snapshot || {});
      }
      throw error;
    }
    const priorPlanning = committed.reviewResolution?.planningResult;
    if (committed.idempotentReplay && priorPlanning?.status !== "pending") return committed;
    let planningResult;
    try {
      const replanned = this.replanner
        ? await this.replanner({ object: committed, input })
        : await this.replanAfterCatalogReview();
      const blockingReviewTarget = replanned?.blockingReviewTarget || null;
      planningResult = {
        status: replanned?.status || (replanned?.recovered ? "ready" : "waiting"),
        recovered: replanned?.recovered ?? replanned?.status === "ready",
        boundaryReason: replanned?.boundaryReason ?? null,
        recommendedOrderSlot: replanned?.recommendedOrderSlot ?? replanned?.recommended?.slot ?? null,
        ...(blockingReviewTarget ? { blockingReviewTarget } : {}),
      };
    } catch (error) {
      planningResult = {
        status: "failed",
        recovered: false,
        boundaryReason: "catalog-review-replan-failed",
        recommendedOrderSlot: null,
        error: error?.message || String(error),
      };
    }
    return this.database.finalizeCatalogReviewPlanning(committed.reviewResolution?.requestId || input.requestId, planningResult);
  }

  async replanAfterCatalogReview() {
    const settings = this.getSettings();
    const plan = buildOptimizationPlan({
      catalog: this.getPlanningCatalog({ includeProvisional: settings.mode === "observation", executionMode: settings.mode }),
      state: this.getState(),
      strategy: settings.strategy,
      prioritySlot: settings.prioritySlot,
      salePolicy: settings.salePolicy,
      executionMode: settings.mode,
    });
    this.publishPlan(plan);
    const blockingReviewTarget = plan.evidenceBlocks
      ?.flatMap((block) => block.blockers || [])
      .map((blocker) => blocker.reviewTarget)
      .find(Boolean) || null;
    return {
      status: plan.status,
      recovered: plan.status === "ready",
      boundaryReason: plan.boundaryReason,
      recommendedOrderSlot: plan.recommended?.slot ?? null,
      blockingReviewTarget,
    };
  }

  revokeCatalogRuling(input) {
    return this.database.revokeCatalogRuling(input);
  }
}

module.exports = { CatalogReviewOperator };
