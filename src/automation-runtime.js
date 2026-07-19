"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { ZipArchive } = require("archiver");
const { AdapterLab } = require("./lab");
const { getConfig } = require("./config");
const { summarizeSnapshot } = require("../scripts/summarize-target-snapshot.cjs");
const { BOARD_SCAN_EXPRESSION } = require("./board-automation");
const { buildGameState } = require("./game-state");
const { buildOptimizationPlan } = require("./order-optimizer");
const { BoardAutomationRunner } = require("./board-runner");
const { OrderSubmitter } = require("./order-actions");
const { MapMissionCompleter } = require("./map-actions");
const { SceneNavigator } = require("./scene-navigation");
const { OrderCoinLoop } = require("./order-coin-loop");
const { FullAutomationLoop } = require("./full-automation-loop");
const { AutomationDatabase } = require("./automation-database");
const { ConnectionService } = require("./connection-service");
const { buildCatalog } = require("../scripts/build-item-catalog.cjs");
const { migrateLegacyCatalog } = require("./catalog-migration");
const { CatalogReviewGate, buildPlanningCatalogFromRepository } = require("./catalog-review-gate");
const { PauseGate } = require("./pause-gate");
const { WarehouseActionExecutor } = require("./warehouse-actions");
const { ProductionModeExecutor } = require("./production-mode-actions");
const { SaleActionExecutor } = require("./sale-actions");
const { normalizeSalePolicy } = require("./sale-policy");
const { IdleAutomationSession } = require("./idle-automation-session");
const { IconEvidenceService, resolveCocosSpriteFrame, resolveScreenshotTarget, captureCdpScreenshot, readCdpResource } = require("./icon-evidence");
const { buildCatalogEvidenceIndex, collectPassiveCatalogEvidence } = require("./catalog-evidence");
const { ActiveCatalogScanner, MAX_ACTIVE_CATALOG_SCAN_TARGETS, READ_CATALOG_SCAN_SELECTION_EXPRESSION, buildActiveCatalogInspectExpression, buildRestoreCatalogSelectionExpression } = require("./catalog-scan");
const { unknownWarehouseInventoryKnowledge } = require("./warehouse-domain");

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

class AutomationRuntime {
  constructor({ rootDir = path.resolve(__dirname, ".."), dataDir = null, url = null, onEvent = null, manageConnectionRoute = true } = {}) {
    this.rootDir = rootDir;
    this.url = url;
    this.onEvent = onEvent;
    this.manageConnectionRoute = manageConnectionRoute !== false;
    this.connectionAutoStartEnabled = this.manageConnectionRoute;
    this.lab = null;
    this.selection = null;
    this.connectPromise = null;
    this.connectController = null;
    this.lastState = buildGameState();
    this.running = false;
    this.abortController = null;
    this.pauseGate = new PauseGate();
    this.activeSessionId = null;
    this.activeRunPromise = null;
    this.idleSession = null;
    this.sessionKind = null;
    this.actionBoundaryPending = false;
    this.passiveCatalogState = null;
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
    this.iconService = new IconEvidenceService({
      database: this.database,
      cacheDir: path.join(this.dataDir, "icon-cache"),
      concurrency: 2,
      resolveSpriteFrame: async ({ itemId, itemIdentity }) => {
        const selection = await this.connect();
        return resolveCocosSpriteFrame({ client: this.lab.client, contextId: selection.probe.context.id, itemId, itemIdentity });
      },
      readResource: async ({ resourceUrl, mimeType }) => {
        await this.connect();
        return readCdpResource({ client: this.lab.client, resourceUrl, mimeType });
      },
      resolveScreenshotBounds: async ({ itemId, itemIdentity }) => {
        const selection = await this.connect();
        return resolveScreenshotTarget({ client: this.lab.client, contextId: selection.probe.context.id, itemId, itemIdentity });
      },
      captureScreenshot: async () => {
        await this.connect();
        return captureCdpScreenshot({ client: this.lab.client });
      },
      onEvent: (event) => this.emit(event.type, event),
    });
  }

