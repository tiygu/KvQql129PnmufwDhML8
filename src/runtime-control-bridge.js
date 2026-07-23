"use strict";

const { summarizeSnapshot } = require("../scripts/summarize-target-snapshot.cjs");
const { BOARD_SCAN_EXPRESSION } = require("./board-automation");
const { buildGameState } = require("./game-state");
const { BoardAutomationRunner } = require("./board-runner");
const { OrderSubmitter } = require("./order-actions");
const { MapMissionCompleter } = require("./map-actions");
const { SceneNavigator } = require("./scene-navigation");
const { WarehouseActionExecutor } = require("./warehouse-actions");
const { ProductionModeExecutor } = require("./production-mode-actions");
const { SaleActionExecutor } = require("./sale-actions");

const RUNTIME_CONTROL_PROTOCOL_VERSION = 1;
const RUNTIME_CONTROL_BRIDGE_VERSION = "1.0.0";

/**
 * Runtime Semantic Control Bridge interface implemented by both adapters.
 *
 * @typedef {object} RuntimeSemanticControlBridge
 * @property {(signal?: AbortSignal | null) => Promise<object>} ready
 * @property {(signal?: AbortSignal | null) => Promise<object>} readState
 * @property {(command: object, request?: { signal?: AbortSignal | null, options?: object }) => Promise<object>} execute
 */

