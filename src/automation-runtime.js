"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { ZipArchive } = require("archiver");
const { AdapterLab } = require("./lab");
const { getConfig } = require("./config");
const { buildGameState } = require("./game-state");
const { buildOptimizationPlan } = require("./order-optimizer");
const { OrderCoinLoop } = require("./order-coin-loop");
const { FullAutomationLoop } = require("./full-automation-loop");
const { AutomationDatabase } = require("./automation-database");
const { ConnectionService } = require("./connection-service");
const { buildCatalog } = require("../scripts/build-item-catalog.cjs");
const { migrateLegacyCatalog } = require("./catalog-migration");
const { CatalogReviewGate, buildPlanningCatalogFromRepository } = require("./catalog-review-gate");
const { PauseGate } = require("./pause-gate");
const { normalizeSalePolicy } = require("./sale-policy");
const { IdleAutomationSession } = require("./idle-automation-session");
const { IconEvidenceService, resolveCocosSpriteFrame, resolveScreenshotTarget, captureCdpScreenshot, readCdpResource } = require("./icon-evidence");
const { buildCatalogEvidenceIndex, collectPassiveCatalogEvidence } = require("./catalog-evidence");
const { ActiveCatalogScanner, MAX_ACTIVE_CATALOG_SCAN_TARGETS, READ_CATALOG_SCAN_SELECTION_EXPRESSION, buildActiveCatalogInspectExpression, buildRestoreCatalogSelectionExpression } = require("./catalog-scan");
const { unknownWarehouseInventoryKnowledge } = require("./warehouse-domain");
const { CdpRuntimeControlAdapter, LegacyRuntimeControlAdapter } = require("./runtime-control-bridge");
const { mergeRelationWaitingForObservation } = require("./catalog-review-state");

function buildOptimizationPlanInWorker(input, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "planning-worker.js"), { workerData: input });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const fail = (message, code) => {
      const error = new Error(message);
      error.code = code;
      if (code === "ABORT_ERR") error.name = "AbortError";
      worker.terminate().catch(() => {});
      finish(reject, error);
    };
    const onAbort = () => fail("planning aborted", "ABORT_ERR");
    worker.once("message", (message) => {
      if (!message?.ok) return fail(message?.error || "planning worker failed", "PLANNING_WORKER_ERROR");
      finish(resolve, message.plan);
    });
    worker.once("error", (error) => finish(reject, error));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) fail(`planning worker exited with code ${code}`, "PLANNING_WORKER_EXIT");
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mergeCatalogs(base, update) {
  const mergeBy = (left, right, keyOf) => [...new Map([...(left || []), ...(right || [])].map((item) => [String(keyOf(item)), item])).values()];
  const chains = mergeBy(base.chains, update.chains, (item) => item.id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const items = mergeBy(base.items, update.items, (item) => item.id).sort((a, b) => String(a.chainId).localeCompare(String(b.chainId)) || Number(a.level) - Number(b.level));
  const producers = mergeBy(base.producers, update.producers, (item) => item.itemId).sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));
  return {
    ...base,
    generatedAt: new Date().toISOString(),
    rules: update.rules || base.rules,
    coverage: { completeChains: chains.filter((chain) => chain.complete).map((chain) => chain.id), incompleteChains: chains.filter((chain) => !chain.complete).map((chain) => chain.id), producerConfigurations: producers.length },
    chains, items, producers,
  };
}