  emit(type, payload = {}) { this.onEvent?.({ type, at: new Date().toISOString(), ...payload }); }

  getCatalogView({ includeRepositoryObjects = true } = {}) {
    const executionMode = this.getSettings().mode;
    const projection = this.database.getCatalogProjection({ includeProvisional: true, executionMode });
    const repository = { summary: this.database.getCatalogRepositorySummary() };
    if (includeRepositoryObjects) {
      repository.objects = this.database.listCatalogObjects();
      repository.conflicts = this.database.listCatalogConflicts();
      repository.reviewQueue = this.database.getCatalogReviewQueue();
      repository.productionDistributionReviews = this.database.listProductionDistributionReviewEvents();
      repository.uncertainProductionActions = this.database.listUncertainProductionActions();
    }
    return {
      revision: projection.revision,
      stats: projection.stats,
      coverage: projection.coverage,
      chains: projection.chains,
      items: projection.items.map((item) => ({ ...item, iconUrl: item.iconHash ? `/api/catalog/icon/${item.iconHash}` : null })),
      producers: projection.producers,
      repository,
    };
  }

  getCatalogObject(objectType, objectId) {
    const object = this.database.getCatalogObject(objectType, objectId);
    if (!object || objectType !== "item-identity") return object;
    const iconUrl = (candidate) => candidate ? { ...candidate, url: `/api/catalog/icon/${candidate.assetHash}` } : candidate;
    return { ...object, iconCandidates: (object.iconCandidates || []).map(iconUrl), selectedIcon: iconUrl(object.selectedIcon) };
  }

  getPlanningCatalog({ includeProvisional = false, executionMode = "assisted" } = {}) {
    const catalog = buildPlanningCatalogFromRepository(this.database, null, { includeProvisional, executionMode });
    return { ...catalog, evidence: buildCatalogEvidenceIndex(this.database) };
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
    return this.iconService.request(String(itemId), { itemIdentity: { itemId: String(itemId), ...(object.effectiveValue || object.algorithmCandidate || {}) } });
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
    const scanned = this.buildCatalog([snapshot]);
    if (!scanned.chains.length) return { ok: false, reason: "selected-item-status-not-found", captureFile };
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
    return this.connectionService.stop();
  }