function abortError() {
  return Object.assign(new Error("runtime control operation aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function cloneRecord(value) {
  return value == null ? value : structuredClone(value);
}

function waitForAbortable(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function resolveFakeEntry(entry, context) {
  assertNotAborted(context.signal);
  const pending = typeof entry === "function" ? entry(context) : entry;
  const value = await waitForAbortable(pending, context.signal);
  assertNotAborted(context.signal);
  if (value instanceof Error) throw value;
  return cloneRecord(value);
}

// This one-time installer is intentionally self-contained. Routine bridge reads
// remain one short atomic call and every traversal below is bounded by live state.
function buildBridgeInstallExpression(contextGeneration) {
  const generation = JSON.stringify(String(contextGeneration));
  const protocolVersion = JSON.stringify(RUNTIME_CONTROL_PROTOCOL_VERSION);
  const bridgeVersion = JSON.stringify(RUNTIME_CONTROL_BRIDGE_VERSION);
  return `(() => {
    const contextGeneration = ${generation};
    const existing = globalThis.miniGameCtl;
    if (existing?.__runtimeSemanticControlBridge === true
      && existing.contextGeneration === contextGeneration
      && typeof existing.handshake === "function"
      && typeof existing.readBaseline === "function") {
      return { handshake: existing.handshake(), baseline: existing.readBaseline() };
    }
    const runtimeGlobal = globalThis;
    const cc = runtimeGlobal.cc || runtimeGlobal.GameGlobal?.cc;
    const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };
    const isMap = (value) => value != null
      && typeof value.get === "function"
      && typeof value.values === "function"
      && typeof value.entries === "function";
    const engineVersion = String(cc?.ENGINE_VERSION || cc?.VERSION || "unknown");
    const resolveRuntime = () => {
      const currentScene = safe(() => cc?.director?.getScene?.(), null);
      const entry = currentScene?.getChildByName?.("Entry")
        || currentScene?.children?.find?.((node) => node?.name === "Entry");
      const runtime = (entry?._components || []).find((component) =>
        Array.isArray(component?.mControllers) && Array.isArray(component?.mManagers));
      if (!runtime) throw new Error("runtime bridge target-game entry was not found");
      return { currentScene, runtime };
    };
    const inspectRuntime = (runtime) => {
      const managers = runtime.mManagers;
      const controllers = runtime.mControllers;
      const resourceRead = managers.some((manager) => isMap(manager?._resourceMap));
      const energyRead = managers.some((manager) => isMap(manager?._energyDataMap));
      const orderRead = managers.some((manager) => isMap(manager?.clientTaskDataMap));
      const boardController = controllers.find((item) => item?._controllerClazzName === "UserBoardViewController");
      const boardView = boardController?.view?._boardView?._gameBoardView;
      const gameBoard = boardView?._boardStore?._state?._gameBoard;
      const boardRead = Array.isArray(gameBoard?.__private_95_grids);
      return {
        baseline: resourceRead && energyRead && orderRead && boardRead,
        boardRead,
        resourceRead,
        energyRead,
        orderRead,
        merge: false,
        production: false,
        orderSubmission: false,
        navigation: false
      };
    };
    const fingerprintRuntime = (runtime) => {
      const controllerNames = runtime.mControllers
        .map((controller) => String(controller?._controllerClazzName || controller?._viewClazzName || "unknown"))
        .sort().slice(0, 32);
      const managerRoles = [];
      for (const manager of runtime.mManagers) {
        if (isMap(manager?._resourceMap)) managerRoles.push("resources");
        if (isMap(manager?._energyDataMap)) managerRoles.push("energy");
        if (isMap(manager?.clientTaskDataMap)) managerRoles.push("tasks");
        if (isMap(manager?._multipleModeMap)) managerRoles.push("modes");
      }
      return "target-game:cocos:" + engineVersion
        + ":controllers=" + [...new Set(controllerNames)].join(",")
        + ";managers=" + [...new Set(managerRoles)].sort().join(",");
    };
    const initialRuntime = resolveRuntime().runtime;
    const capabilities = Object.freeze(inspectRuntime(initialRuntime));
    const gameFingerprint = fingerprintRuntime(initialRuntime);
    const readBaseline = () => {
      const { runtime } = resolveRuntime();
      if (!inspectRuntime(runtime).baseline) throw new Error("runtime bridge baseline resolvers are unavailable");
      const managers = runtime.mManagers;
      const controllers = runtime.mControllers;
      const resourceManager = managers.find((manager) => isMap(manager?._resourceMap));
      const energyManager = managers.find((manager) => isMap(manager?._energyDataMap));
      const taskManager = managers.find((manager) => isMap(manager?.clientTaskDataMap));
      const resourceMap = isMap(resourceManager?._resourceMap) ? resourceManager._resourceMap : new Map();
      const energyMap = isMap(energyManager?._energyDataMap) ? energyManager._energyDataMap : new Map();
      const resourceAmount = (type) => Number(resourceMap.get(type) ?? resourceMap.get(String(type)) ?? 0) || 0;
      const energyData = energyMap.get(3) ?? energyMap.get("3") ?? energyMap.values().next().value ?? null;
      const orders = [];
      const requiredCounts = new Map();
      const taskRoot = taskManager?.clientTaskDataMap;
      if (isMap(taskRoot)) {
        for (const nested of taskRoot.values()) {
          if (!isMap(nested)) continue;
          for (const [slot, task] of nested.entries()) {
            const items = (Array.isArray(task?.itemInfos) ? task.itemInfos : []).map((item) => ({
              itemId: String(safe(() => item.itemId, "")),
              complete: !!safe(() => item.isComplete, false),
              status: safe(() => item.status, null)
            }));
            for (const item of items) {
              if (item.itemId) requiredCounts.set(item.itemId, (requiredCounts.get(item.itemId) || 0) + 1);
            }
            const rewardCoins = Number(safe(() => task.rewards?.find?.((reward) => Number(reward.type) === 1)?.count, 0)) || 0;
            orders.push({
              slot: String(slot),
              taskId: safe(() => task.taskId, null),
              rewardCoins,
              items,
              requiredItemIds: items.map((item) => item.itemId).filter(Boolean),
              missingItemIds: items.filter((item) => !item.complete).map((item) => item.itemId).filter(Boolean),
              ready: items.length > 0 && items.every((item) => item.complete)
            });
          }
        }
      }
      const resolveBoardContext = () => {
        const controller = controllers.find((item) => item?._controllerClazzName === "UserBoardViewController");
        const boardView = controller?.view?._boardView?._gameBoardView;
        const gameBoard = boardView?._boardStore?._state?._gameBoard;
        return { controller, boardView, gameBoard };
      };
      const { controller, boardView, gameBoard } = resolveBoardContext();
      const runtimeGrids = Array.isArray(gameBoard?.__private_95_grids) ? gameBoard.__private_95_grids : [];
      const multipleModeManager = managers.find((manager) => isMap(manager?._multipleModeMap));
      const productionModeIdOf = (value) => String(value?.modeId ?? value?.multiple ?? value?.value ?? value ?? "single");
      const productionModeCurrentFor = (grid) => productionModeIdOf(
        multipleModeManager?._multipleModeMap?.get?.(String(grid?.itemId))
        ?? multipleModeManager?._multipleModeMap?.get?.(Number(grid?.itemId))
        ?? multipleModeManager?._multipleModeMap?.get?.(grid?.index),
      );
      const productionTheoryFor = (grid, modeId) => {
        const config = grid?.item?.itemConfig || {};
        const values = Array.isArray(config.CreateData) ? config.CreateData.map(String).filter(Boolean) : [];
        const counts = new Map();
        for (const itemId of values) counts.set(itemId, (counts.get(itemId) || 0) + 1);
        return values.length ? {
          configVersion: String(config.Version ?? config.version ?? config.id ?? "runtime-current")
            + ":" + values.join(",") + ":" + modeId,
          extractionSource: "grid.item.itemConfig.CreateData",
          outputsPerAction: modeId === "quad" ? 4 : modeId === "double" ? 2 : 1,
          outcomes: [...counts].map(([itemId, weight]) => ({ itemId, weight, probability: weight / values.length }))
        } : null;
      };
      const productionModesFor = (grid) => {
        const modeIds = ["single", "double", ...(multipleModeManager?._isOpenedFourfoldMode ? ["quad"] : [])];
        const current = productionModeCurrentFor(grid);
        if (!modeIds.includes(current)) modeIds.push(current);
        return modeIds.map((modeId) => ({
          modeId,
          unlocked: modeId !== "quad" || !!multipleModeManager?._isOpenedFourfoldMode,
          theoreticalDistribution: productionTheoryFor(grid, modeId)
        }));
      };
      const productionModeSwitchMethod = ["setMultipleMode", "changeMultipleMode", "switchMultipleMode", "onMultipleModeChange"]
        .find((name) => typeof multipleModeManager?.[name] === "function") || null;
      const isProducerGrid = (grid) => typeof safe(() => grid?.item?.produceCount) === "number"
        && Number(safe(() => grid?.item?.itemConfig?.EnergyCost, 0)) > 0;
      const describeGrid = (grid) => ({
        index: Number(grid?.index),
        itemId: String(safe(() => grid.itemId, "")),
        empty: !!safe(() => grid.isEmpty, true),
        normal: !!safe(() => grid.isNormal, false),
        moveable: !!safe(() => grid.isMoveable, false),
        locked: !!safe(() => grid.isLocking, false),
        frozen: !!safe(() => grid.isFrozen, false),
        actionReady: !!safe(() => boardView.canBoardGridBeDragging(grid), false)
          && !safe(() => boardView.isBoardGridItemAnimating(grid), false),
        taskNeed: !!safe(() => grid.item?.taskNeed, false),
        level: safe(() => grid.item?.itemConfig?.Level, null),
        mergeTarget: safe(() => grid.item?.itemConfig?.MergeTarget, null),
        produceCount: safe(() => grid.item?.produceCount, null),
        energyCost: safe(() => grid.item?.itemConfig?.EnergyCost, null),
        saleValue: safe(() => grid.item?.itemConfig?.Price, null),
        currentProductionModeId: productionModeCurrentFor(grid),
        availableProductionModes: productionModesFor(grid),
        productionModeSwitchEntry: {
          status: productionModeSwitchMethod ? "available" : "unavailable",
          method: productionModeSwitchMethod
        }
      });
      const grids = runtimeGrids.map(describeGrid);
      const groups = new Map();
      for (const grid of runtimeGrids) {
        const itemId = String(safe(() => grid.itemId, ""));
        if (!itemId || isProducerGrid(grid) || !safe(() => grid.isNormal, false)
          || !safe(() => grid.isMoveable, false) || safe(() => grid.isLocking, false)
          || safe(() => grid.isFrozen, false)) continue;
        if (!groups.has(itemId)) groups.set(itemId, []);
        groups.get(itemId).push(grid);
      }
      const mergeCandidates = [];
      for (const [itemId, values] of groups) {
        values.sort((left, right) => Number(!!safe(() => left.item?.taskNeed, false))
          - Number(!!safe(() => right.item?.taskNeed, false)));
        const usable = values.slice(0, Math.max(0, values.length - (requiredCounts.get(itemId) || 0)));
        for (let index = 0; index + 1 < usable.length; index += 2) {
          const source = usable[index];
          const target = usable[index + 1];
          if (!safe(() => boardView?._operatorCenter?.itemCanMergeWith(source.item, target.item), false)) continue;
          mergeCandidates.push({
            itemId,
            from: source.index,
            to: target.index,
            mergeTarget: safe(() => source.item?.itemConfig?.MergeTarget, null),
            level: safe(() => source.item?.itemConfig?.Level, null),
            predictedResult: safe(() => boardView?._dragHandler?.predictDragResult(source, target), null)
          });
        }
      }
      const producers = runtimeGrids.filter((grid) =>
        grid?.item && isProducerGrid(grid)
        && Number(safe(() => grid.item.produceCount, 0)) > 0
        && !safe(() => grid.isLocking, false)).map(describeGrid);
      const boardAvailable = !!controller && !!boardView && Array.isArray(gameBoard?.__private_95_grids);
      const boardVisible = boardAvailable && !!controller.isViewVisible;
      const energyAmount = resourceAmount(3);
      return {
        schemaVersion: 1,
        collectedAt: new Date().toISOString(),
        scene: boardVisible ? "board" : "map",
        resources: { coins: resourceAmount(1), diamonds: resourceAmount(2), energy: energyAmount },
        energy: {
          amount: energyAmount,
          limit: safe(() => energyData._energyLimit, null),
          recoverIntervalSeconds: safe(() => energyData._recoverInterval, null),
          recoverTimestamp: safe(() => energyData.recoverTimestamp, null),
          recovering: !!safe(() => energyData.inRecover, false)
        },
        board: {
          available: boardAvailable,
          visible: boardVisible,
          width: safe(() => gameBoard.size.width, null),
          height: safe(() => gameBoard.size.height, null),
          occupied: grids.filter((grid) => !grid.empty).length,
          empty: grids.filter((grid) => grid.empty).length,
          signature: grids.map((grid) => grid.itemId).join("|"),
          grids,
          mergeCandidates,
          requiredItemCounts: Object.fromEntries(requiredCounts)
        },
        orders,
        producers,
        warehouse: { inventoryKnowledge: { status: "unknown" } },
        mapProgress: {
          currentTask: null,
          currentSeason: null,
          seasonDisplay: null,
          allFinished: false,
          episodeFinished: false
        },
        mapMission: null,
        overlays: [],
        selectedItem: null,
        source: { adapter: "semantic-runtime", engine: "cocos" }
      };
    };
    const bridge = Object.freeze({
      __runtimeSemanticControlBridge: true,
      contextGeneration,
      handshake: () => ({
        protocolVersion: ${protocolVersion},
        bridgeVersion: ${bridgeVersion},
        gameFingerprint,
        contextGeneration,
        revision: 0,
        capabilities: { ...capabilities }
      }),
      readBaseline
    });
    runtimeGlobal.miniGameCtl = bridge;
    return { handshake: bridge.handshake(), baseline: bridge.readBaseline() };
  })()`;
}

function validateHandshake(value, contextGeneration) {
  if (!value || typeof value !== "object") throw Object.assign(new Error("runtime bridge handshake is invalid"), { code: "RUNTIME_CONTROL_HANDSHAKE_INVALID" });
  if (!Number.isInteger(value.protocolVersion)) {
    throw Object.assign(new Error("runtime bridge protocol version is invalid"), { code: "RUNTIME_CONTROL_HANDSHAKE_INVALID" });
  }
  if (value.protocolVersion !== RUNTIME_CONTROL_PROTOCOL_VERSION) {
    throw Object.assign(new Error(`runtime bridge protocol ${value.protocolVersion} is incompatible`), { code: "RUNTIME_CONTROL_PROTOCOL_INCOMPATIBLE" });
  }
  if (typeof value.bridgeVersion !== "string" || !value.bridgeVersion
    || typeof value.gameFingerprint !== "string" || !value.gameFingerprint
    || typeof value.contextGeneration !== "string" || !value.contextGeneration) {
    throw Object.assign(new Error("runtime bridge handshake metadata is invalid"), { code: "RUNTIME_CONTROL_HANDSHAKE_INVALID" });
  }
  if (value.contextGeneration !== contextGeneration) {
    throw Object.assign(new Error("runtime bridge context generation does not match the selected context"), { code: "RUNTIME_CONTROL_CONTEXT_MISMATCH" });
  }
  const requiredReads = ["baseline", "boardRead", "resourceRead", "energyRead", "orderRead"];
  const declaredCapabilities = ["merge", "production", "orderSubmission", "navigation"];
  const capabilitiesValid = requiredReads.every((name) => value.capabilities?.[name] === true)
    && declaredCapabilities.every((name) => typeof value.capabilities?.[name] === "boolean");
  if (!Number.isInteger(value.revision) || value.revision < 0 || !capabilitiesValid) {
    throw Object.assign(new Error("runtime bridge handshake capabilities or revision are invalid"), { code: "RUNTIME_CONTROL_HANDSHAKE_INVALID" });
  }
  return cloneRecord(value);
}

function validateBaseline(value) {
  const isRecord = (record) => record != null && typeof record === "object" && !Array.isArray(record);
  const finiteNumber = (number) => typeof number === "number" && Number.isFinite(number);
  const optionalFiniteNumber = (number) => number == null || finiteNumber(number);
  const resourcesValid = isRecord(value?.resources)
    && ["coins", "diamonds", "energy"].every((name) => finiteNumber(value.resources[name]));
  const energyValid = isRecord(value?.energy)
    && finiteNumber(value.energy.amount)
    && optionalFiniteNumber(value.energy.limit)
    && optionalFiniteNumber(value.energy.recoverIntervalSeconds)
    && optionalFiniteNumber(value.energy.recoverTimestamp)
    && typeof value.energy.recovering === "boolean";
  const boardValid = isRecord(value?.board)
    && typeof value.board.available === "boolean"
    && typeof value.board.visible === "boolean"
    && optionalFiniteNumber(value.board.width)
    && optionalFiniteNumber(value.board.height)
    && Number.isInteger(value.board.occupied) && value.board.occupied >= 0
    && Number.isInteger(value.board.empty) && value.board.empty >= 0
    && typeof value.board.signature === "string"
    && Array.isArray(value.board.grids)
    && value.board.grids.every((grid) => isRecord(grid)
      && Number.isInteger(grid.index)
      && typeof grid.itemId === "string")
    && Array.isArray(value.board.mergeCandidates)
    && isRecord(value.board.requiredItemCounts);
  const ordersValid = Array.isArray(value?.orders) && value.orders.every((order) =>
    isRecord(order)
    && typeof order.slot === "string"
    && finiteNumber(order.rewardCoins)
    && typeof order.ready === "boolean"
    && Array.isArray(order.items)
    && order.items.every((item) => isRecord(item)
      && typeof item.itemId === "string"
      && typeof item.complete === "boolean")
    && Array.isArray(order.requiredItemIds)
    && Array.isArray(order.missingItemIds));
  const valid = isRecord(value)
    && value.schemaVersion === 1
    && typeof value.collectedAt === "string"
    && typeof value.scene === "string"
    && resourcesValid
    && energyValid
    && boardValid
    && ordersValid
    && Array.isArray(value.producers);
  if (!valid) throw Object.assign(new Error("runtime bridge baseline is invalid"), { code: "RUNTIME_CONTROL_BASELINE_INVALID" });
  return cloneRecord(value);
}

function mergeReconciledBaseline(reconciled, semantic) {
  if (!reconciled) return cloneRecord(semantic);
  return {
    ...cloneRecord(reconciled),
    ...cloneRecord(semantic),
    warehouse: cloneRecord(reconciled.warehouse ?? semantic.warehouse),
    mapProgress: cloneRecord(reconciled.mapProgress ?? semantic.mapProgress),
    mapMission: cloneRecord(reconciled.mapMission ?? semantic.mapMission),
    overlays: cloneRecord(reconciled.overlays ?? semantic.overlays),
    selectedItem: cloneRecord(reconciled.selectedItem ?? semantic.selectedItem),
    source: { ...(reconciled.source || {}), ...(semantic.source || {}) },
  };
}

class CdpRuntimeControlAdapter {
  constructor({ client, contextId, legacy }) {
    this.client = client;
    this.contextId = contextId;
    this.contextGeneration = String(contextId);
    this.legacy = legacy;
    this.readiness = null;
    this.cachedBaseline = null;
    this.fallbackReason = null;
    this.fallbackReadiness = null;
    this.readinessPromise = null;
    this.reconciledState = null;
    this.requiresBroadReconciliation = false;
  }

  async ready(signal = null) {
    assertNotAborted(signal);
    if (this.fallbackReadiness) return cloneRecord(this.fallbackReadiness);
    if (this.readiness) return cloneRecord(this.readiness);
    if (!this.readinessPromise) {
      this.readinessPromise = this.install(signal).finally(() => {
        this.readinessPromise = null;
      });
    }
    return waitForAbortable(this.readinessPromise, signal);
  }

  async install(signal = null) {
    try {
      const installed = await this.client.evaluate(
        buildBridgeInstallExpression(this.contextGeneration),
        this.contextId,
        { signal },
      );
      const handshake = validateHandshake(installed?.handshake, this.contextGeneration);
      const semanticBaseline = validateBaseline(installed?.baseline);
      this.reconciledState = validateBaseline(await this.legacy.readState(signal));
      this.cachedBaseline = mergeReconciledBaseline(this.reconciledState, semanticBaseline);
      this.readiness = {
        adapterId: "semantic-cdp",
        contextId: this.contextId,
        ...handshake,
      };
      return cloneRecord(this.readiness);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      this.fallbackReason = error?.code || "RUNTIME_CONTROL_INSTALL_FAILED";
      this.fallbackReadiness = await this.legacy.ready(signal);
      return cloneRecord(this.fallbackReadiness);
    }
  }

  async readState(signal = null) {
    assertNotAborted(signal);
    await this.ready(signal);
    if (this.fallbackReason) return this.legacy.readState(signal);
    if (this.requiresBroadReconciliation) {
      this.reconciledState = validateBaseline(await this.legacy.readState(signal));
      this.requiresBroadReconciliation = false;
      return cloneRecord(this.reconciledState);
    }
    if (this.cachedBaseline) {
      const baseline = this.cachedBaseline;
      this.cachedBaseline = null;
      return cloneRecord(baseline);
    }
    try {
      const baseline = validateBaseline(await this.client.evaluate(
        "globalThis.miniGameCtl.readBaseline()",
        this.contextId,
        { signal },
      ));
      return mergeReconciledBaseline(this.reconciledState, baseline);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      this.fallbackReason = error?.code || "RUNTIME_CONTROL_BASELINE_FAILED";
      this.fallbackReadiness = await this.legacy.ready(signal);
      this.readiness = null;
      return this.legacy.readState(signal);
    }
  }

  execute(command, request = {}) {
    this.cachedBaseline = null;
    this.requiresBroadReconciliation = true;
    return this.legacy.execute(command, request);
  }

  status() {
    const handshake = this.readiness || {};
    return {
      adapterId: this.fallbackReason ? "legacy-cdp" : "semantic-cdp",
      ready: !!this.readiness && !this.fallbackReason,
      protocolVersion: handshake.protocolVersion ?? null,
      bridgeVersion: handshake.bridgeVersion ?? null,
      gameFingerprint: handshake.gameFingerprint ?? null,
      contextGeneration: handshake.contextGeneration ?? this.contextGeneration,
      revision: handshake.revision ?? null,
      capabilities: cloneRecord(handshake.capabilities || {}),
      fallback: { active: !!this.fallbackReason, reason: this.fallbackReason },
    };
  }
}

/**
 * Legacy Adapter for the Runtime Semantic Control Bridge interface.
 * Runtime-specific discovery and atomic executors stay behind this seam.
 */
class LegacyRuntimeControlAdapter {
  constructor({ lab, selection, collectState, onWarehouseInventoryInvalidated = null }) {
    this.lab = lab;
    this.selection = selection;
    this.collectState = collectState;
    this.onWarehouseInventoryInvalidated = onWarehouseInventoryInvalidated;
  }

  async ready(signal = null) {
    assertNotAborted(signal);
    return {
      adapterId: "legacy-cdp",
      contextId: this.selection.probe.context.id,
      capabilities: ["state", "board", "order", "navigation", "map-mission", "warehouse", "production-mode", "sale"],
    };
  }

  async readState(signal = null) {
    const snapshot = await this.lab.snapshot(this.selection, { signal });
    let boardState = null;
    try {
      boardState = await this.lab.client.evaluate(BOARD_SCAN_EXPRESSION, this.selection.probe.context.id, { signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
    return buildGameState({ state: summarizeSnapshot(snapshot), boardState });
  }

  async execute(command, { signal = null, options = {} } = {}) {
    assertNotAborted(signal);
    if (!command?.type) throw Object.assign(new Error("runtime control command type is required"), { code: "RUNTIME_CONTROL_COMMAND_INVALID" });
    const contextId = this.selection.probe.context.id;
    const collectState = (nextSignal = null) => this.collectState(nextSignal);
    const settleMs = options.settleMs;
    const evaluateTimeoutMs = options.timeoutMs;

    if (command.type === "run-board-action") {
      const runner = new BoardAutomationRunner({
        client: this.lab.client,
        contextId,
        delayMs: options.delayMs,
        evaluateTimeoutMs,
      });
      return runner.run({ producer: command.producer, merge: command.merge, plannedAction: command.plannedAction, maxActions: 1, execute: true, signal });
    }
    if (command.type === "submit-order") {
      const submitter = new OrderSubmitter({ client: this.lab.client, contextId, collectState, settleMs, evaluateTimeoutMs });
      return submitter.submit(command.slot, { execute: true, signal, before: command.before });
    }
    if (command.type === "navigate") {
      const navigator = new SceneNavigator({ client: this.lab.client, contextId, settleMs, evaluateTimeoutMs });
      return navigator.go(command.target, { execute: true, signal });
    }
    if (command.type === "complete-map-mission") {
      const completer = new MapMissionCompleter({ client: this.lab.client, contextId, collectState, settleMs, evaluateTimeoutMs });
      return completer.complete({ execute: true, signal });
    }
    if (["preflight-warehouse-store", "store-to-warehouse", "load-warehouse-inventory", "retrieve-from-warehouse"].includes(command.type)) {
      const warehouse = new WarehouseActionExecutor({
        client: this.lab.client,
        contextId,
        collectState,
        settleMs,
        evaluateTimeoutMs,
        onInventoryKnowledgeInvalidated: this.onWarehouseInventoryInvalidated,
      });
      if (command.type === "preflight-warehouse-store") return warehouse.preflight(command.index, { signal });
      if (command.type === "store-to-warehouse") return warehouse.move(command.index, { execute: true, signal, preflight: command.preflight });
      if (command.type === "load-warehouse-inventory") return warehouse.loadInventory({ execute: true, signal });
      return warehouse.retrieve(command.action, { ...command.request, execute: true, signal });
    }
    if (command.type === "switch-production-mode") {
      const productionModes = new ProductionModeExecutor({ client: this.lab.client, contextId, settleMs, evaluateTimeoutMs });
      return productionModes.switch(command.index, command.modeId, { ...command.request, execute: true, signal });
    }
    if (command.type === "sell-item") {
      const sale = new SaleActionExecutor({ client: this.lab.client, contextId, collectState, settleMs, evaluateTimeoutMs });
      return sale.execute(command.suggestion, { confirmed: true, signal });
    }
    throw Object.assign(new Error(`unsupported runtime control command: ${command.type}`), {
      code: "RUNTIME_CONTROL_COMMAND_UNSUPPORTED",
      reason: "runtime-control-command-unsupported",
    });
  }
}

/**
 * In-memory Adapter for Automation Runtime scenarios. Script entries may be
 * records, Errors, or async functions receiving the command and AbortSignal.
 */
class FakeRuntimeControlAdapter {
  constructor({ states = [], results = [], readiness = null } = {}) {
    this.states = [...states];
    this.results = [...results];
    this.readiness = readiness || { adapterId: "fake-runtime-control", contextId: "fake-context", capabilities: ["state", "actions"] };
    this.commands = [];
    this.readCount = 0;
    this.readyCount = 0;
  }

  async ready(signal = null) {
    this.readyCount += 1;
    return resolveFakeEntry(this.readiness, { signal, adapter: this });
  }

  async readState(signal = null) {
    const index = this.readCount;
    this.readCount += 1;
    const entry = this.states[Math.min(index, this.states.length - 1)];
    if (entry == null) throw Object.assign(new Error("fake runtime control has no state"), { code: "FAKE_RUNTIME_CONTROL_STATE_MISSING" });
    return resolveFakeEntry(entry, { signal, readIndex: index, adapter: this });
  }

  async execute(command, { signal = null } = {}) {
    assertNotAborted(signal);
    const index = this.commands.length;
    this.commands.push(cloneRecord(command));
    const entry = this.results[index];
    if (entry == null) throw Object.assign(new Error(`fake runtime control has no result for ${command?.type || "unknown"}`), { code: "FAKE_RUNTIME_CONTROL_RESULT_MISSING" });
    return resolveFakeEntry(entry, { signal, command: cloneRecord(command), commandIndex: index, adapter: this });
  }
}

module.exports = {
  CdpRuntimeControlAdapter,
  FakeRuntimeControlAdapter,
  LegacyRuntimeControlAdapter,
  RUNTIME_CONTROL_BRIDGE_VERSION,
  RUNTIME_CONTROL_PROTOCOL_VERSION,
  abortError,
  buildBridgeInstallExpression,
};