function waitForPromiseOrAbort(promise, signal = null) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error("operation aborted"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(Object.assign(new Error("operation aborted"), { name: "AbortError" })); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function buildAutomationErrorDetails(error) {
  return {
    message: error?.message || String(error),
    code: error?.code == null ? null : String(error.code),
  };
}

function passiveCatalogStateFingerprint(state) {
  if (!state) return null;
  const items = [];
  for (const grid of state.board?.grids || []) items.push(["board", String(grid.itemId || ""), Number(grid.level) || null]);
  for (const order of state.orders || []) for (const item of order.items || []) items.push(["order", String(item.itemId || ""), Number(item.level) || null]);
  items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const producers = (state.producers || []).map((producer) => ({
    index: producer.index,
    itemId: String(producer.itemId || ""),
    energyCost: producer.energyCost ?? null,
    currentProductionModeId: producer.currentProductionModeId ?? null,
    productionModeSwitchEntry: producer.productionModeSwitchEntry || null,
    availableProductionModes: producer.availableProductionModes || [],
  })).sort((left, right) => String(left.itemId).localeCompare(String(right.itemId)) || Number(left.index) - Number(right.index));
  return crypto.createHash("sha256").update(JSON.stringify({ items, producers })).digest("hex");
}

function reconcileBoardObservation(state, observed, action = null) {
  const next = structuredClone(state);
  next.collectedAt = new Date().toISOString();
  next.scene = "board";
  next.board = {
    ...(next.board || {}),
    available: !!observed?.ok,
    visible: !!observed?.boardVisible,
    width: observed?.width ?? next.board?.width ?? null,
    height: observed?.height ?? next.board?.height ?? null,
    occupied: Number(observed?.occupied ?? next.board?.occupied ?? 0),
    empty: Number(observed?.empty ?? next.board?.empty ?? 0),
    signature: observed?.signature ?? next.board?.signature ?? "",
    grids: (observed?.grids || []).map((grid) => ({ ...grid, itemId: String(grid.itemId || "") })),
    mergeCandidates: (observed?.mergeCandidates || []).map((candidate) => ({ ...candidate })),
    requiredItemCounts: { ...(observed?.requiredItemCounts || {}) },
  };
  next.orders = (observed?.orders || []).map((order) => {
    const items = (order.items || []).map((item) => ({ itemId: String(item.itemId || ""), complete: !!item.complete, status: item.status ?? null }));
    return { ...order, slot: String(order.slot || ""), items, requiredItemIds: items.map((item) => item.itemId).filter(Boolean), missingItemIds: items.filter((item) => !item.complete).map((item) => item.itemId).filter(Boolean), ready: items.length > 0 && items.every((item) => item.complete) };
  });
  next.producers = (observed?.producers || []).map((producer) => ({ ...producer, itemId: String(producer.itemId || "") }));
  if (action?.type === "produce" && action.verified !== false) {
    const producer = (state.producers || []).find((item) => Number(item.index) === Number(action.producer));
    const energyCost = Number(producer?.energyCost);
    if (Number.isFinite(energyCost) && Number.isFinite(Number(next.resources?.energy))) {
      next.resources.energy = Math.max(0, Number(next.resources.energy) - energyCost);
      if (next.energy) next.energy.amount = next.resources.energy;
    }
  }
  return next;
}

class AutomationRuntime {
  constructor({ rootDir = path.resolve(__dirname, ".."), dataDir = null, url = null, onEvent = null, manageConnectionRoute = true, runtimeControl = null } = {}) {
    this.rootDir = rootDir;
    this.url = url;
    this.onEvent = onEvent;
    this.manageConnectionRoute = manageConnectionRoute !== false;
    this.connectionAutoStartEnabled = this.manageConnectionRoute;
    this.lab = null;
    this.selection = null;
    this.runtimeControl = runtimeControl;
    this.runtimeControlInjected = runtimeControl != null;
    this.connectPromise = null;
    this.connectController = null;
    this.lastState = buildGameState();
    this.lastPlan = null;
    this.planningCatalogCache = new Map();
    this.catalogProjectionCache = new Map();
    this.catalogViewCache = new Map();
    this.iconEvidenceRetryAt = new Map();
    this.running = false;
    this.abortController = null;
    this.pauseGate = new PauseGate();
    this.activeSessionId = null;
    this.activeRunPromise = null;
    this.idleSession = null;
    this.sessionKind = null;
    this.actionBoundaryPending = false;
    this.passiveCatalogState = null;
    this.deferredPassiveCatalogState = null;
    this.deferredPassiveCatalogDiffs = [];
    this.lastPassiveCatalogStateFingerprint = null;
    this.passiveCatalogDiffs = [];
    this.passiveCatalogDrainPromise = null;
    this.closing = false;
    this.warehouseInventoryKnowledgeInvalidated = false;
    this.warehouseInventoryInvalidationReason = null;
    this.buildCatalog = buildCatalog;
    this.dataDir = dataDir || path.join(rootDir, "data");
    fs.mkdirSync(this.dataDir, { recursive: true });
    try {
      this.database = new AutomationDatabase(path.join(this.dataDir, "automation.db"));
    } catch (error) {
      const unavailable = new Error(`catalog database unavailable: ${error.message}`, { cause: error });
      unavailable.code = "CATALOG_DATABASE_UNAVAILABLE";
      unavailable.statusCode = 500;
      throw unavailable;
    }
    this.connectionService = new ConnectionService({ rootDir, dataDir: this.dataDir, onEvent: (event) => this.emit("connection-route", event) });
    const bundledCatalogPath = path.join(rootDir, "captures", "item-catalog.json");
    const persistedCatalogPath = path.join(this.dataDir, "item-catalog.json");
    this.legacyCatalogPath = fs.existsSync(persistedCatalogPath) ? persistedCatalogPath : bundledCatalogPath;
    if (!this.database.getSetting("catalog-system-of-record-migration")) {
      try {
        const sourceBytes = fs.readFileSync(this.legacyCatalogPath);
        const legacyCatalog = JSON.parse(sourceBytes.toString("utf8"));
        const repositoryEmpty = this.database.getCatalogRepositorySummary().objects === 0;
        this.database.transaction(() => {
          migrateLegacyCatalog(this.database, legacyCatalog, {
            sourceFile: this.legacyCatalogPath,
            historicActions: this.database.listAttributableProductionActions(),
            recordSourceEvidence: this.legacyCatalogPath === bundledCatalogPath || repositoryEmpty,
          });
          if (this.database.getCatalogRepositorySummary().objects === 0) {
            const empty = new Error("catalog repository is empty after migration");
            empty.code = "CATALOG_REPOSITORY_EMPTY";
            throw empty;
          }
          this.database.setSetting("catalog-system-of-record-migration", {
            schemaVersion: 1,
            sourceFile: this.legacyCatalogPath,
            sourceSha256: crypto.createHash("sha256").update(sourceBytes).digest("hex"),
            migratedAt: new Date().toISOString(),
          });
        });
      } catch (error) {
        this.database.close();
        const migration = new Error(`catalog migration failed: ${error.message}`, { cause: error });
        migration.code = error.code || "CATALOG_MIGRATION_FAILED";
        migration.statusCode = 500;
        throw migration;
      }
    }
    if (this.database.getCatalogRepositorySummary().objects === 0) {
      this.database.close();
      const empty = new Error("catalog repository is empty after migration");
      empty.code = "CATALOG_REPOSITORY_EMPTY";
      empty.statusCode = 500;
      throw empty;
    }
    this.catalogGate = new CatalogReviewGate(this.database);
    for (const conflict of this.database.listCatalogConflicts()) {
      this.catalogGate.evaluateObject(conflict.objectType, conflict.objectId);
    }
    this.database.invalidateAutomaticIconSelections((candidate) => {
      if (candidate.sourceType === "screenshot-runtime") {
        return candidate.crop?.backgroundRemoval?.applied === true
          && candidate.similarity?.qualityGate?.status === "eligible";
      }
      if (candidate.sourceType !== "cocos-runtime-resource"
        || !/^(?:icon|item[_-]?icon)$/i.test(String(candidate.runtimeIdentifier || ""))) return true;
      const identity = this.database.getCatalogObject("item-identity", candidate.itemId);
      const resourceIdentifier = identity?.effectiveValue?.iconResourceIdentifier
        ?? identity?.effectiveValue?.iconResource;
      const resourceName = String(resourceIdentifier || "").split(/[\\/]/).filter(Boolean).at(-1);
      return !resourceName || /^(?:icon|item[_-]?icon)$/i.test(resourceName);
    }, { reason: "automatic-icon-quality-gate" });
    this.iconService = new IconEvidenceService({
      database: this.database,
      cacheDir: path.join(this.dataDir, "icon-cache"),
      concurrency: 2,
      resolveSpriteFrame: async ({ itemId, itemIdentity, signal }) => {
        const selection = await this.connect(signal);
        return resolveCocosSpriteFrame({ client: this.lab.client, contextId: selection.probe.context.id, itemId, itemIdentity, signal });
      },
      readResource: async ({ resourceUrl, mimeType, signal }) => {
        await this.connect(signal);
        return readCdpResource({ client: this.lab.client, resourceUrl, mimeType, signal });
      },
      resolveScreenshotBounds: async ({ itemId, itemIdentity, signal }) => {
        const selection = await this.connect(signal);
        return resolveScreenshotTarget({ client: this.lab.client, contextId: selection.probe.context.id, itemId, itemIdentity, signal });
      },
      captureScreenshot: async ({ signal }) => {
        await this.connect(signal);
        return captureCdpScreenshot({ client: this.lab.client, signal });
      },
      isSafeBoundary: () => !this.running && !this.actionBoundaryPending,
      onEvent: (event) => {
        const itemId = String(event.itemId || "");
        if (event.type === "icon-acquisition-complete") {
          const rejected = event.candidate?.sourceType === "screenshot-runtime" && event.candidate?.similarity?.qualityGate?.status === "rejected";
          if (rejected) this.iconEvidenceRetryAt.set(itemId, Date.now() + 300_000);
          else this.iconEvidenceRetryAt.delete(itemId);
        } else if (event.type === "icon-acquisition-error") {
          this.iconEvidenceRetryAt.set(itemId, Date.now() + 60_000);
        }
        this.emit(event.type, event);
      },
    });
  }

  emit(type, payload = {}) { this.onEvent?.({ type, at: new Date().toISOString(), ...payload }); }

  ensureRuntimeControl() {
    if (this.runtimeControl) return this.runtimeControl;
    if (!this.lab || !this.selection?.probe) {
      throw Object.assign(new Error("runtime control is not connected"), { code: "RUNTIME_CONTROL_NOT_CONNECTED" });
    }
    const legacy = new LegacyRuntimeControlAdapter({
      lab: this.lab,
      selection: this.selection,
      collectState: (signal) => this.collectState(signal),
      onWarehouseInventoryInvalidated: (reason) => this.invalidateWarehouseInventoryKnowledge(reason),
    });
    if (typeof this.lab.client?.evaluate !== "function") {
      this.runtimeControl = legacy;
      return this.runtimeControl;
    }
    this.runtimeControl = new CdpRuntimeControlAdapter({
      client: this.lab.client,
      contextId: this.selection.probe.context.id,
      legacy,
    });
    return this.runtimeControl;
  }

  async reconcileRuntimeControlForMutation(checkpoint, signal = null) {
    const runtimeControl = this.ensureRuntimeControl();
    if (typeof runtimeControl.reconcileForMutation !== "function") {
      return { reconciled: false, reason: "runtime-control-reconciliation-unavailable" };
    }
    try {
      return await runtimeControl.reconcileForMutation(checkpoint, signal);
    } catch (error) {
      if (error?.code !== "RUNTIME_CONTROL_CONTEXT_CHANGED" || this.runtimeControlInjected) throw error;
      const failedLab = this.lab;
      this.selection = null;
      this.lab = null;
      this.runtimeControl = null;
      await failedLab?.close().catch(() => {});
      this.emit("connection", { connected: false, reason: "execution-context-changed" });
      throw error;
    }
  }

  getCatalogView({ includeRepositoryObjects = true } = {}) {
    const executionMode = this.getSettings().mode;
    const revision = includeRepositoryObjects ? this.database.getCatalogUiRevision() : this.database.getCatalogPresentationRevision();
    const cacheKey = `${revision}:${executionMode}:${includeRepositoryObjects ? "full" : "summary"}`;
    const cached = this.catalogViewCache.get(cacheKey);
    if (cached) return cached;
    const semanticRevision = this.database.getCatalogSemanticRevision();
    const projectionKey = `${semanticRevision}:${executionMode}:provisional`;
    let projection = this.catalogProjectionCache.get(projectionKey);
    if (!projection) {
      projection = this.database.getCatalogProjection({ includeProvisional: true, executionMode });
      this.catalogProjectionCache.clear();
      this.catalogProjectionCache.set(projectionKey, projection);
    }
    const selectedIconHashes = this.database.getSelectedIconHashes();
    const iconUrls = Object.fromEntries(Object.entries(selectedIconHashes).map(([itemId, hash]) => [itemId, `/api/catalog/icon/${hash}`]));
    const repository = { summary: this.database.getCatalogRepositorySummary() };
    if (includeRepositoryObjects) {
      repository.objects = this.database.listCatalogObjects();
      repository.conflicts = this.database.listCatalogConflicts();
      repository.reviewQueue = this.database.getCatalogReviewQueue().map((entry) => {
        if (entry.objectType !== "merge-relation") return entry;
        const relation = this.database.getCatalogObject(entry.objectType, entry.objectId);
        const candidate = relation?.algorithmCandidate || relation?.effectiveValue || {};
        const target = candidate.mergeTarget == null ? null : this.database.getCatalogObject("item-identity", candidate.mergeTarget);
        const waiting = mergeRelationWaitingForObservation({ relationCandidate: candidate, relationEvidence: relation?.evidence || [], targetIdentity: target });
        return waiting.waiting ? { ...entry, actionStatus: "等待更多线索", waitingForMoreClues: waiting } : entry;
      });
      repository.laterQueue = this.database.getCatalogCompletenessQueue();
      repository.productionDistributionReviews = this.database.listProductionDistributionReviewEvents();
      repository.uncertainProductionActions = this.database.listUncertainProductionActions();
    }
    const result = {
      revision: projection.revision,
      stats: projection.stats,
      coverage: projection.coverage,
      chains: projection.chains,
      items: projection.items.map((item) => {
        const iconHash = selectedIconHashes[String(item.id)] || item.iconHash;
        return { ...item, iconHash: iconHash || null, iconUrl: iconHash ? `/api/catalog/icon/${iconHash}` : null };
      }),
      iconUrls,
      producers: projection.producers,
      repository,
    };
    for (const key of this.catalogViewCache.keys()) if (!key.startsWith(`${revision}:`)) this.catalogViewCache.delete(key);
    this.catalogViewCache.set(cacheKey, result);
    return result;
  }

  getCatalogObject(objectType, objectId) {
    const object = this.database.getCatalogObject(objectType, objectId);
    if (!object) return object;
    const iconUrl = (candidate) => candidate ? { ...candidate, url: `/api/catalog/icon/${candidate.assetHash}` } : candidate;
    if (objectType === "item-identity") {
      return { ...object, iconCandidates: (object.iconCandidates || []).map(iconUrl), selectedIcon: iconUrl(object.selectedIcon) };
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
        ...object,
        productionProfileContext: {
          producer: describeItem(profile.producerItemId || object.objectId),
          candidateOutputs: (profile.candidateOutputs || []).map(describeItem),
          productionModes,
        },
      };
    }
    if (objectType !== "merge-relation") return object;
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
    return { ...object, relationContext: { items, relations } };
  }

  getPlanningCatalog({ includeProvisional = false, executionMode = "assisted" } = {}) {
    const revision = this.database.getCatalogSemanticRevision();
    const key = `${revision}:${includeProvisional ? "provisional" : "active"}:${executionMode}`;
    const cached = this.planningCatalogCache.get(key);
    if (cached) return cached;
    const catalog = buildPlanningCatalogFromRepository(this.database, null, { includeProvisional, executionMode });
    const result = { ...catalog, evidence: buildCatalogEvidenceIndex(this.database) };
    for (const cachedKey of this.planningCatalogCache.keys()) if (!cachedKey.startsWith(`${revision}:`)) this.planningCatalogCache.delete(cachedKey);
    this.planningCatalogCache.set(key, result);
    return result;
  }

  exportCatalog() {
    return this.database.exportCatalogSnapshot();
  }

  importCatalog(snapshot, options = {}) {
    if (snapshot?.source?.type === "sqlite-catalog-repository") return this.database.importCatalogSnapshot(snapshot, options);
    const result = migrateLegacyCatalog(this.database, snapshot, {
      sourceFile: options.sourceFile || "json-import",
      historicActions: [],
      recordSourceEvidence: true,
    });
    return { imported: result.migrated, preserved: 0, revision: this.database.getCatalogRevision(), repository: result.repository };
  }

  acquireCatalogIcon(itemId) {
    if (this.running || this.actionBoundaryPending) throw Object.assign(new Error("icon acquisition requires an automation safe boundary"), { code: "ICON_ACQUISITION_UNSAFE_BOUNDARY", statusCode: 409 });
    const object = this.database.getCatalogObject("item-identity", String(itemId));
    if (!object) throw Object.assign(new Error(`catalog object not found: item-identity/${itemId}`), { statusCode: 404 });
    this.iconEvidenceRetryAt.delete(String(itemId));
    return this.iconService.request(String(itemId), { itemIdentity: { itemId: String(itemId), ...(object.effectiveValue || object.algorithmCandidate || {}) } });
  }

  queueVisibleBoardIconEvidence(state) {
    if (this.closing || this.running || this.actionBoundaryPending) return [];
    const queued = [];
    const itemIds = [...new Set((state?.board?.grids || []).map((grid) => String(grid.itemId || "")).filter(Boolean))];
    for (const itemId of itemIds) {
      if (this.database.getSelectedIconCandidate(itemId)) continue;
      if (Number(this.iconEvidenceRetryAt.get(itemId) || 0) > Date.now()) continue;
      const object = this.database.getCatalogObject("item-identity", itemId);
      if (!object) continue;
      try {
        queued.push(this.iconService.request(itemId, { itemIdentity: { itemId, ...(object.effectiveValue || object.algorithmCandidate || {}) } }));
        if (queued.length >= 2) break;
      } catch (error) {
        if (error?.code === "ICON_ACQUISITION_QUEUE_FULL") break;
        this.emit("icon-acquisition-error", { itemId, error: error.message });
      }
    }
    return queued;
  }

  getCatalogIconTask(taskId) {
    return this.iconService.getTask(taskId);
  }

  getCatalogIconAsset(hash) {
    return this.database.getIconAsset(hash);
  }

  selectCatalogIcon(itemId, candidateId, input) {
    const object = this.database.selectIconCandidate(String(itemId), Number(candidateId), input);
    this.emit("catalog-review-updated", { objectType: object.objectType, objectId: object.objectId, revision: object.revision, reviewStatus: object.reviewStatus });
    return this.getCatalogObject("item-identity", String(itemId));
  }

  revokeCatalogIconSelection(itemId, input) {
    const object = this.database.revokeIconSelection(String(itemId), input);
    this.emit("catalog-review-updated", { objectType: object.objectType, objectId: object.objectId, revision: object.revision, reviewStatus: object.reviewStatus });
    return this.getCatalogObject("item-identity", String(itemId));
  }

  async uploadCatalogIcon(itemId, { dataBase64, mimeType, actor, note, expectedRevision }) {
    if (this.running || this.actionBoundaryPending) throw Object.assign(new Error("icon upload requires an automation safe boundary"), { code: "ICON_ACQUISITION_UNSAFE_BOUNDARY", statusCode: 409 });
    this.actionBoundaryPending = true;
    try {
      const object = this.database.getCatalogObject("item-identity", String(itemId));
      if (!object) throw Object.assign(new Error(`catalog object not found: item-identity/${itemId}`), { statusCode: 404 });
      if (!String(actor || "").trim() || !String(note || "").trim()) throw Object.assign(new Error("icon upload actor and note are required"), { statusCode: 400 });
      this.database.assertCatalogObjectRevision("item-identity", String(itemId), expectedRevision);
      if (!/^image\/(png|jpeg)$/i.test(String(mimeType || ""))) throw Object.assign(new Error("uploaded icon must be PNG or JPEG"), { statusCode: 415 });
      const body = Buffer.from(String(dataBase64 || "").replace(/^data:[^,]+,/, ""), "base64");
      if (!body.length || body.length > 8 * 1024 * 1024) throw Object.assign(new Error("uploaded icon is empty or too large"), { statusCode: 413 });
      const asset = await this.iconService.processImage({ resourceBody: body, metadata: { mimeType }, cacheDir: this.iconService.cacheDir });
      this.database.assertCatalogObjectRevision("item-identity", String(itemId), expectedRevision);
      const cacheKey = crypto.createHash("sha256").update(`user-upload:${asset.hash}`).digest("hex");
      const candidate = this.database.saveIconCandidate({ itemId: String(itemId), cacheKey, sourceType: "user-upload", crop: { provider: "user-upload" }, rankScore: 0, autoSelect: false, asset });
      const selected = this.database.selectIconCandidate(String(itemId), candidate.id, { actor, note, expectedRevision: this.database.getCatalogObject("item-identity", String(itemId)).revision });
      this.emit("catalog-review-updated", { objectType: selected.objectType, objectId: selected.objectId, revision: selected.revision, reviewStatus: selected.reviewStatus });
      return this.getCatalogObject("item-identity", String(itemId));
    } finally {
      this.actionBoundaryPending = false;
    }
  }

  setCatalogObjectDisposition(objectType, objectId, disposition, reason, expectedRevision) {
    const object = this.catalogGate.setObjectDisposition(objectType, objectId, disposition, reason, expectedRevision);
    this.emit("catalog-state-updated", { object });
    return object;
  }

  setCatalogEvidenceDisposition(objectType, objectId, evidenceId, disposition, reason, expectedRevision) {
    const object = this.catalogGate.setEvidenceDisposition(objectType, objectId, evidenceId, disposition, reason, expectedRevision);
    this.emit("catalog-state-updated", { object });
    return object;
  }

  applyCatalogRuling(input) {
    return this.database.applyCatalogRuling(input);
  }

  async completeCatalogReview(input) {
    const committed = this.database.completeCatalogReview(input);
    const priorPlanning = committed.reviewResolution?.planningResult;
    if (committed.idempotentReplay && priorPlanning?.status !== "pending") return committed;
    let planningResult;
    try {
      const replanned = this.catalogReviewReplanner
        ? await this.catalogReviewReplanner({ object: committed, input })
        : await this._replanAfterCatalogReview();
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

  async _replanAfterCatalogReview() {
    const settings = this.getSettings();
    const plan = buildOptimizationPlan({
      catalog: this.getPlanningCatalog({ includeProvisional: settings.mode === "observation", executionMode: settings.mode }),
      state: this.lastState,
      strategy: settings.strategy,
      prioritySlot: settings.prioritySlot,
      salePolicy: settings.salePolicy,
      executionMode: settings.mode,
    });
    this.lastPlan = plan;
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

  async captureCatalogFromRuntime(capturePrefix = "catalog-rescan") {
    const selection = await this.connect();
    const snapshot = await this.lab.snapshot(selection);
    const captureDir = path.join(this.dataDir, "catalog-captures");
    await fsp.mkdir(captureDir, { recursive: true });
    const captureFile = `${capturePrefix}-${Date.now()}.json`;
    snapshot.__captureFile = captureFile;
    await fsp.writeFile(path.join(captureDir, captureFile), JSON.stringify(snapshot, null, 2), "utf8");
    const selectedItem = snapshot.focusedControllers?.selectedItem;
    const selectedItemUi = snapshot.gameplayState?.selectedItemUi;
    if (!selectedItem && selectedItemUi?.selected !== true) {
      return { ok: false, reason: "catalog-scan-selection-required", captureFile };
    }
    const scanned = this.buildCatalog([snapshot]);
    if (!scanned.chains.length) return { ok: false, reason: "selected-item-chain-data-not-found", captureFile };
    return { ok: true, captureFile, capturePath: path.join(captureDir, captureFile), scanned };
  }

  commitCatalogCaptures(captures, { evaluate = true } = {}) {
    const observedObjectIds = [...new Set(captures.flatMap(({ scanned }) => [...(scanned.items || []).map((item) => String(item.id)), ...(scanned.producers || []).map((producer) => String(producer.itemId))]))];
    this.database.transaction(() => {
      for (const capture of captures) this.database.importCatalog(capture.scanned, { sourceFile: capture.capturePath, sourceType: "runtime-capture" });
      if (evaluate) {
        const gateResults = this.catalogGate.evaluateAll({ objectIds: observedObjectIds });
        for (const object of gateResults) this.emit("catalog-state-updated", { object });
      }
    });
    return observedObjectIds;
  }

  async refreshCatalogFromRuntime({ evaluate = true, capturePrefix = "catalog-rescan" } = {}) {
    const capture = await this.captureCatalogFromRuntime(capturePrefix);
    if (!capture.ok) return capture;
    const observedObjectIds = this.commitCatalogCaptures([capture], { evaluate });
    return { ok: true, reason: "catalog-refreshed", captureFile: capture.captureFile, observedObjectIds, catalogView: this.getCatalogView() };
  }

  async runActiveCatalogScan({ itemIds = [] } = {}) {
    if (this.actionBoundaryPending) throw Object.assign(new Error("another safe-boundary task is running"), { code: "ACTIVE_CATALOG_SCAN_UNSAFE_BOUNDARY", statusCode: 409 });
    if (this.running && !this.pauseGate.paused) throw Object.assign(new Error("active catalog scan requires paused or stopped automation"), { code: "ACTIVE_CATALOG_SCAN_UNSAFE_BOUNDARY", statusCode: 409 });
    this.actionBoundaryPending = true;
    try {
      if (this.running) await this.pauseGate.waitForBoundary();
      await this.iconService.waitForIdle();
      const selection = await this.connect();
      const before = await this.collectState();
      if (before.scene !== "board") return { ok: false, reason: "active-catalog-scan-board-scene-required", before };
      const currentPlan = buildOptimizationPlan({ catalog: this.getPlanningCatalog(), state: before });
      const requested = (itemIds.length ? itemIds.map(String) : currentPlan.evidenceBlocks.flatMap((block) => block.blockers.map((blocker) => blocker.scanAction?.itemId).filter(Boolean))).slice(0, MAX_ACTIVE_CATALOG_SCAN_TARGETS);
      const targets = [...new Set(requested)].filter((itemId) => before.board.grids.some((grid) => String(grid.itemId) === itemId));
      if (!targets.length) return { ok: false, reason: "active-catalog-scan-target-not-on-board", evidenceBlocks: currentPlan.evidenceBlocks };
      const contextId = selection.probe.context.id;
      const selectedIndex = await this.lab.client.evaluate(READ_CATALOG_SCAN_SELECTION_EXPRESSION, contextId);
      const selectedGrid = selectedIndex == null ? null : before.board.grids.find((grid) => Number(grid.index) === Number(selectedIndex));
      if (selectedGrid && (Number(selectedGrid.produceCount || 0) > 0 || Number(selectedGrid.energyCost || 0) > 0)) return { ok: false, reason: "active-catalog-scan-initial-selection-unsafe", selectedIndex };
      const scanner = new ActiveCatalogScanner({
        collectState: () => this.collectState(),
        readSelection: () => this.lab.client.evaluate(READ_CATALOG_SCAN_SELECTION_EXPRESSION, contextId),
        inspectItem: async (itemId) => {
          const grid = before.board.grids.find((candidate) => String(candidate.itemId) === String(itemId));
          if (!grid) return null;
          const inspected = await this.lab.client.evaluate(buildActiveCatalogInspectExpression(grid.index), contextId);
          if (!inspected?.ok) return null;
          await new Promise((resolve) => setTimeout(resolve, this.getSettings().settleMs));
          return { itemId: String(itemId), gridIndex: grid.index, inspected };
        },
        restoreSelection: (selectedIndex) => this.lab.client.evaluate(buildRestoreCatalogSelectionExpression(selectedIndex), contextId),
        collectEvidence: async (capture) => {
          const staged = await this.captureCatalogFromRuntime(`active-catalog-scan-${capture.itemId}`);
          capture.captureFile = staged.captureFile;
          return staged.ok ? staged : null;
        },
        commitEvidence: (captures) => this.commitCatalogCaptures(captures, { evaluate: false }),
        reevaluate: async (observedObjectIds) => {
          const results = this.catalogGate.evaluateAll({ objectIds: observedObjectIds });
          for (const object of results) this.emit("catalog-state-updated", { object });
        },
        replan: async () => buildOptimizationPlan({ catalog: this.getPlanningCatalog(), state: await this.collectState() }),
      });
      const result = await scanner.run(targets, { before, initialSelection: selectedIndex });
      this.emit("active-catalog-scan-complete", { ...result, itemIds: targets });
      return result;
    } finally {
      this.actionBoundaryPending = false;
    }
  }

  connectionRouteStatus() { return this.connectionService.status(); }
  startConnectionRoute(options = {}) {
    this.connectionAutoStartEnabled = true;
    return this.connectionService.start(options);
  }
  ensureConnectionRoute(options = {}) {
    return this.connectionService.start(options).then((result) => {
      this.emit("connection-route-ready", { result });
      return result;
    });
  }
  async stopConnectionRoute() {
    this.connectionAutoStartEnabled = false;
    this.connectController?.abort();
    await this.lab?.close().catch(() => {});
    this.lab = null;
    this.selection = null;
    if (!this.runtimeControlInjected) this.runtimeControl = null;
    return this.connectionService.stop();
  }

  connect(signal = null) {
    if ((this.lab || this.runtimeControlInjected) && this.selection?.probe) return this.selection;
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("operation aborted"), { name: "AbortError" }));
    if (this.connectPromise) return waitForPromiseOrAbort(this.connectPromise, signal);
    const controller = new AbortController();
    this.connectController = controller;
    this.connectPromise = this.connectOnce(controller.signal).finally(() => {
      this.connectPromise = null;
      if (this.connectController === controller) this.connectController = null;
    });
    return waitForPromiseOrAbort(this.connectPromise, signal);
  }

  async connectOnce(signal = null) {
    if (this.runtimeControlInjected) {
      const readiness = await this.runtimeControl.ready(signal);
      const selection = {
        probe: { context: { id: readiness?.contextId ?? "runtime-control" } },
        adapter: { id: readiness?.adapterId || "runtime-control" },
        runtimeControl: readiness,
      };
      this.selection = selection;
      this.emit("connection", { connected: true, contextId: selection.probe.context.id, adapterId: selection.adapter.id });
      return selection;
    }
    const previous = this.lab;
    if (previous) {
      this.lab = null;
      this.selection = null;
      this.runtimeControl = null;
      await previous.close().catch(() => {});
    }
    const lab = new AdapterLab(getConfig({ url: this.url || undefined }));
    this.lab = lab;
    const probes = await lab.connectAndDiscover(signal);
    const selection = lab.select(probes);
    if (!selection.probe || selection.adapter?.id !== "target-game") {
      await lab.close();
      if (this.lab === lab) this.lab = null;
      throw new Error("未发现目标游戏运行上下文，请确认游戏和 CDP 路线已启动");
    }
    this.selection = selection;
    const runtimeControl = this.ensureRuntimeControl();
    selection.runtimeControl = await runtimeControl.ready(signal);
    lab.client.once("close", () => {
      if (this.lab !== lab) return;
      this.selection = null;
      this.lab = null;
      this.runtimeControl = null;
      this.emit("connection", { connected: false, reason: "cdp-websocket-closed" });
    });
    this.emit("connection", { connected: true, contextId: selection.probe.context.id });
    return selection;
  }

  async collectState(signal = null) {
    await this.connect(signal);
    const runtimeControl = this.ensureRuntimeControl();
    let state;
    try { state = await runtimeControl.readState(signal); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      if (!this.runtimeControlInjected) {
        const failedLab = this.lab;
        this.selection = null;
        this.lab = null;
        this.runtimeControl = null;
        await failedLab?.close().catch(() => {});
      }
      throw error;
    }
    if (this.warehouseInventoryKnowledgeInvalidated) {
      if (state.scene === "warehouse" && state.warehouse?.visible && state.warehouse?.inventoryKnowledge?.status === "loaded") {
        this.warehouseInventoryKnowledgeInvalidated = false;
        this.warehouseInventoryInvalidationReason = null;
      } else if (state.warehouse) {
        state.warehouse.inventoryKnowledge = unknownWarehouseInventoryKnowledge(this.warehouseInventoryInvalidationReason || "warehouse-inventory-invalidated");
      }
    }
    this.queuePassiveCatalogEvidence({ state });
    this.lastState = state;
    this.database.logResourceSample({ sessionId: this.activeSessionId, coins: state.resources.coins, energy: state.resources.energy, diamonds: state.resources.diamonds, scene: state.scene, observedAt: state.collectedAt });
    return state;
  }

  queuePassiveCatalogEvidence({ state = null, actionDiff = null } = {}) {
    if (this.closing) return;
    if (state) {
      const fingerprint = passiveCatalogStateFingerprint(state);
      if (this.running) this.deferredPassiveCatalogState = state;
      else if (fingerprint !== this.lastPassiveCatalogStateFingerprint) {
        this.lastPassiveCatalogStateFingerprint = fingerprint;
        this.passiveCatalogState = state;
      }
    }
    if (actionDiff) {
      const target = this.running ? this.deferredPassiveCatalogDiffs : this.passiveCatalogDiffs;
      target.push(actionDiff);
      if (target.length > 16) target.splice(0, target.length - 16);
    }
    if (!this.passiveCatalogState && !this.passiveCatalogDiffs.length) return;
    if (this.passiveCatalogDrainPromise) return;
    this.passiveCatalogDrainPromise = new Promise((resolve) => setImmediate(() => {
      const pendingState = this.passiveCatalogState;
      const pendingDiffs = this.passiveCatalogDiffs.splice(0);
      this.passiveCatalogState = null;
      try {
        const observed = new Set(collectPassiveCatalogEvidence(this.database, { state: pendingState }));
        for (const diff of pendingDiffs) for (const objectId of collectPassiveCatalogEvidence(this.database, { actionDiff: diff })) observed.add(objectId);
        const observedObjectIds = [...new Set([...observed].map((key) => key.slice(key.indexOf(":") + 1)).filter(Boolean))];
        if (observedObjectIds.length) {
          for (const object of this.catalogGate.evaluateAll({ objectIds: observedObjectIds })) this.emit("catalog-state-updated", { object });
        }
        if (observed.size) this.emit("catalog-passive-evidence", { objects: [...observed] });
      } catch (error) {
        this.emit("catalog-passive-evidence-error", { error: error.message });
      } finally {
        this.passiveCatalogDrainPromise = null;
        resolve();
        if (!this.closing && (this.passiveCatalogState || this.passiveCatalogDiffs.length)) this.queuePassiveCatalogEvidence();
      }
    }));
  }

  flushDeferredPassiveCatalogState() {
    const state = this.deferredPassiveCatalogState;
    const diffs = this.deferredPassiveCatalogDiffs.splice(0);
    this.deferredPassiveCatalogState = null;
    if (diffs.length) this.passiveCatalogDiffs.push(...diffs);
    if (state || diffs.length) this.queuePassiveCatalogEvidence({ state });
  }

  invalidateWarehouseInventoryKnowledge(reason) {
    this.warehouseInventoryKnowledgeInvalidated = true;
    this.warehouseInventoryInvalidationReason = String(reason || "warehouse-inventory-invalidated");
    this.emit("warehouse-inventory-invalidated", { reason: this.warehouseInventoryInvalidationReason });
  }

  async dashboard() {
    const settings = this.getSettings();
    let state = this.lastState;
    let connected = !!(this.lab && this.selection?.probe);
    let connectionError = null;
    if (!this.running || !state || !connected) {
      try {
        state = await this.collectState();
        connected = true;
      } catch (error) {
        connectionError = error?.message || String(error);
      }
    }
    const connectionRoute = await this.connectionService.status();
    if (this.connectionAutoStartEnabled && !connectionRoute.listening && !connectionRoute.starting) {
      this.ensureConnectionRoute().catch((error) => this.emit("connection-route-error", { error: error.message }));
    }
    if (connected) this.queueVisibleBoardIconEvidence(state);
    const planningCatalog = this.getPlanningCatalog({ includeProvisional: settings.mode === "observation", executionMode: settings.mode });
    const plan = this.running && this.lastPlan
      ? this.lastPlan
      : buildOptimizationPlan({ catalog: planningCatalog, state, strategy: settings.strategy, prioritySlot: settings.prioritySlot, salePolicy: settings.salePolicy, executionMode: settings.mode });
    this.lastPlan = plan;
    return {
      connected,
      connectionError,
      running: this.running,
      sessionKind: this.sessionKind,
      idle: this.sessionKind === "idle",
      paused: this.pauseGate.paused,
      state,
      plan,
      catalog: { revision: planningCatalog.revision, ...planningCatalog.stats },
      catalogView: this.getCatalogView({ includeRepositoryObjects: false }),
      actions: this.database.listRecentActions(60),
      sessions: this.database.listSessions(30),
      resourceSamples: this.database.listResourceSamples(120),
      connectionRoute,
      runtimeControl: this.runtimeControl?.status?.() || null,
    };
  }

  getSettings() {
    const defaults = {
      mode: "observation",
      delayMs: 100,
      settleMs: 500,
      autoMapUpgrade: false,
      strategy: "efficiency",
      prioritySlot: null,
      fontScale: 1.1,
      salePolicy: { automaticEnabled: false, rules: [] },
    };
    const merged = { ...defaults, ...this.database.getSetting("automation", {}) };
    merged.delayMs = Math.max(50, Math.min(250, Number(merged.delayMs) || defaults.delayMs));
    merged.settleMs = Math.max(300, Math.min(1000, Number(merged.settleMs) || defaults.settleMs));
    delete merged.maxActions;
    return merged;
  }

  saveSettings(settings = {}) {
    const normalized = {
      mode: ["observation", "assisted", "automatic"].includes(settings.mode) ? settings.mode : "observation",
      delayMs: Math.max(50, Math.min(250, Number(settings.delayMs) || 100)),
      settleMs: Math.max(300, Math.min(1000, Number(settings.settleMs) || 500)),
      autoMapUpgrade: !!settings.autoMapUpgrade,
      strategy: ["efficiency", "min-energy", "fastest", "specified"].includes(settings.strategy) ? settings.strategy : "efficiency",
      prioritySlot: settings.prioritySlot == null || settings.prioritySlot === "" ? null : String(settings.prioritySlot),
      fontScale: Math.max(0.9, Math.min(1.4, Number(settings.fontScale) || 1.1)),
      salePolicy: normalizeSalePolicy(settings.salePolicy || {}),
    };
    this.database.setSetting("automation", normalized);
    this.emit("settings-updated", { settings: normalized });
    return normalized;
  }

  buildDiagnosticPayload(state) {
    return {
      exportedAt: new Date().toISOString(),
      appVersion: "0.1.0",
      platform: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
      settings: this.getSettings(),
      catalog: { revision: this.database.getCatalogRevision(), ...this.database.getCatalogRepositorySummary() },
      runtimeControl: this.runtimeControl?.status?.() || null,
      state,
    };
  }

  async exportDiagnostic(targetPath) {
    const destination = path.resolve(String(targetPath));
    const state = await this.collectState().catch((error) => ({ collectionError: error.message }));
    const payload = this.buildDiagnosticPayload(state);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destination);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.append(JSON.stringify(payload, null, 2), { name: "diagnostic.json" });
      archive.append(JSON.stringify(this.database.listRecentActions(500), null, 2), { name: "recent-actions.json" });
      const catalogSnapshot = this.database.exportCatalogSnapshot();
      archive.append(JSON.stringify(catalogSnapshot, null, 2), { name: "catalog-repository.json" });
      archive.append(JSON.stringify(catalogSnapshot.projection, null, 2), { name: "item-catalog.json" });
      archive.finalize();
    });
    return { ok: true, path: destination, bytes: (await fsp.stat(destination)).size };
  }

  createRuntime(options, sessionId = null, nextSequence = null) {
    const runtimeControl = this.ensureRuntimeControl();
    const collectState = (signal = null) => this.collectState(signal);
    let sequence = 0;
    const emittedActions = new WeakSet();
    const recordEvent = (event) => {
      if (event && typeof event === "object") {
        if (emittedActions.has(event)) return;
        emittedActions.add(event);
      }
      const actionSequence = nextSequence ? nextSequence() : ++sequence;
      if (sessionId) this.database.logAction({ sessionId, sequence: actionSequence, type: event.type, reason: event.reason, ok: event.ok, before: event.before, after: event.after, details: event });
      this.queuePassiveCatalogEvidence({ actionDiff: { ...(event.diff || event), actionId: `${sessionId || "runtime"}:${actionSequence}`, reason: event.reason } });
      this.emit("automation-action", { action: event });
    };
    const execute = (command, signal) => runtimeControl.execute(command, { signal, options });
    const orderLoop = new OrderCoinLoop({
      collectState,
      planOrders: async (state) => {
        const plan = await buildOptimizationPlanInWorker({ catalog: this.getPlanningCatalog({ includeProvisional: options.mode === "observation", executionMode: options.mode }), state, strategy: options.strategy, prioritySlot: options.prioritySlot, salePolicy: options.salePolicy, executionMode: options.mode }, { signal: this.abortController?.signal || null });
        this.lastPlan = plan;
        return plan;
      },
      runBoardAction: ({ producer, merge, plannedAction, signal }) => execute({ type: "run-board-action", producer, merge, plannedAction }, signal),
      submitOrder: (slot, { signal, before }) => execute({ type: "submit-order", slot, before }, signal),
      preflightStore: (index, { signal }) => execute({ type: "preflight-warehouse-store", index }, signal),
      storeBoardItem: (index, { signal, preflight }) => execute({ type: "store-to-warehouse", index, preflight }, signal),
      loadWarehouseInventory: ({ signal }) => execute({ type: "load-warehouse-inventory" }, signal),
      retrieveWarehouseItem: (action, request) => execute({ type: "retrieve-from-warehouse", action, request: { inventory: request.inventory, before: request.before } }, request.signal),
      switchProductionMode: (index, modeId, request) => execute({ type: "switch-production-mode", index, modeId, request: { expectedCurrentModeId: request.expectedCurrentModeId } }, request.signal),
      reconcileBoardState: reconcileBoardObservation,
      onActionTimeout: ({ reason, timing }) => {
        this.pauseGate.pause();
        this.emit("automation-status", { running: true, paused: true, reason, message: "动作确认超时", timing });
      },
      onEvent: recordEvent,
      allowProductionModeSwitch: options.mode !== "observation",
      waitIfPaused: (signal) => this.pauseGate.wait(signal),
    });
    return new FullAutomationLoop({
      collectState,
      autoMapUpgrade: !!options.autoMapUpgrade,
      navigate: (target, { signal }) => execute({ type: "navigate", target }, signal),
      runOrderCycle: (runOptions) => orderLoop.run(runOptions),
      completeMapMission: ({ signal }) => execute({ type: "complete-map-mission" }, signal),
      onEvent: recordEvent,
      waitIfPaused: (signal) => this.pauseGate.wait(signal),
    });
  }

  async preview(options = {}) {
    await this.connect();
    const loop = this.createRuntime(options);
    return loop.run({ execute: false, maxActions: 1 });
  }

  async executeSaleSuggestion({ sourceIndex, itemId, expectedCoins, confirmed = false } = {}) {
    const settings = this.getSettings();
    if (settings.mode !== "assisted") return { ok: false, executed: false, reason: "sale-assisted-mode-required" };
    if (!confirmed) return { ok: false, executed: false, reason: "sale-confirmation-required" };
    if (this.running || this.actionBoundaryPending) return { ok: false, executed: false, reason: "automation-action-boundary-busy" };
    this.actionBoundaryPending = true;
    try {
      await this.connect();
      const before = await this.collectState();
      const catalog = this.getPlanningCatalog({ executionMode: "assisted" });
      const plan = buildOptimizationPlan({ catalog, state: before, strategy: settings.strategy, prioritySlot: settings.prioritySlot, salePolicy: settings.salePolicy, executionMode: "assisted" });
      const suggestion = (plan.saleSuggestions || []).find((candidate) => Number(candidate.sourceIndex) === Number(sourceIndex) && String(candidate.itemId) === String(itemId) && Number(candidate.expectedCoins) === Number(expectedCoins));
      if (!suggestion) return { ok: false, executed: false, reason: "sale-suggestion-stale-or-unavailable" };
      const runtimeControl = this.ensureRuntimeControl();
      const sessionId = this.database.startSession("assisted-sale", { explicitUserConfirmation: true, suggestion });
      try {
        const result = await runtimeControl.execute({ type: "sell-item", suggestion }, { options: { settleMs: settings.settleMs } });
        this.database.logAction({ sessionId, sequence: 1, type: "sell-item", reason: result.reason, ok: result.ok, before: result.before, after: result.after, details: { suggestion, verification: result.verification } });
        this.database.endSession(sessionId, result.ok ? "complete" : "failed");
        this.emit("automation-action", { action: { type: "sell-item", ok: result.ok, reason: result.reason, suggestion } });
        return result;
      } catch (error) {
        this.database.endSession(sessionId, "error");
        throw error;
      }
    } finally {
      this.actionBoundaryPending = false;
    }
  }

  async completeCurrentMapMission() {
    if (this.running || this.actionBoundaryPending) throw new Error("another automation action is already entering its execution boundary");
    this.actionBoundaryPending = true;
    try {
      await this.iconService.waitForIdle();
      await this.connect();
      const runtimeControl = this.ensureRuntimeControl();
      const sessionId = this.database.startSession("map-mission", { explicitUserAction: true });
      try {
        const result = await runtimeControl.execute({ type: "complete-map-mission" }, { options: { settleMs: 1800 } });
        this.database.logAction({ sessionId, sequence: 1, type: "complete-map-mission", reason: result.reason, ok: result.ok, before: result.before, after: result.after, details: { missionBefore: result.missionBefore, missionAfter: result.missionAfter } });
        this.database.endSession(sessionId, result.ok ? "complete" : "failed");
        this.emit("automation-action", { action: { type: "complete-map-mission", ok: result.ok, reason: result.reason } });
        return result;
      } catch (error) {
        this.database.endSession(sessionId, "error");
        throw error;
      }
    } finally {
      this.actionBoundaryPending = false;
    }
  }

  async start(options = {}) {
    const persisted = this.getSettings();
    const requestedMode = options.mode;
    options = {
      ...persisted,
      ...options,
      mode: requestedMode == null ? "observation" : ["observation", "assisted", "automatic"].includes(requestedMode) ? requestedMode : "observation",
    };
    if (this.running || this.actionBoundaryPending) throw new Error("自动化任务已在运行");
    this.actionBoundaryPending = true;
    this.running = true;
    try {
      this.iconService.interruptForAutomation();
      await this.connect();
    } catch (error) {
      this.running = false;
      throw error;
    } finally {
      this.actionBoundaryPending = false;
    }
    this.pauseGate.reset();
    this.abortController = new AbortController();
    const sessionId = this.database.startSession(options.mode === "observation" ? "observation" : "automatic", options);
    this.sessionKind = "bounded";
    this.activeSessionId = sessionId;
    this.emit("automation-status", { running: true, paused: false, sessionId });
    let sequence = 0;
    try {
      const loop = this.createRuntime(options, sessionId, () => ++sequence);
      let result;
      try {
        result = await loop.run({ execute: options.mode !== "observation", maxActions: options.maxActions ?? null, signal: this.abortController.signal });
      } catch (error) {
        if (error?.name !== "AbortError") throw error;
        result = { ok: false, executed: options.mode !== "observation", reason: "aborted", actions: [] };
      }
      if (!result.actions?.length && sequence === 0) {
        this.database.logAction({ sessionId, sequence: ++sequence, type: "boundary", reason: result.reason, ok: result.ok, details: { nextAction: result.nextAction || null } });
      }
      this.database.endSession(sessionId, result.reason === "aborted" ? "stopped" : result.ok ? "complete" : "failed");
      return result;
    } catch (error) {
      this.database.logAction({
        sessionId,
        sequence: ++sequence,
        type: "error",
        reason: "automation-error",
        ok: false,
        details: buildAutomationErrorDetails(error),
      });
      this.database.endSession(sessionId, "error");
      throw error;
    } finally {
      this.running = false;
      this.flushDeferredPassiveCatalogState();
      this.abortController = null;
      this.pauseGate.reset();
      this.activeSessionId = null;
      this.sessionKind = null;
      this.emit("automation-status", { running: false, paused: false, sessionId });
    }
  }

  startInBackground(options = {}) {
    if (this.activeRunPromise || this.running) {
      return { ok: true, accepted: false, reason: "already-running", sessionId: this.activeSessionId };
    }
    this.activeRunPromise = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.start(options))
      .then((result) => {
        this.emit("automation-complete", { result });
        return result;
      })
      .catch((error) => {
        this.emit("automation-error", { error: error?.message || String(error) });
        return { ok: false, reason: "automation-error", error: error?.message || String(error) };
      })
      .finally(() => {
        this.activeRunPromise = null;
      });
    return { ok: true, accepted: true, reason: "automation-started" };
  }

  async startIdle(options = {}) {
    if (this.running || this.actionBoundaryPending) throw new Error("automation task is already running");
    const settings = { ...this.getSettings(), ...options, mode: options.mode === "observation" ? "assisted" : options.mode || "assisted" };
    this.running = true;
    this.sessionKind = "idle";
    this.pauseGate.reset();
    this.abortController = new AbortController();
    const sessionId = this.database.startSession("idle", { explicitUserAction: true, persistence: "process-local", ...settings });
    this.activeSessionId = sessionId;
    let idleSequence = 0;
    this.idleSession = new IdleAutomationSession({
      ensureConnection: (signal) => this.connect(signal),
      collectState: (signal) => this.collectState(signal),
      planState: (state) => buildOptimizationPlanInWorker({ catalog: this.getPlanningCatalog({ includeProvisional: false, executionMode: settings.mode }), state, strategy: settings.strategy, prioritySlot: settings.prioritySlot, salePolicy: settings.salePolicy, executionMode: settings.mode }, { signal: this.abortController?.signal || null }),
      runBoundedSession: ({ signal }) => this.createRuntime(settings, sessionId, () => ++idleSequence).run({ execute: true, maxActions: null, signal }),
      getRuntimeCheckpoint: () => this.runtimeControl?.checkpoint?.() || null,
      reconcileBeforeMutation: (checkpoint, signal) => this.reconcileRuntimeControlForMutation(checkpoint, signal),
      waitIfPaused: (signal) => this.pauseGate.wait(signal),
      onEvent: (event) => {
        this.database.logAction({ sessionId, sequence: ++idleSequence, type: event.type, reason: event.reason, ok: event.ok, details: event });
        this.emit(event.type, event);
      },
    });
    this.emit("automation-status", { running: true, paused: false, idle: true, sessionKind: "idle", sessionId });
    try {
      const result = await this.idleSession.run({ signal: this.abortController.signal });
      this.database.endSession(sessionId, result.reason === "aborted" ? "stopped" : result.ok ? "complete" : "failed");
      return result;
    } catch (error) {
      this.database.logAction({
        sessionId,
        sequence: ++idleSequence,
        type: "error",
        reason: "automation-error",
        ok: false,
        details: buildAutomationErrorDetails(error),
      });
      this.database.endSession(sessionId, "error");
      throw error;
    } finally {
      this.running = false;
      this.flushDeferredPassiveCatalogState();
      this.abortController = null;
      this.idleSession = null;
      this.pauseGate.reset();
      this.activeSessionId = null;
      this.sessionKind = null;
      this.emit("automation-status", { running: false, paused: false, idle: false, sessionKind: null, sessionId });
    }
  }

  startIdleInBackground(options = {}) {
    if (this.activeRunPromise || this.running) return { ok: true, accepted: false, reason: "already-running", sessionId: this.activeSessionId };
    this.activeRunPromise = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.startIdle(options))
      .then((result) => { this.emit("automation-complete", { result }); return result; })
      .catch((error) => { this.emit("automation-error", { error: error?.message || String(error) }); return { ok: false, reason: "automation-error", error: error?.message || String(error) }; })
      .finally(() => { this.activeRunPromise = null; });
    return { ok: true, accepted: true, reason: "idle-automation-started" };
  }

  stop() {
    if (!this.abortController) return { ok: true, alreadyStopped: true };
    this.pauseGate.resume();
    this.idleSession?.interruptWait("stop");
    this.abortController.abort();
    return { ok: true, alreadyStopped: false };
  }

  pause() {
    if (!this.running) return { ok: false, reason: "automation-not-running", paused: false };
    const result = this.pauseGate.pause();
    this.idleSession?.interruptWait("pause");
    this.emit("automation-status", { running: true, paused: true });
    return result;
  }

  resume() {
    if (!this.running) return { ok: false, reason: "automation-not-running", paused: false };
    if (this.actionBoundaryPending) return { ok: false, reason: "safe-boundary-task-running", paused: true };
    const result = this.pauseGate.resume();
    this.idleSession?.interruptWait("resume");
    this.emit("automation-status", { running: true, paused: false });
    return result;
  }

  async close() {
    this.stop();
    this.connectController?.abort();
    await this.activeRunPromise?.catch(() => {});
    this.closing = true;
    await this.passiveCatalogDrainPromise?.catch(() => {});
    await this.iconService?.waitForIdle().catch(() => {});
    await this.lab?.close?.().catch(() => {});
    await this.connectionService.stop().catch(() => {});
    this.database.close();
  }
}

module.exports = { AutomationRuntime, buildOptimizationPlanInWorker, mergeCatalogs, waitForPromiseOrAbort };