  connect(signal = null) {
    if (this.lab && this.selection?.probe) return this.selection;
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
    const previous = this.lab;
    if (previous) {
      this.lab = null;
      this.selection = null;
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
    lab.client.once("close", () => {
      if (this.lab !== lab) return;
      this.selection = null;
      this.lab = null;
      this.emit("connection", { connected: false, reason: "cdp-websocket-closed" });
    });
    this.emit("connection", { connected: true, contextId: selection.probe.context.id });
    return selection;
  }

  async collectState(signal = null) {
    const selection = await this.connect(signal);
    let snapshot;
    try { snapshot = await this.lab.snapshot(selection, { signal }); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      const failedLab = this.lab;
      this.selection = null;
      this.lab = null;
      await failedLab?.close().catch(() => {});
      throw error;
    }
    let boardState = null;
    try { boardState = await this.lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id, { signal }); } catch (error) { if (error?.name === "AbortError") throw error; }
    const state = buildGameState({ state: summarizeSnapshot(snapshot), boardState });
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
    if (state) this.passiveCatalogState = state;
    if (actionDiff) {
      this.passiveCatalogDiffs.push(actionDiff);
      if (this.passiveCatalogDiffs.length > 16) this.passiveCatalogDiffs.splice(0, this.passiveCatalogDiffs.length - 16);
    }
    if (this.passiveCatalogDrainPromise) return;
    this.passiveCatalogDrainPromise = new Promise((resolve) => setImmediate(() => {
      const pendingState = this.passiveCatalogState;
      const pendingDiffs = this.passiveCatalogDiffs.splice(0);
      this.passiveCatalogState = null;
      try {
        const observed = new Set(collectPassiveCatalogEvidence(this.database, { state: pendingState }));
        for (const diff of pendingDiffs) for (const objectId of collectPassiveCatalogEvidence(this.database, { actionDiff: diff })) observed.add(objectId);
        const productionModeIds = [...observed].filter((key) => key.startsWith("production-mode:")).map((key) => key.slice("production-mode:".length));
        if (productionModeIds.length) {
          for (const object of this.catalogGate.evaluateAll({ objectIds: productionModeIds })) this.emit("catalog-state-updated", { object });
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

  invalidateWarehouseInventoryKnowledge(reason) {
    this.warehouseInventoryKnowledgeInvalidated = true;
    this.warehouseInventoryInvalidationReason = String(reason || "warehouse-inventory-invalidated");
    this.emit("warehouse-inventory-invalidated", { reason: this.warehouseInventoryInvalidationReason });
  }

  async dashboard() {
    const settings = this.getSettings();
    let state = this.lastState;
    let connected = false;
    let connectionError = null;
    try {
      state = await this.collectState();
      connected = true;
    } catch (error) {
      connectionError = error?.message || String(error);
    }
    const connectionRoute = await this.connectionService.status();
    if (this.connectionAutoStartEnabled && !connectionRoute.listening && !connectionRoute.starting) {
      this.ensureConnectionRoute().catch((error) => this.emit("connection-route-error", { error: error.message }));
    }
    const planningCatalog = this.getPlanningCatalog({ includeProvisional: settings.mode === "observation", executionMode: settings.mode });
    const plan = buildOptimizationPlan({ catalog: planningCatalog, state, strategy: settings.strategy, prioritySlot: settings.prioritySlot, salePolicy: settings.salePolicy, executionMode: settings.mode });
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
    };
  }

  getSettings() {
    const defaults = {
      mode: "observation",
      delayMs: 1200,
      settleMs: 1800,
      autoMapUpgrade: false,
      strategy: "efficiency",
      prioritySlot: null,
      fontScale: 1.1,
      salePolicy: { automaticEnabled: false, rules: [] },
    };
    const merged = { ...defaults, ...this.database.getSetting("automation", {}) };
    delete merged.maxActions;
    return merged;
  }

  saveSettings(settings = {}) {
    const normalized = {
      mode: ["observation", "assisted", "automatic"].includes(settings.mode) ? settings.mode : "observation",
      delayMs: Math.max(300, Math.min(10000, Number(settings.delayMs) || 1200)),
      settleMs: Math.max(300, Math.min(15000, Number(settings.settleMs) || 1800)),
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

  async exportDiagnostic(targetPath) {
    const destination = path.resolve(String(targetPath));
    const state = await this.collectState().catch((error) => ({ collectionError: error.message }));
    const payload = {
      exportedAt: new Date().toISOString(),
      appVersion: "0.1.0",
      platform: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
      settings: this.getSettings(),
      catalog: { revision: this.database.getCatalogRevision(), ...this.database.getCatalogRepositorySummary() },
      state,
    };
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
    const contextId = this.selection.probe.context.id;
    const collectState = (signal = null) => this.collectState(signal);
    const runner = new BoardAutomationRunner({ client: this.lab.client, contextId, delayMs: options.delayMs, evaluateTimeoutMs: options.timeoutMs });
    const submitter = new OrderSubmitter({ client: this.lab.client, contextId, collectState, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs });
    const navigator = new SceneNavigator({ client: this.lab.client, contextId, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs });
    const mapCompleter = new MapMissionCompleter({ client: this.lab.client, contextId, collectState, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs });
    const warehouse = new WarehouseActionExecutor({ client: this.lab.client, contextId, collectState, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs, onInventoryKnowledgeInvalidated: (reason) => this.invalidateWarehouseInventoryKnowledge(reason) });
    const productionModes = new ProductionModeExecutor({ client: this.lab.client, contextId, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs });
    const orderLoop = new OrderCoinLoop({ collectState, planOrders: async (state) => buildOptimizationPlan({ catalog: this.getPlanningCatalog({ includeProvisional: options.mode === "observation", executionMode: options.mode }), state, strategy: options.strategy, prioritySlot: options.prioritySlot, salePolicy: options.salePolicy, executionMode: options.mode }), runBoardAction: ({ producer, merge, plannedAction, signal }) => runner.run({ producer, merge, plannedAction, maxActions: 1, execute: true, signal }), submitOrder: (slot, { signal }) => submitter.submit(slot, { execute: true, signal }), preflightStore: (index, { signal }) => warehouse.preflight(index, { signal }), storeBoardItem: (index, { signal, preflight }) => warehouse.move(index, { execute: true, signal, preflight }), loadWarehouseInventory: ({ signal }) => warehouse.loadInventory({ execute: true, signal }), retrieveWarehouseItem: (action, request) => warehouse.retrieve(action, { ...request, execute: true }), switchProductionMode: (index, modeId, request) => productionModes.switch(index, modeId, { ...request, execute: true }), allowProductionModeSwitch: options.mode !== "observation" });
    let sequence = 0;
    return new FullAutomationLoop({
      collectState,
      autoMapUpgrade: !!options.autoMapUpgrade,
      navigate: (target, { signal }) => navigator.go(target, { execute: true, signal }),
      runOrderCycle: (runOptions) => orderLoop.run(runOptions),
      completeMapMission: ({ signal }) => mapCompleter.complete({ execute: true, signal }),
      onEvent: (event) => {
        const actionSequence = nextSequence ? nextSequence() : ++sequence;
        if (sessionId) this.database.logAction({ sessionId, sequence: actionSequence, type: event.type, reason: event.reason, ok: event.ok, before: event.before, after: event.after, details: event });
        this.queuePassiveCatalogEvidence({ actionDiff: { ...(event.diff || event), actionId: `${sessionId || "runtime"}:${actionSequence}`, reason: event.reason } });
        this.emit("automation-action", { action: event });
      },
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
      const executor = new SaleActionExecutor({ client: this.lab.client, contextId: this.selection.probe.context.id, collectState: () => this.collectState(), settleMs: settings.settleMs });
      const sessionId = this.database.startSession("assisted-sale", { explicitUserConfirmation: true, suggestion });
      try {
        const result = await executor.execute(suggestion, { confirmed: true });
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
      const contextId = this.selection.probe.context.id;
      const completer = new MapMissionCompleter({ client: this.lab.client, contextId, collectState: () => this.collectState(), settleMs: 1800 });
      const sessionId = this.database.startSession("map-mission", { explicitUserAction: true });
      try {
        const result = await completer.complete({ execute: true });
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
    try {
      await this.iconService.waitForIdle();
      await this.connect();
      this.running = true;
    } finally {
      this.actionBoundaryPending = false;
    }
    this.pauseGate.reset();
    this.abortController = new AbortController();
    const sessionId = this.database.startSession(options.mode === "observation" ? "observation" : "automatic", options);
    this.sessionKind = "bounded";
    this.activeSessionId = sessionId;
    this.emit("automation-status", { running: true, paused: false, sessionId });
    try {
      const loop = this.createRuntime(options, sessionId);
      const result = await loop.run({ execute: options.mode !== "observation", maxActions: options.maxActions ?? null, signal: this.abortController.signal });
      this.database.endSession(sessionId, result.ok ? "complete" : "failed");
      return result;
    } catch (error) {
      this.database.endSession(sessionId, "error");
      throw error;
    } finally {
      this.running = false;
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
    this.activeRunPromise = this.start(options)
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
      planState: async (state) => buildOptimizationPlan({ catalog: this.getPlanningCatalog({ includeProvisional: false, executionMode: settings.mode }), state, strategy: settings.strategy, prioritySlot: settings.prioritySlot, salePolicy: settings.salePolicy, executionMode: settings.mode }),
      runBoundedSession: ({ signal }) => this.createRuntime(settings, sessionId, () => ++idleSequence).run({ execute: true, maxActions: null, signal }),
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
      this.database.endSession(sessionId, "error");
      throw error;
    } finally {
      this.running = false;
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
    this.activeRunPromise = this.startIdle(options).then((result) => { this.emit("automation-complete", { result }); return result; })
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

module.exports = { AutomationRuntime, mergeCatalogs, waitForPromiseOrAbort };
