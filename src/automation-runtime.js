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
const { IconEvidenceService, resolveCocosSpriteFrame, resolveScreenshotTarget, captureCdpScreenshot, readCdpResource } = require("./icon-evidence");

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
    this.lastState = buildGameState();
    this.running = false;
    this.abortController = null;
    this.pauseGate = new PauseGate();
    this.activeSessionId = null;
    this.activeRunPromise = null;
    this.actionBoundaryPending = false;
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
    const projection = this.database.getCatalogProjection({ includeProvisional: true });
    const repository = { summary: this.database.getCatalogRepositorySummary() };
    if (includeRepositoryObjects) {
      repository.objects = this.database.listCatalogObjects();
      repository.conflicts = this.database.listCatalogConflicts();
      repository.reviewQueue = this.database.getCatalogReviewQueue();
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

  getPlanningCatalog({ includeProvisional = false } = {}) {
    return buildPlanningCatalogFromRepository(this.database, null, { includeProvisional });
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

  async refreshCatalogFromRuntime() {
    const selection = await this.connect();
    const snapshot = await this.lab.snapshot(selection);
    const captureDir = path.join(this.dataDir, "catalog-captures");
    await fsp.mkdir(captureDir, { recursive: true });
    const captureFile = `catalog-rescan-${Date.now()}.json`;
    snapshot.__captureFile = captureFile;
    await fsp.writeFile(path.join(captureDir, captureFile), JSON.stringify(snapshot, null, 2), "utf8");
    const scanned = this.buildCatalog([snapshot]);
    if (!scanned.chains.length) return { ok: false, reason: "selected-item-status-not-found", captureFile };
    this.database.transaction(() => {
      this.database.importCatalog(scanned, { sourceFile: path.join(captureDir, captureFile), sourceType: "runtime-capture" });
      const observedObjectIds = [...new Set([...(scanned.items || []).map((item) => String(item.id)), ...(scanned.producers || []).map((producer) => String(producer.itemId))])];
      const gateResults = this.catalogGate.evaluateAll({ objectIds: observedObjectIds });
      for (const object of gateResults) this.emit("catalog-state-updated", { object });
    });
    return { ok: true, reason: "catalog-refreshed", captureFile, catalogView: this.getCatalogView() };
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
    await this.lab?.close().catch(() => {});
    this.lab = null;
    this.selection = null;
    return this.connectionService.stop();
  }

  connect() {
    if (this.lab && this.selection?.probe) return this.selection;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async connectOnce() {
    const previous = this.lab;
    if (previous) {
      this.lab = null;
      this.selection = null;
      await previous.close().catch(() => {});
    }
    const lab = new AdapterLab(getConfig({ url: this.url || undefined }));
    this.lab = lab;
    const probes = await lab.connectAndDiscover();
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

  async collectState() {
    const selection = await this.connect();
    let snapshot;
    try { snapshot = await this.lab.snapshot(selection); }
    catch (error) {
      const failedLab = this.lab;
      this.selection = null;
      this.lab = null;
      await failedLab?.close().catch(() => {});
      throw error;
    }
    let boardState = null;
    try { boardState = await this.lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id); } catch (_) {}
    const state = buildGameState({ state: summarizeSnapshot(snapshot), boardState });
    this.lastState = state;
    this.database.logResourceSample({ sessionId: this.activeSessionId, coins: state.resources.coins, energy: state.resources.energy, diamonds: state.resources.diamonds, scene: state.scene, observedAt: state.collectedAt });
    return state;
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
    const planningCatalog = this.getPlanningCatalog({ includeProvisional: settings.mode === "observation" });
    const plan = buildOptimizationPlan({ catalog: planningCatalog, state, strategy: settings.strategy, prioritySlot: settings.prioritySlot });
    return {
      connected,
      connectionError,
      running: this.running,
      paused: this.pauseGate.paused,
      state,
      plan,
      catalog: { revision: planningCatalog.revision, ...planningCatalog.stats },
      catalogView: this.getCatalogView({ includeRepositoryObjects: false }),
      actions: this.database.listRecentActions(60),
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

  createRuntime(options, sessionId = null) {
    const contextId = this.selection.probe.context.id;
    const collectState = () => this.collectState();
    const runner = new BoardAutomationRunner({ client: this.lab.client, contextId, delayMs: options.delayMs, evaluateTimeoutMs: options.timeoutMs });
    const submitter = new OrderSubmitter({ client: this.lab.client, contextId, collectState, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs });
    const navigator = new SceneNavigator({ client: this.lab.client, contextId, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs });
    const mapCompleter = new MapMissionCompleter({ client: this.lab.client, contextId, collectState, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs });
    const warehouse = new WarehouseActionExecutor({ client: this.lab.client, contextId, collectState, settleMs: options.settleMs, evaluateTimeoutMs: options.timeoutMs });
    const orderLoop = new OrderCoinLoop({ collectState, planOrders: async (state) => buildOptimizationPlan({ catalog: this.getPlanningCatalog({ includeProvisional: options.mode === "observation" }), state, strategy: options.strategy, prioritySlot: options.prioritySlot }), runBoardAction: ({ producer, signal }) => runner.run({ producer, maxActions: 1, execute: true, signal }), submitOrder: (slot, { signal }) => submitter.submit(slot, { execute: true, signal }), storeBoardItem: (index, { signal }) => warehouse.move(index, { execute: true, signal }) });
    let sequence = 0;
    return new FullAutomationLoop({
      collectState,
      autoMapUpgrade: !!options.autoMapUpgrade,
      navigate: (target, { signal }) => navigator.go(target, { execute: true, signal }),
      runOrderCycle: (runOptions) => orderLoop.run(runOptions),
      completeMapMission: ({ signal }) => mapCompleter.complete({ execute: true, signal }),
      onEvent: (event) => {
        if (sessionId) this.database.logAction({ sessionId, sequence: ++sequence, type: event.type, reason: event.reason, ok: event.ok, before: event.before, after: event.after, details: event });
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
    const sessionId = this.database.startSession("automatic", options);
    this.activeSessionId = sessionId;
    this.emit("automation-status", { running: true, paused: false, sessionId });
    try {
      const loop = this.createRuntime(options, sessionId);
      const result = await loop.run({ execute: true, maxActions: options.maxActions ?? null, signal: this.abortController.signal });
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

  stop() {
    if (!this.abortController) return { ok: true, alreadyStopped: true };
    this.pauseGate.resume();
    this.abortController.abort();
    return { ok: true, alreadyStopped: false };
  }

  pause() {
    if (!this.running) return { ok: false, reason: "automation-not-running", paused: false };
    const result = this.pauseGate.pause();
    this.emit("automation-status", { running: true, paused: true });
    return result;
  }

  resume() {
    if (!this.running) return { ok: false, reason: "automation-not-running", paused: false };
    const result = this.pauseGate.resume();
    this.emit("automation-status", { running: true, paused: false });
    return result;
  }

  async close() {
    this.stop();
    await this.activeRunPromise?.catch(() => {});
    await this.iconService?.waitForIdle().catch(() => {});
    await this.lab?.close?.().catch(() => {});
    await this.connectionService.stop().catch(() => {});
    this.database.close();
  }
}

module.exports = { AutomationRuntime, mergeCatalogs };
