

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
const { randomUUID } = require("node:crypto");

const RUNTIME_CONTROL_PROTOCOL_VERSION = 1;
const RUNTIME_CONTROL_BRIDGE_VERSION = "1.1.0";

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
      && typeof existing.readBaseline === "function"
      && typeof existing.readBoard === "function"
      && typeof existing.executeCommand === "function") {
      return { handshake: existing.handshake(), baseline: existing.readBaseline() };
    }
    const runtimeGlobal = globalThis;
    const cc = runtimeGlobal.cc || runtimeGlobal.GameGlobal?.cc;
    const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };
    const isMap = (value) => value != null
      && typeof value.get === "function"
      && typeof value.values === "function"
      && typeof value.entries === "function";
    const mergeMethodsAvailable = (boardView) => typeof boardView?._operatorCenter?.itemCanMergeWith === "function"
      && typeof boardView?.canBoardGridBeDragging === "function"
      && typeof boardView?.isBoardGridItemAnimating === "function"
      && typeof boardView?.onDragStart === "function"
      && typeof boardView?.onDragMove === "function"
      && typeof boardView?.onDragEnd === "function";
    const boardControllerCandidates = (runtime) => runtime.mControllers
      .filter((item) => item?._controllerClazzName === "UserBoardViewController");
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
      const boardCandidates = boardControllerCandidates(runtime);
      const boardController = boardCandidates.length === 1 ? boardCandidates[0] : null;
      const boardView = boardController?.view?._boardView?._gameBoardView;
      const gameBoard = boardView?._boardStore?._state?._gameBoard;
      const boardRead = Array.isArray(gameBoard?.__private_95_grids);
      const merge = boardRead && mergeMethodsAvailable(boardView);
      return {
        baseline: resourceRead && energyRead && orderRead && boardRead,
        boardRead,
        resourceRead,
        energyRead,
        orderRead,
        merge,
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
    let revision = 0;
    let eventRevision = 0;
    const eventQueue = [];
    const MAX_EVENT_QUEUE = 256;
    const completedOperations = new Map();
    const inFlightOperations = new Map();
    let cachedMergeContext = null;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const publishBinding = typeof globalThis.__miniGameCtlEventBinding === "function"
      ? (payload) => { try { globalThis.__miniGameCtlEventBinding(JSON.stringify(payload)); } catch (_) {} }
      : null;
    const publishEvent = (eventType, operationId, delta) => {
      eventRevision += 1;
      const event = Object.freeze({
        generation: contextGeneration,
        revision: eventRevision,
        eventType,
        operationId: operationId ?? null,
        delta: clone(delta),
        timestamp: new Date().toISOString()
      });
      eventQueue.push(event);
      while (eventQueue.length > MAX_EVENT_QUEUE) eventQueue.shift();
      if (publishBinding) publishBinding(event);
    };
    const drainEventQueue = (sinceRevision) => {
      const since = Number.isInteger(sinceRevision) ? sinceRevision : -1;
      return clone(eventQueue.filter((event) => event.revision > since));
    };
    const invalidateMergeContext = () => {
      cachedMergeContext = null;
      publishEvent("cache-invalidated", null, { scope: "merge-context" });
    };
    const resolveMergeContext = () => {
      const { runtime } = resolveRuntime();
      const candidates = boardControllerCandidates(runtime);
      const cachedBoardView = cachedMergeContext?.controller?.view?._boardView?._gameBoardView;
      const cachedGameBoard = cachedBoardView?._boardStore?._state?._gameBoard;
      if (candidates.length === 1
        && candidates[0] === cachedMergeContext?.controller
        && cachedBoardView === cachedMergeContext?.boardView
        && cachedGameBoard === cachedMergeContext?.gameBoard
        && cachedGameBoard?.__private_95_grids === cachedMergeContext?.grids
        && Array.isArray(cachedMergeContext?.grids)
        && mergeMethodsAvailable(cachedBoardView)) {
        return cachedMergeContext;
      }
      const controller = candidates.length === 1 ? candidates[0] : null;
      const boardView = controller?.view?._boardView?._gameBoardView;
      const gameBoard = boardView?._boardStore?._state?._gameBoard;
      const grids = gameBoard?.__private_95_grids;
      if (!controller || !boardView || !Array.isArray(grids) || !mergeMethodsAvailable(boardView)) {
        cachedMergeContext = null;
        return null;
      }
      cachedMergeContext = { controller, boardView, gameBoard, grids };
      return cachedMergeContext;
    };
    const gridIndex = (grid, fallback) => Number.isInteger(Number(grid?.index))
      ? Number(grid.index)
      : fallback;
    const findGrid = (grids, index) => grids.find((grid, position) => gridIndex(grid, position) === index);
    const gridDelta = (grid, index) => ({
      index: gridIndex(grid, index),
      itemId: String(safe(() => grid?.itemId, "")),
      empty: !!safe(() => grid?.isEmpty, true)
    });
    const boardSummary = (context) => {
      const grids = context.grids;
      return {
        signature: grids.map((grid) => String(safe(() => grid?.itemId, ""))).join("|"),
        occupied: grids.filter((grid) => !safe(() => grid?.isEmpty, true)).length,
        empty: grids.filter((grid) => safe(() => grid?.isEmpty, true)).length
      };
    };
    const readBoard = () => {
      const context = resolveMergeContext();
      if (!context) return { ok: false, reason: "merge-runtime-unavailable", grids: [] };
      return {
        ok: true,
        revision,
        visible: !!context.controller.isViewVisible,
        width: safe(() => context.gameBoard.size.width, null),
        height: safe(() => context.gameBoard.size.height, null),
        ...boardSummary(context),
        grids: context.grids.map((grid, index) => gridDelta(grid, index))
      };
    };
    const cacheAcknowledgement = (operationId, acknowledgement) => {
      completedOperations.set(operationId, clone(acknowledgement));
      while (completedOperations.size > 128) completedOperations.delete(completedOperations.keys().next().value);
      return clone(acknowledgement);
    };
    const acknowledgementBase = (command, changed) => ({
      operationId: command.operationId,
      method: command.method,
      expectedRevision: command.expectedRevision,
      revision,
      changed
    });
    const reject = (command, outcome, reason) => cacheAcknowledgement(command.operationId, {
      ...acknowledgementBase(command, false),
      ok: false,
      outcome,
      reason
    });
    const isGridReady = (boardView, grid) => !!safe(() => boardView.canBoardGridBeDragging(grid), false)
      && !safe(() => boardView.isBoardGridItemAnimating(grid), true);
    const executeCommandOnce = async (command) => {
      if (command.method !== "merge" || !capabilities.merge) {
        return reject(command, "unsupported-capability", "merge-unsupported");
      }
      if (!Number.isInteger(command.expectedRevision) || command.expectedRevision !== revision) {
        return reject(command, "stale-revision", "runtime-revision-stale");
      }
      const sourceIndex = Number(command.sourceGrid);
      const targetIndex = Number(command.targetGrid);
      if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex) || sourceIndex === targetIndex) {
        return reject(command, "rejected-precondition", "merge-grid-invalid");
      }
      const context = resolveMergeContext();
      if (!context) return reject(command, "unsupported-capability", "merge-runtime-unavailable");
      if (!context.controller.isViewVisible) return reject(command, "rejected-precondition", "board-not-visible");
      const source = findGrid(context.grids, sourceIndex);
      const target = findGrid(context.grids, targetIndex);
      if (!source || !target) return reject(command, "rejected-precondition", "merge-grid-not-found");
      const sourceItemId = String(safe(() => source.itemId, ""));
      const targetItemId = String(safe(() => target.itemId, ""));
      if (!sourceItemId || sourceItemId !== targetItemId
        || (command.expectedItemId != null && sourceItemId !== String(command.expectedItemId))) {
        return reject(command, "rejected-precondition", "merge-items-changed");
      }
      const sourceReady = isGridReady(context.boardView, source);
      const targetReady = isGridReady(context.boardView, target);
      if (!sourceReady || !targetReady) return reject(command, "rejected-precondition", "merge-not-ready");
      const expectedTarget = safe(() => source.item?.itemConfig?.MergeTarget, null);
      if (expectedTarget == null
        || (command.expectedResultItemId != null && String(expectedTarget) !== String(command.expectedResultItemId))) {
        return reject(command, "rejected-precondition", "merge-relation-changed");
      }
      if (!safe(() => context.boardView._operatorCenter.itemCanMergeWith(source.item, target.item), false)) {
        return reject(command, "rejected-precondition", "merge-pair-rejected");
      }
      const before = boardSummary(context);
      let actionError = null;
      try {
        context.boardView.onDragStart(source.center);
        context.boardView.onDragMove(source.center, target.center);
        await Promise.resolve(context.boardView.onDragEnd(source.center, target.center));
      } catch (error) {
        actionError = String(error?.message || error || "merge-action-error");
      }
      const after = boardSummary(context);
      const sourceAfter = gridDelta(findGrid(context.grids, sourceIndex), sourceIndex);
      const targetAfter = gridDelta(findGrid(context.grids, targetIndex), targetIndex);
      const changed = before.signature !== after.signature;
      const verified = changed && sourceAfter.empty && String(targetAfter.itemId) === String(expectedTarget);
      if (verified && !actionError) {
        revision += 1;
        const acknowledgement = {
          ...acknowledgementBase(command, true),
          ok: true,
          outcome: "accepted-changed",
          reason: "merge-complete",
          delta: {
            board: {
              ...after,
              grids: [sourceAfter, targetAfter]
            }
          }
        };
        publishEvent("state-changed", command.operationId, acknowledgement.delta);
        return cacheAcknowledgement(command.operationId, acknowledgement);
      }
      if (!changed && !actionError) {
        return cacheAcknowledgement(command.operationId, {
          ...acknowledgementBase(command, false),
          ok: false,
          outcome: "accepted-unchanged",
          reason: "merge-unchanged",
          delta: { board: { ...after, grids: [sourceAfter, targetAfter] } }
        });
      }
      if (changed) {
        revision += 1;
        publishEvent("state-changed", command.operationId, { board: { ...after, grids: [sourceAfter, targetAfter] } });
      }
      return cacheAcknowledgement(command.operationId, {
        ...acknowledgementBase(command, changed),
        ok: false,
        outcome: "uncertain-result",
        reason: "merge-result-uncertain",
        error: actionError,
        delta: { board: { ...after, grids: [sourceAfter, targetAfter] } }
      });
    };
    const executeCommand = (command) => {
      if (!command || typeof command !== "object" || typeof command.operationId !== "string" || !command.operationId) {
        return Promise.resolve({
          ok: false,
          outcome: "rejected-precondition",
          reason: "command-invalid",
          operationId: command?.operationId ?? null,
          method: command?.method ?? null,
          expectedRevision: command?.expectedRevision ?? null,
          revision,
          changed: false
        });
      }
      const completed = completedOperations.get(command.operationId);
      if (completed) return Promise.resolve(clone(completed));
      const inFlight = inFlightOperations.get(command.operationId);
      if (inFlight) return inFlight.then(clone);
      const pending = Promise.resolve().then(() => executeCommandOnce(command));
      inFlightOperations.set(command.operationId, pending);
      return pending.then(
        (acknowledgement) => {
          inFlightOperations.delete(command.operationId);
          return clone(acknowledgement);
        },
        (error) => {
          inFlightOperations.delete(command.operationId);
          throw error;
        },
      );
    };
    const bridge = Object.freeze({
      __runtimeSemanticControlBridge: true,
      contextGeneration,
      handshake: () => ({
        protocolVersion: ${protocolVersion},
        bridgeVersion: ${bridgeVersion},
        gameFingerprint,
        contextGeneration,
        revision,
        capabilities: { ...capabilities }
      }),
      readBaseline,
      readBoard,
      executeCommand,
      drainEventQueue,
      invalidateMergeContext
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

function mergeDeltaInvariantComplete(acknowledgement, command) {
  const board = acknowledgement?.delta?.board;
  const grids = board?.grids;
  if (acknowledgement?.ok !== true
    || acknowledgement.outcome !== "accepted-changed"
    || acknowledgement.changed !== true
    || acknowledgement.method !== "merge"
    || acknowledgement.expectedRevision !== command.expectedRevision
    || acknowledgement.revision !== command.expectedRevision + 1
    || typeof board?.signature !== "string"
    || !Number.isInteger(board?.occupied)
    || !Number.isInteger(board?.empty)
    || !Array.isArray(grids)) return false;
  const source = grids.find((grid) => Number(grid?.index) === command.sourceGrid);
  const target = grids.find((grid) => Number(grid?.index) === command.targetGrid);
  if (!source || source.empty !== true || String(source.itemId || "") !== "") return false;
  if (!target || target.empty !== false || !String(target.itemId || "")) return false;
  return command.expectedResultItemId == null
    || String(target.itemId) === String(command.expectedResultItemId);
}

function targetedMergeInvariantComplete(board, command) {
  if (!board?.ok || !Array.isArray(board.grids)) return false;
  const source = board.grids.find((grid) => Number(grid?.index) === command.sourceGrid);
  const target = board.grids.find((grid) => Number(grid?.index) === command.targetGrid);
  if (!source || source.empty !== true || String(source.itemId || "") !== "") return false;
  if (!target || target.empty !== false || !String(target.itemId || "")) return false;
  return command.expectedResultItemId == null
    || String(target.itemId) === String(command.expectedResultItemId);
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
    this.appliedEventRevision = -1;
    this.bindingListener = null;
    this.eventsSinceLastRead = [];
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
      this._enableEvents();
      return cloneRecord(this.readiness);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      this.fallbackReason = error?.code || "RUNTIME_CONTROL_INSTALL_FAILED";
      this.fallbackReadiness = await this.legacy.ready(signal);
      return cloneRecord(this.fallbackReadiness);
    }
  }

  _enableEvents() {
    if (this.bindingListener) return;
    if (typeof this.client.on !== "function") return;
    if (typeof this.client.send !== "function") return;
    this.bindingListener = (message) => {
      if (message.method !== "Runtime.bindingCalled") return;
      const payload = message.params?.payload;
      if (typeof payload !== "string") return;
      let event;
      try { event = JSON.parse(payload); } catch (_) { return; }
      this._applyEvent(event);
    };
    this.client.on("event", this.bindingListener);
    this.client.send("Runtime.addBinding", { name: "miniGameCtl.event" })
      .catch(() => {});
  }

  _disableEvents() {
    if (!this.bindingListener) return;
    this.client.off("event", this.bindingListener);
    this.bindingListener = null;
  }

  _applyEvent(event) {
    if (!event || typeof event !== "object"
      || !Number.isInteger(event.revision)
      || typeof event.generation !== "string"
      || typeof event.eventType !== "string") return;
    if (event.generation !== this.contextGeneration) {
      this.requiresBroadReconciliation = true;
      return;
    }
    if (event.revision <= this.appliedEventRevision) return;
    if (event.revision > this.appliedEventRevision + 1 && this.appliedEventRevision >= 0) {
      this.requiresBroadReconciliation = true;
      return;
    }
    this.appliedEventRevision = event.revision;
    this.eventsSinceLastRead.push(cloneRecord(event));
    while (this.eventsSinceLastRead.length > 64) this.eventsSinceLastRead.shift();
    if (event.eventType === "cache-invalidated") {
      this.requiresBroadReconciliation = true;
    }
    if (event.eventType === "state-changed"
      && Number.isInteger(event.delta?.board?.revision)) {
      if (this.readiness) this.readiness.revision = event.delta.board.revision;
    }
  }

  async recoverEventGap(signal = null) {
    assertNotAborted(signal);
    // Level 1: drain event queue from last applied revision
    try {
      const events = await this.client.evaluate(
        `globalThis.miniGameCtl.drainEventQueue(${this.appliedEventRevision})`,
        this.contextId,
        { signal },
      );
      if (Array.isArray(events)) {
        for (const event of events) {
          if (event.revision > this.appliedEventRevision) {
            this._applyEvent(event);
          }
        }
      }
      if (!this.requiresBroadReconciliation) return;
    } catch (_) { /* escalate to next recovery level */ }
    // Level 2: targeted board read
    try {
      const board = await this.client.evaluate(
        "globalThis.miniGameCtl.readBoard()",
        this.contextId,
        { signal },
      );
      if (board?.ok && Number.isInteger(board.revision)) {
        if (this.readiness) this.readiness.revision = board.revision;
        this.requiresBroadReconciliation = false;
        return;
      }
    } catch (_) { /* escalate to baseline */ }
    // Level 3: baseline read
    try {
      const baseline = await this.client.evaluate(
        "globalThis.miniGameCtl.readBaseline()",
        this.contextId,
        { signal },
      );
      validateBaseline(baseline);
      if (this.readiness) this.readiness.revision = this.readiness.revision ?? 0;
      this.requiresBroadReconciliation = false;
      return;
    } catch (_) { /* escalate to broad snapshot */ }
    // Level 4: broad snapshot via legacy adapter
    this.reconciledState = validateBaseline(await this.legacy.readState(signal));
    this.requiresBroadReconciliation = false;
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

  async execute(command, request = {}) {
    const signal = request.signal || null;
    assertNotAborted(signal);
    await this.ready(signal);
    const merge = command?.plannedAction?.type === "merge"
      ? command.plannedAction
      : command?.merge;
    const canUseSemanticMerge = !this.fallbackReason
      && this.readiness?.capabilities?.merge === true
      && command?.type === "run-board-action"
      && merge != null;
    if (!canUseSemanticMerge) {
      this.cachedBaseline = null;
      this.requiresBroadReconciliation = true;
      return this.legacy.execute(command, request);
    }
    const sourceGrid = Number(merge.from);
    const targetGrid = Number(merge.to);
    if (!Number.isInteger(sourceGrid) || !Number.isInteger(targetGrid) || sourceGrid === targetGrid) {
      throw Object.assign(new Error("semantic merge requires distinct integer grid indexes"), {
        code: "RUNTIME_CONTROL_COMMAND_INVALID",
        reason: "merge-grid-invalid",
      });
    }
    const operationId = String(command.operationId || `merge-${randomUUID()}`);
    const expectedRevision = command.expectedRevision == null
      ? this.readiness.revision
      : Number(command.expectedRevision);
    const semanticCommand = {
      operationId,
      expectedRevision,
      method: "merge",
      sourceGrid,
      targetGrid,
      expectedItemId: merge.itemId == null ? null : String(merge.itemId),
      expectedResultItemId: merge.resultItemId == null
        ? merge.expectedTarget == null ? null : String(merge.expectedTarget)
        : String(merge.resultItemId),
    };
    this.cachedBaseline = null;
    const expression = `globalThis.miniGameCtl.executeCommand(${JSON.stringify(semanticCommand)})`;
    let acknowledgement = null;
    let deliveryError = null;
    for (let attempt = 0; attempt < 2 && acknowledgement == null; attempt += 1) {
      try {
        acknowledgement = await this.client.evaluate(expression, this.contextId, { signal });
      } catch (error) {
        if (error?.name === "AbortError") {
          this.requiresBroadReconciliation = true;
          acknowledgement = {
            ok: false,
            outcome: "aborted",
            reason: "semantic-merge-aborted-after-dispatch",
            operationId,
            method: "merge",
            expectedRevision,
            revision: this.readiness.revision,
            changed: null,
          };
          break;
        }
        deliveryError = error;
      }
    }
    if (acknowledgement == null) {
      acknowledgement = {
        ok: false,
        outcome: "bridge-failure",
        reason: "semantic-merge-acknowledgement-lost",
        operationId,
        method: "merge",
        expectedRevision,
        revision: this.readiness.revision,
        changed: null,
        error: deliveryError?.message || String(deliveryError || "unknown bridge failure"),
      };
    }
    const acknowledgementEnvelopeValid = acknowledgement
      && typeof acknowledgement === "object"
      && acknowledgement.operationId === operationId
      && Number.isInteger(acknowledgement.revision)
      && typeof acknowledgement.outcome === "string"
      && typeof acknowledgement.reason === "string";
    if (!acknowledgementEnvelopeValid) {
      acknowledgement = {
        ok: false,
        outcome: "bridge-failure",
        reason: "semantic-merge-acknowledgement-invalid",
        operationId,
        method: "merge",
        expectedRevision,
        revision: this.readiness.revision,
        changed: null,
      };
    }
    this.readiness.revision = acknowledgement.revision;
    if (acknowledgement.outcome === "aborted") {
      return {
        ok: false,
        executed: true,
        reason: acknowledgement.reason,
        stopReason: acknowledgement.reason,
        actions: [],
        uncertainAction: { type: "merge", from: sourceGrid, to: targetGrid },
        pauseRequested: false,
        acknowledgement: cloneRecord(acknowledgement),
      };
    }
    if (acknowledgement.outcome === "stale-revision") {
      this.requiresBroadReconciliation = false;
      const replanState = await this.readState(signal);
      return {
        ok: false,
        executed: false,
        reason: acknowledgement.reason,
        stopReason: acknowledgement.reason,
        actions: [],
        replanRequested: true,
        replanState,
        acknowledgement: cloneRecord(acknowledgement),
      };
    }
    const deltaInvariantComplete = mergeDeltaInvariantComplete(acknowledgement, semanticCommand);
    const action = {
      step: 1,
      type: "merge",
      from: sourceGrid,
      to: targetGrid,
      itemId: semanticCommand.expectedItemId,
      expectedTarget: semanticCommand.expectedResultItemId,
      actualTarget: acknowledgement.delta?.board?.grids
        ?.find((grid) => Number(grid.index) === targetGrid)?.itemId ?? null,
      verified: deltaInvariantComplete,
    };
    if (deltaInvariantComplete) {
      this.requiresBroadReconciliation = false;
      return {
        ok: true,
        executed: true,
        reason: acknowledgement.reason,
        stopReason: "max_actions_reached",
        actions: [action],
        acknowledgement: cloneRecord(acknowledgement),
      };
    }
    let targetedVerification = null;
    const uncertaintyReason = acknowledgement.outcome === "accepted-changed"
      ? "semantic-merge-acknowledgement-incomplete"
      : ["uncertain-result", "bridge-failure"].includes(acknowledgement.outcome)
        ? acknowledgement.reason
        : null;
    if (uncertaintyReason) {
      try {
        targetedVerification = await this.client.evaluate(
          "globalThis.miniGameCtl.readBoard()",
          this.contextId,
          { signal },
        );
        const target = targetedVerification?.grids
          ?.find((grid) => Number(grid.index) === targetGrid);
        if (Number.isInteger(targetedVerification?.revision)) {
          this.readiness.revision = targetedVerification.revision;
        }
        if (targetedMergeInvariantComplete(targetedVerification, semanticCommand)) {
          this.requiresBroadReconciliation = false;
          return {
            ok: true,
            executed: true,
            reason: "merge-complete-after-targeted-verification",
            stopReason: "max_actions_reached",
            actions: [{ ...action, actualTarget: target.itemId, verified: true }],
            acknowledgement: cloneRecord(acknowledgement),
            targetedVerification: cloneRecord(targetedVerification),
          };
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        targetedVerification = {
          ok: false,
          reason: "targeted-board-verification-failed",
          error: error?.message || String(error),
          grids: [],
        };
      }
      return {
        ok: false,
        executed: true,
        reason: uncertaintyReason,
        stopReason: uncertaintyReason,
        actions: [],
        uncertainAction: action,
        pauseRequested: true,
        acknowledgement: cloneRecord(acknowledgement),
        targetedVerification: cloneRecord(targetedVerification),
      };
    }
    return {
      ok: false,
      executed: !["rejected-precondition", "unsupported-capability"].includes(acknowledgement.outcome),
      reason: acknowledgement.reason,
      stopReason: acknowledgement.reason,
      actions: [],
      uncertainAction: null,
      pauseRequested: false,
      acknowledgement: cloneRecord(acknowledgement),
      targetedVerification: cloneRecord(targetedVerification),
    };
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
      eventBinding: { active: !!this.bindingListener, appliedRevision: this.appliedEventRevision },
    };
  }

  shutdown() {
    this._disableEvents();
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
