

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
const RUNTIME_CONTROL_BRIDGE_VERSION = "1.2.0";

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

function createRuntimeControlDiagnostics() {
  return {
    semanticCommands: 0,
    runtimeEvents: 0,
    targetedReads: 0,
    baselineReads: 0,
    broadSnapshots: 0,
    fallbacks: 0,
    resyncs: 0,
    confirmationPaths: { delta: 0, targeted: 0, event: 0, legacy: 0 },
    confirmationLatencyMs: { count: 0, total: 0, max: 0, last: 0 },
  };
}

function recordRuntimeControlLatency(diagnostics, startedAt) {
  const elapsed = Math.max(0, Date.now() - startedAt);
  const latency = diagnostics.confirmationLatencyMs;
  latency.count += 1;
  latency.total += elapsed;
  latency.max = Math.max(latency.max, elapsed);
  latency.last = elapsed;
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
      const production = boardRead && typeof boardView?.onTouch === "function";
      const orderSubmission = (() => {
        try {
          const controller = boardController;
          const taskView = controller?.view?._boardView?._taskView;
          if (!taskView) return false;
          const buttonLayer = (taskView.childViews || []).find(
            (layer) => layer?.type === 6 && isMap(layer?.taskItemMap)
          );
          if (!buttonLayer) return false;
          const buttonMap = buttonLayer.taskItemMap;
          // Iterate Map safely across context boundaries via entries()
          for (const [, btn] of buttonMap.entries()) {
            if (typeof btn?.submitTask === "function") return true;
          }
          return false;
        } catch (_) { return false; }
      })();
      return {
        baseline: resourceRead && energyRead && orderRead && boardRead,
        boardRead,
        resourceRead,
        energyRead,
        orderRead,
        merge,
        production,
        orderSubmission,
        navigation: (() => {
          try {
            const mapCtrl = controllers.find((c) => c?._controllerClazzName === "FieldMapMainViewController");
            const entranceCtrl = controllers.find((c) => c?._controllerClazzName === "EntranceViewController");
            const boardToMap = typeof boardController?.view?._boardView?.onMapButtonClick === "function";
            const mapToBoard = typeof entranceCtrl?.view?.onBoardClick === "function";
            return !!(boardToMap && mapToBoard);
          } catch (_) { return false; }
        })()
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
      const boardHasSubstance = boardAvailable && grids.length > 0 && !grids.every((grid) => grid.empty);
      const energyAmount = resourceAmount(3);
      return {
        schemaVersion: 1,
        collectedAt: new Date().toISOString(),
        scene: (boardVisible || boardHasSubstance) ? "board" : "map",
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
    const resolveNavigationContext = () => {
      const { runtime } = resolveRuntime();
      const controllers = runtime.mControllers;
      const mapController = controllers.find((c) => c?._controllerClazzName === "FieldMapMainViewController");
      const boardController = controllers.find((c) => c?._controllerClazzName === "UserBoardViewController");
      const entranceController = controllers.find((c) => c?._controllerClazzName === "EntranceViewController");
      const missionController = controllers.find((c) => c?._controllerClazzName === "AreaMissionInfoViewController");
      // Trust board data when available even if isViewVisible returns false (e.g. overlays).
      const boardGrids = boardController?.view?._boardView?._gameBoardView?._boardStore?._state?._gameBoard?.__private_95_grids;
      const boardHasSubstance = Array.isArray(boardGrids) && boardGrids.some((grid) => !grid.isEmpty);
      return {
        mapController, boardController, entranceController, missionController,
        mapVisible: !!mapController?.isViewVisible,
        boardVisible: (!!boardController?.isViewVisible) || boardHasSubstance,
        entranceVisible: !!entranceController?.isViewVisible,
        missionVisible: !!missionController?.isViewVisible,
        scene: (!!boardController?.isViewVisible || boardHasSubstance) ? "board" : (!!mapController?.isViewVisible ? "map" : "unknown")
      };
    };
    const readGameplayArea = () => {
      const ctx = resolveNavigationContext();
      return {
        scene: ctx.scene,
        mapVisible: ctx.mapVisible,
        boardVisible: ctx.boardVisible,
        entranceVisible: ctx.entranceVisible,
        missionVisible: ctx.missionVisible,
        revision
      };
    };
    const executeNavigationCommand = async (command) => {
      const target = command.target;
      if (target !== "board" && target !== "map") {
        return reject(command, "rejected-precondition", "navigation-target-invalid");
      }
      if (!Number.isInteger(command.expectedRevision) || command.expectedRevision !== revision) {
        return reject(command, "stale-revision", "runtime-revision-stale");
      }
      const ctx = resolveNavigationContext();
      const alreadyThere = target === "board" ? ctx.boardVisible : (ctx.mapVisible && !ctx.boardVisible);
      if (alreadyThere) {
        return cacheAcknowledgement(command.operationId, {
          ...acknowledgementBase(command, false),
          ok: true,
          outcome: "accepted-unchanged",
          reason: "navigation-already-there",
          delta: { scene: ctx.scene, boardVisible: ctx.boardVisible, mapVisible: ctx.mapVisible }
        });
      }
      if (target === "board") {
        if (!ctx.entranceVisible) {
          return reject(command, "rejected-precondition", "navigation-entrance-not-visible");
        }
        if (typeof ctx.entranceController?.view?.onBoardClick !== "function") {
          return reject(command, "unsupported-capability", "navigation-board-entrance-missing");
        }
        if (ctx.missionVisible && typeof ctx.missionController?.hideByCloseBtn === "function") {
          try { ctx.missionController.hideByCloseBtn(); } catch (_) {}
        }
        try {
          ctx.entranceController.view.onBoardClick();
        } catch (error) {
          return reject(command, "bridge-failure", "navigation-board-action-failed");
        }
      } else {
        if (!ctx.boardVisible) {
          return reject(command, "rejected-precondition", "navigation-board-not-visible");
        }
        if (typeof ctx.boardController?.view?._boardView?.onMapButtonClick !== "function") {
          return reject(command, "unsupported-capability", "navigation-map-button-missing");
        }
        try {
          ctx.boardController.view._boardView.onMapButtonClick();
        } catch (error) {
          return reject(command, "bridge-failure", "navigation-map-action-failed");
        }
      }
      revision += 1;
      invalidateMergeContext();
      publishEvent("cache-invalidated", command.operationId, { scope: "navigation-context" });
      const after = resolveNavigationContext();
      const arrived = target === "board" ? after.boardVisible : (after.mapVisible && !after.boardVisible);
      const acknowledgement = {
        ...acknowledgementBase(command, arrived),
        ok: true,
        outcome: arrived ? "accepted-changed" : "uncertain-result",
        reason: arrived ? "navigation-complete" : "navigation-dispatched-awaiting-verification",
        delta: {
          scene: after.scene,
          beforeScene: ctx.scene,
          boardVisible: after.boardVisible,
          mapVisible: after.mapVisible,
          entranceVisible: after.entranceVisible,
          missionVisible: after.missionVisible
        }
      };
      if (arrived) {
        publishEvent("state-changed", command.operationId, acknowledgement.delta);
      }
      return cacheAcknowledgement(command.operationId, acknowledgement);
    };
    const enumerateButtons = () => {
      const MAX_BUTTONS = 64;
      const { currentScene } = resolveRuntime();
      const buttons = [];
      const computeScreenBounds = (node) => {
        try {
          const transform = node.getComponent?.(cc.UITransform) || node._uiTransformComponent;
          const worldPos = node.worldPosition
            || (typeof node.getWorldPosition === "function" ? node.getWorldPosition() : null)
            || node.position || {};
          return {
            x: Number(worldPos.x ?? worldPos._x ?? 0),
            y: Number(worldPos.y ?? worldPos._y ?? 0),
            width: Number(transform?.width ?? node.width ?? 0),
            height: Number(transform?.height ?? node.height ?? 0),
          };
        } catch (_) { return { x: 0, y: 0, width: 0, height: 0 }; }
      };
      const nodeActive = (node) => {
        try { return node?.activeInHierarchy === true && node?.active !== false; } catch (_) { return false; }
      };
      const context = resolveNavigationContext();
      const walk = (node, depth) => {
        if (!node || depth > 32 || buttons.length >= MAX_BUTTONS) return;
        const components = Array.isArray(node._components) ? node._components : [];
        for (const comp of components) {
          if (buttons.length >= MAX_BUTTONS) return;
          if (!comp) continue;
          const isButton = comp.interactable !== undefined
            && (Array.isArray(comp.clickEvents) || comp.clickEvents != null);
          if (!isButton) continue;
          buttons.push({
            nodeName: safe(() => node.name, ""),
            activeInHierarchy: nodeActive(node),
            interactable: !!safe(() => comp.interactable, false),
            handlerCount: Array.isArray(comp.clickEvents) ? comp.clickEvents.length : 0,
            handlers: (Array.isArray(comp.clickEvents) ? comp.clickEvents : []).slice(0, 8).map((h) => ({
              targetName: safe(() => h?.target?.name, null),
              component: safe(() => h?.component, null),
              handler: safe(() => h?.handler, null),
              customEventData: safe(() => h?.customEventData, null),
            })),
            screenBounds: computeScreenBounds(node),
            inCurrentGameplayArea: context.boardVisible || context.mapVisible,
          });
        }
        const children = Array.isArray(node.children) ? node.children
          : (Array.isArray(node._children) ? node._children : []);
        for (const child of children) walk(child, depth + 1);
      };
      walk(currentScene, 0);
      return {
        scope: "current-scene-observation",
        count: buttons.length,
        truncated: buttons.length >= MAX_BUTTONS,
        buttons,
      };
    };
    const resolveButtonTarget = (buttons, hint) => {
      if (!hint || typeof hint !== "object") return { resolved: false, reason: "no-hint" };
      const matches = buttons.filter((btn) => {
        if (!btn.activeInHierarchy || !btn.interactable) return false;
        if (!btn.inCurrentGameplayArea) return false;
        if (hint.nodeName != null && btn.nodeName !== hint.nodeName) return false;
        if (hint.handlerComponent != null
          && !btn.handlers.some((h) => h.component === hint.handlerComponent)) return false;
        if (hint.handlerName != null
          && !btn.handlers.some((h) => h.handler === hint.handlerName)) return false;
        if (hint.targetName != null
          && !btn.handlers.some((h) => h.targetName === hint.targetName)) return false;
        return true;
      });
      if (matches.length === 0) return { resolved: false, reason: "no-matching-button" };
      if (matches.length > 1) return { resolved: false, reason: "ambiguous-buttons", candidates: matches.map((m) => m.nodeName) };
      return { resolved: true, button: matches[0] };
    };
    const locateButtonComponent = (nodeName) => {
      if (!nodeName) return null;
      const { currentScene } = resolveRuntime();
      const find = (node, depth) => {
        if (!node || depth > 32) return null;
        if (node.name === nodeName && Array.isArray(node._components)) {
          for (const comp of node._components) {
            if (comp && comp.interactable !== undefined
              && (Array.isArray(comp.clickEvents) || comp.clickEvents != null)) {
              return { node, component: comp };
            }
          }
        }
        const children = Array.isArray(node.children) ? node.children
          : (Array.isArray(node._children) ? node._children : []);
        for (const child of children) {
          const found = find(child, depth + 1);
          if (found) return found;
        }
        return null;
      };
      return find(currentScene, 0);
    };
    const executeButtonFallback = async (command) => {
      if (!Number.isInteger(command.expectedRevision) || command.expectedRevision !== revision) {
        return reject(command, "stale-revision", "runtime-revision-stale");
      }
      if (command.method == null || command.target == null) {
        return reject(command, "rejected-precondition", "fallback-missing-method-or-target");
      }
      const allButtons = enumerateButtons();
      const hint = command.buttonHint || {};
      if (allButtons.count === 0) {
        return reject(command, "unsupported-capability", "fallback-no-buttons-in-scene");
      }
      const resolution = resolveButtonTarget(allButtons.buttons, hint);
      if (!resolution.resolved) {
        if (resolution.reason === "ambiguous-buttons") {
          return reject(command, "unsupported-capability", "fallback-ambiguous");
        }
        return reject(command, "rejected-precondition", "fallback-no-match");
      }
      const candidate = resolution.button;
      if (!candidate.activeInHierarchy) {
        return reject(command, "rejected-precondition", "fallback-button-inactive");
      }
      if (!candidate.interactable) {
        return reject(command, "rejected-precondition", "fallback-button-not-interactable");
      }
      if (candidate.handlerCount === 0) {
        return reject(command, "unsupported-capability", "fallback-no-handlers");
      }
      const located = locateButtonComponent(candidate.nodeName);
      if (!located) {
        return reject(command, "unsupported-capability", "fallback-locate-failed");
      }
      const { node, component } = located;
      const currentNodeActive = node?.activeInHierarchy === true && node?.active !== false;
      const currentInteractable = !!component?.interactable;
      if (!currentNodeActive) {
        return reject(command, "rejected-precondition", "fallback-button-located-inactive");
      }
      if (!currentInteractable) {
        return reject(command, "rejected-precondition", "fallback-button-located-not-interactable");
      }
      // Validate that the navigation target is reachable from the current gameplay area
      const ctx = resolveNavigationContext();
      if (command.method === "navigate") {
        const alreadyAtTarget = (command.target === "board" && ctx.boardVisible)
          || (command.target === "map" && ctx.mapVisible && !ctx.boardVisible);
        if (alreadyAtTarget) {
          return cacheAcknowledgement(command.operationId, {
            ...acknowledgementBase(command, false),
            ok: true,
            outcome: "accepted-unchanged",
            reason: "button-fallback-already-at-target",
            delta: { scene: ctx.scene, boardVisible: ctx.boardVisible, mapVisible: ctx.mapVisible }
          });
        }
        if (!ctx.mapVisible && !ctx.boardVisible) {
          return reject(command, "rejected-precondition", "fallback-no-gameplay-area");
        }
      }
      const handlerList = Array.isArray(component.clickEvents) ? component.clickEvents : [];
      const matchingHandler = handlerList.find((h) => {
        if (hint.handlerComponent != null && h?.component !== hint.handlerComponent) return false;
        if (hint.handlerName != null && h?.handler !== hint.handlerName) return false;
        if (hint.targetName != null && h?.target?.name !== hint.targetName) return false;
        return hint.handlerComponent != null || hint.handlerName != null || hint.targetName != null || true;
      }) || handlerList[0];
      let tier = null;
      let fallbackError = null;
      // Tier 1: invoke the handler through the component's emit or direct dispatch
      if (matchingHandler && matchingHandler.target && matchingHandler.component && matchingHandler.handler) {
        try {
          const targetComp = matchingHandler.target.getComponent
            ? matchingHandler.target.getComponent(matchingHandler.component)
            : null;
          if (targetComp && typeof targetComp[matchingHandler.handler] === "function") {
            targetComp[matchingHandler.handler](matchingHandler.customEventData);
            tier = "component-handler";
          }
        } catch (error) {
          fallbackError = String(error?.message || error || "component-handler-failed");
        }
      }
      // Tier 2: try node event emission
      if (tier == null) {
        try {
          if (typeof component?.emit === "function") {
            component.emit("click");
            tier = "node-event";
          } else if (typeof node?.emit === "function") {
            node.emit("click", component);
            tier = "node-event";
          }
        } catch (error) {
          fallbackError = fallbackError || String(error?.message || error || "node-event-failed");
        }
      }
      // Tier 3: coordinate input via touch simulation
      if (tier == null) {
        try {
          const bounds = candidate.screenBounds;
          if (bounds.width > 0 && bounds.height > 0) {
            const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
            const currentScene = safe(() => cc?.director?.getScene?.(), null);
            if (currentScene && typeof currentScene.emit === "function") {
              currentScene.emit("touchstart", center);
              currentScene.emit("touchend", center);
              tier = "coordinate-input";
            }
          }
        } catch (error) {
          fallbackError = fallbackError || String(error?.message || error || "coordinate-input-failed");
        }
      }
      if (tier == null) {
        return reject(command, "bridge-failure", fallbackError || "fallback-all-tiers-failed");
      }
      revision += 1;
      invalidateMergeContext();
      publishEvent("cache-invalidated", command.operationId, { scope: "button-fallback", tier });
      const after = resolveNavigationContext();
      const arrived = command.method === "navigate"
        ? (command.target === "board" ? after.boardVisible : (after.mapVisible && !after.boardVisible))
        : true;
      const acknowledgement = {
        ...acknowledgementBase(command, arrived),
        ok: true,
        outcome: arrived ? "accepted-changed" : "uncertain-result",
        reason: arrived ? "button-fallback-complete" : "button-fallback-dispatched-awaiting-verification",
        delta: {
          scene: after.scene,
          boardVisible: after.boardVisible,
          mapVisible: after.mapVisible,
          buttonFallback: { tier, nodeName: candidate.nodeName },
        }
      };
      if (arrived) {
        publishEvent("state-changed", command.operationId, acknowledgement.delta);
      }
      return cacheAcknowledgement(command.operationId, acknowledgement);
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
    const readOrderSlot = (slot) => {
      const { runtime } = resolveRuntime();
      const controller = (runtime.mControllers || []).find(
        (item) => item?._controllerClazzName === "UserBoardViewController"
      );
      const taskView = controller?.view?._boardView?._taskView;
      if (!controller || !taskView) return { ok: false, reason: "order-runtime-unavailable", slot };
      const taskItemData = taskView._taskItemDataMap?.get?.(slot);
      const task = taskItemData?.task;
      const items = Array.isArray(task?.itemInfos) ? task.itemInfos : [];
      const resourceManager = runtime.mManagers?.find?.((manager) => isMap(manager?._resourceMap));
      const coins = Number(resourceManager?._resourceMap?.get?.(1) ?? resourceManager?._resourceMap?.get?.("1") ?? 0) || 0;
      return {
        ok: true,
        slot,
        occupied: !!task,
        taskId: safe(() => task.taskId, null),
        ready: items.length > 0 && items.every((item) => !!item.isComplete),
        inSubmit: !!safe(() => task._inSubmit, false),
        coins,
        items: items.map((item) => ({
          itemId: String(safe(() => item.itemId, "")),
          complete: !!safe(() => item.isComplete, false),
        })),
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
    const isProducerGrid = (grid) => typeof safe(() => grid?.item?.produceCount) === "number"
      && Number(safe(() => grid?.item?.itemConfig?.EnergyCost, 0)) > 0;
    const executeProductionCommand = async (command) => {
      if (!Number.isInteger(command.expectedRevision) || command.expectedRevision !== revision) {
        return reject(command, "stale-revision", "runtime-revision-stale");
      }
      const producerIndex = Number(command.producerGrid);
      if (!Number.isInteger(producerIndex) || producerIndex < 0) {
        return reject(command, "rejected-precondition", "production-grid-invalid");
      }
      const { runtime } = resolveRuntime();
      const candidates = boardControllerCandidates(runtime);
      const controller = candidates.length === 1 ? candidates[0] : null;
      const boardView = controller?.view?._boardView?._gameBoardView;
      const gameBoard = boardView?._boardStore?._state?._gameBoard;
      const grids = gameBoard?.__private_95_grids;
      if (!controller || !boardView || !Array.isArray(grids)) {
        return reject(command, "unsupported-capability", "production-runtime-unavailable");
      }
      if (!controller.isViewVisible) {
        return reject(command, "rejected-precondition", "board-not-visible");
      }
      const producerGrid = findGrid(grids, producerIndex);
      if (!producerGrid || !isProducerGrid(producerGrid)) {
        return reject(command, "rejected-precondition", "producer-not-found");
      }
      if (Number(safe(() => producerGrid.item.produceCount, 0)) <= 0) {
        return reject(command, "rejected-precondition", "producer-exhausted");
      }
      const managers = runtime.mManagers;
      const resourceManager = managers.find((manager) => isMap(manager?._resourceMap));
      const energyAmount = Number(resourceManager?._resourceMap?.get?.(3) ?? resourceManager?._resourceMap?.get?.("3") ?? 0) || 0;
      const energyCost = Number(safe(() => producerGrid.item?.itemConfig?.EnergyCost, 0));
      if (energyAmount < energyCost) {
        return reject(command, "rejected-precondition", "energy-insufficient");
      }
      const multipleModeManager = managers.find((manager) => isMap(manager?._multipleModeMap));
      const productionModeCurrentFor = (grid) => {
        const raw = multipleModeManager?._multipleModeMap?.get?.(String(grid?.itemId))
          ?? multipleModeManager?._multipleModeMap?.get?.(Number(grid?.itemId))
          ?? multipleModeManager?._multipleModeMap?.get?.(grid?.index);
        return String(raw?.modeId ?? raw?.multiple ?? raw?.value ?? raw ?? "single");
      };
      if (command.expectedProductionModeId != null) {
        const currentModeId = productionModeCurrentFor(producerGrid);
        if (String(currentModeId) !== String(command.expectedProductionModeId)) {
          return reject(command, "rejected-precondition", "production-mode-mismatch");
        }
      }
      const currentModeId = productionModeCurrentFor(producerGrid);
      const expectedOutputs = currentModeId === "quad" ? 4 : currentModeId === "double" ? 2 : 1;
      const emptyCount = grids.filter((grid) => safe(() => grid.isEmpty, true)).length;
      if (emptyCount < expectedOutputs) {
        return reject(command, "rejected-precondition", "board-full");
      }
      const isProducerReady = (boardView, grid) => !safe(() => boardView?.isBoardGridItemAnimating?.(grid), true)
        && !safe(() => grid?.isLocking, false);
      if (!isProducerReady(boardView, producerGrid)) {
        return reject(command, "rejected-precondition", "producer-not-ready");
      }
      const beforeGrids = grids.map((grid, index) => gridDelta(grid, index));
      const beforeSignature = beforeGrids.map((grid) => grid.itemId).join("|");
      let actionError = null;
      let touches = 0;
      try {
        boardView.onTouch(producerGrid.center);
        touches = 1;
        await Promise.resolve();
        const afterFirstSignature = grids.map((grid) => String(safe(() => grid?.itemId, ""))).join("|");
        if (afterFirstSignature === beforeSignature) {
          boardView.onTouch(producerGrid.center);
          touches = 2;
        }
      } catch (error) {
        actionError = String(error?.message || error || "production-action-error");
      }
      const afterGrids = grids.map((grid, index) => gridDelta(grid, index));
      const afterSignature = afterGrids.map((grid) => grid.itemId).join("|");
      const changed = beforeSignature !== afterSignature;
      const producedItemIds = [];
      const changedGrids = [];
      for (let i = 0; i < afterGrids.length; i += 1) {
        if (i === producerIndex) continue;
        if (beforeGrids[i].empty && !afterGrids[i].empty && afterGrids[i].itemId) {
          producedItemIds.push(afterGrids[i].itemId);
        }
        if (beforeGrids[i].itemId !== afterGrids[i].itemId || beforeGrids[i].empty !== afterGrids[i].empty) {
          changedGrids.push(afterGrids[i]);
        }
      }
      const producerAfter = gridDelta(findGrid(grids, producerIndex), producerIndex);
      if (producerAfter.itemId !== beforeGrids[producerIndex]?.itemId
        || producerAfter.empty !== beforeGrids[producerIndex]?.empty) {
        changedGrids.push(producerAfter);
      }
      if (changed && !actionError) {
        revision += 1;
        const acknowledgement = {
          ...acknowledgementBase(command, true),
          ok: true,
          outcome: "accepted-changed",
          reason: "production-complete",
          delta: {
            energyChange: -energyCost,
            producedItemIds,
            touches,
            board: { signature: afterSignature, grids: changedGrids }
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
          reason: "production-unchanged",
          delta: { energyChange: 0, producedItemIds: [], touches, board: { grids: changedGrids } }
        });
      }
      if (changed) {
        revision += 1;
        publishEvent("state-changed", command.operationId, {
          energyChange: -energyCost, producedItemIds, touches, board: { grids: changedGrids }
        });
      }
      return cacheAcknowledgement(command.operationId, {
        ...acknowledgementBase(command, changed),
        ok: false,
        outcome: "uncertain-result",
        reason: "production-result-uncertain",
        error: actionError,
        delta: { energyChange: changed ? -energyCost : 0, producedItemIds, touches, board: { grids: changedGrids } }
      });
    };
    const executeSubmitOrderCommand = async (command) => {
      if (!Number.isInteger(command.expectedRevision) || command.expectedRevision !== revision) {
        return reject(command, "stale-revision", "runtime-revision-stale");
      }
      const slot = String(command.slot);
      if (!slot) return reject(command, "rejected-precondition", "order-slot-invalid");
      const { runtime } = resolveRuntime();
      const controller = (runtime.mControllers || []).find(
        (item) => item?._controllerClazzName === "UserBoardViewController"
      );
      const taskView = controller?.view?._boardView?._taskView;
      if (!controller || !taskView) {
        return reject(command, "unsupported-capability", "order-runtime-unavailable");
      }
      if (!controller.isViewVisible) {
        return reject(command, "rejected-precondition", "board-not-visible");
      }
      const taskItemData = taskView._taskItemDataMap?.get?.(slot);
      const task = taskItemData?.task;
      const items = Array.isArray(task?.itemInfos) ? task.itemInfos : [];
      if (!task) return reject(command, "rejected-precondition", "order-slot-not-found");
      if (command.expectedTaskId != null && String(task.taskId) !== String(command.expectedTaskId)) {
        return reject(command, "rejected-precondition", "order-task-changed");
      }
      if (!items.length || !items.every((item) => !!item.isComplete)) {
        return reject(command, "rejected-precondition", "order-not-ready");
      }
      if (task._inSubmit) {
        return reject(command, "rejected-precondition", "order-already-submitting");
      }
      const buttonLayer = (taskView.childViews || []).find(
        (layer) => layer?.type === 6 && isMap(layer?.taskItemMap)
      );
      if (!buttonLayer) {
        return reject(command, "unsupported-capability", "order-submit-handler-not-found");
      }
      const buttonView = buttonLayer.taskItemMap?.get?.(slot);
      if (!buttonView || typeof buttonView.submitTask !== "function") {
        return reject(command, "unsupported-capability", "order-submit-handler-not-found");
      }
      const preTaskId = safe(() => task.taskId, null);
      const managers = runtime.mManagers;
      const resourceManager = managers.find((manager) => isMap(manager?._resourceMap));
      const preCoins = Number(resourceManager?._resourceMap?.get?.(1) ?? resourceManager?._resourceMap?.get?.("1") ?? 0) || 0;
      let invocationError = null;
      try {
        buttonView.submitTask();
      } catch (error) {
        invocationError = String(error?.message || error || "order-submit-invocation-failed");
      }
      if (invocationError) {
        return reject(command, "bridge-failure", invocationError);
      }
      revision += 1;
      const acknowledgement = {
        ...acknowledgementBase(command, true),
        ok: true,
        outcome: "accepted-changed",
        reason: "order-submit-dispatched",
        delta: {
          order: {
            slot,
            previousTaskId: preTaskId,
            dispatched: true,
          },
          preCoins,
        }
      };
      publishEvent("state-changed", command.operationId, {
        order: { slot, previousTaskId: preTaskId, dispatched: true }
      });
      return cacheAcknowledgement(command.operationId, acknowledgement);
    };
    const executeCommandOnce = async (command) => {
      if (command.method === "production" && capabilities.production) {
        return executeProductionCommand(command);
      }
      if (command.method === "submit-order" && capabilities.orderSubmission) {
        return executeSubmitOrderCommand(command);
      }
      if (command.method === "navigate" && capabilities.navigation) {
        return executeNavigationCommand(command);
      }
      if (command.method === "navigate" && command.fallback === "button") {
        return executeButtonFallback(command);
      }
      if (command.method !== "merge" || !capabilities.merge) {
        return reject(command, "unsupported-capability", command.method + "-unsupported");
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
      readOrderSlot,
      readGameplayArea,
      enumerateButtons,
      executeButtonFallback,
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
    this.buttonFallbackUsage = 0;
    this.buttonFallbackResolutions = { "component-handler": 0, "node-event": 0, "coordinate-input": 0 };
    this.latestFallback = null;
    this.latestRecoveryReason = null;
    this.diagnostics = createRuntimeControlDiagnostics();
  }

  _evaluate(expression, signal, category = "targeted") {
    if (category === "targeted") this.diagnostics.targetedReads += 1;
    if (category === "baseline") this.diagnostics.baselineReads += 1;
    if (category === "command") this.diagnostics.semanticCommands += 1;
    return this.client.evaluate(expression, this.contextId, { signal });
  }

  async _readLegacyState(signal, reason) {
    this.diagnostics.broadSnapshots += 1;
    this.latestRecoveryReason = reason || this.latestRecoveryReason;
    return this.legacy.readState(signal);
  }

  async _executeLegacy(command, request, capability, reason = "semantic-capability-unavailable") {
    this.cachedBaseline = null;
    this.requiresBroadReconciliation = true;
    this.diagnostics.fallbacks += 1;
    this.diagnostics.confirmationPaths.legacy += 1;
    this.latestFallback = { capability, reason };
    return this.legacy.execute(command, request);
  }

  _recordConfirmation(path) {
    if (Object.prototype.hasOwnProperty.call(this.diagnostics.confirmationPaths, path)) {
      this.diagnostics.confirmationPaths[path] += 1;
    }
  }

  _capabilityForCommand(command, merge = null) {
    if (merge !== null && merge !== undefined) return "merge";
    if (command?.plannedAction?.type === "produce") return "production";
    if (command?.type === "submit-order") return "orderSubmission";
    if (command?.type === "navigate") return "navigation";
    return String(command?.type || "unknown");
  }

  checkpoint() {
    const handshake = this.readiness || {};
    return {
      contextGeneration: handshake.contextGeneration ?? this.contextGeneration,
      revision: handshake.revision ?? null,
      gameFingerprint: handshake.gameFingerprint ?? null,
    };
  }

  async reconcileForMutation(checkpoint, signal = null) {
    assertNotAborted(signal);
    await this.ready(signal);
    if (this.fallbackReason) {
      return { reconciled: false, reason: "legacy-runtime-control", checkpoint: this.checkpoint() };
    }
    let current;
    try {
      current = validateHandshake(await this._evaluate(
        "globalThis.miniGameCtl.handshake()",
        signal,
        "targeted",
      ), this.contextGeneration);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      this.requiresBroadReconciliation = false;
      this.latestRecoveryReason = "idle-context-generation-changed";
      this.diagnostics.resyncs += 1;
      const contextChanged = new Error("execution context changed; reconnect before mutation", { cause: error });
      contextChanged.code = "RUNTIME_CONTROL_CONTEXT_CHANGED";
      contextChanged.reason = this.latestRecoveryReason;
      throw contextChanged;
    }
    this.readiness = { ...this.readiness, ...current };
    const generationChanged = checkpoint?.contextGeneration !== current.contextGeneration
      || checkpoint?.gameFingerprint !== current.gameFingerprint;
    const revisionChanged = checkpoint?.revision !== current.revision;
    if (!generationChanged && !revisionChanged) {
      return { reconciled: false, reason: "idle-runtime-unchanged", checkpoint: this.checkpoint() };
    }
    this.requiresBroadReconciliation = true;
    this.latestRecoveryReason = generationChanged
      ? "idle-context-generation-changed"
      : "idle-runtime-revision-changed";
    await this.recoverEventGap(signal);
    return { reconciled: true, reason: this.latestRecoveryReason, checkpoint: this.checkpoint() };
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
      const installed = await this._evaluate(
        buildBridgeInstallExpression(this.contextGeneration),
        signal,
        "baseline",
      );
      const handshake = validateHandshake(installed?.handshake, this.contextGeneration);
      const semanticBaseline = validateBaseline(installed?.baseline);
      this.reconciledState = validateBaseline(await this._readLegacyState(signal, null));
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
    this.diagnostics.runtimeEvents += 1;
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
    this.diagnostics.resyncs += 1;
    this.latestRecoveryReason = this.latestRecoveryReason || "event-revision-gap";
    // Level 1: drain event queue from last applied revision
    try {
      const events = await this._evaluate(
        `globalThis.miniGameCtl.drainEventQueue(${this.appliedEventRevision})`,
        signal,
        "targeted",
      );
      if (Array.isArray(events)) {
        for (const event of events) {
          if (event.revision > this.appliedEventRevision) {
            this._applyEvent(event);
          }
        }
      }
      if (!this.requiresBroadReconciliation) return "event-queue";
    } catch (_) { /* escalate to next recovery level */ }
    // Level 2: targeted board read
    try {
      const board = await this._evaluate(
        "globalThis.miniGameCtl.readBoard()",
        signal,
        "targeted",
      );
      if (board?.ok && Number.isInteger(board.revision)) {
        if (this.readiness) this.readiness.revision = board.revision;
        this.requiresBroadReconciliation = false;
        return "targeted";
      }
    } catch (_) { /* escalate to baseline */ }
    // Level 3: baseline read
    try {
      const baseline = await this._evaluate(
        "globalThis.miniGameCtl.readBaseline()",
        signal,
        "baseline",
      );
      const validated = validateBaseline(baseline);
      if (this.readiness && Number.isInteger(validated.revision)) {
        this.readiness.revision = validated.revision;
      }
      this.cachedBaseline = mergeReconciledBaseline(this.reconciledState, validated);
      this.requiresBroadReconciliation = false;
      return "baseline";
    } catch (_) { /* escalate to broad snapshot */ }
    // Level 4: broad snapshot via legacy adapter
    this.reconciledState = validateBaseline(await this._readLegacyState(signal, this.latestRecoveryReason || "event-gap-broad-reconciliation"));
    this.requiresBroadReconciliation = false;
    return "broad";
  }

  async readState(signal = null) {
    assertNotAborted(signal);
    await this.ready(signal);
    if (this.fallbackReason) return this._readLegacyState(signal, this.fallbackReason);
    if (this.requiresBroadReconciliation) {
      const recoveryLevel = await this.recoverEventGap(signal);
      if (recoveryLevel === "broad") return cloneRecord(this.reconciledState);
    }
    if (this.cachedBaseline) {
      const baseline = this.cachedBaseline;
      this.cachedBaseline = null;
      return cloneRecord(baseline);
    }
    try {
      const baseline = validateBaseline(await this._evaluate(
        "globalThis.miniGameCtl.readBaseline()",
        signal,
        "baseline",
      ));
      if (this.readiness && Number.isInteger(baseline.revision)) {
        this.readiness.revision = baseline.revision;
      }
      return mergeReconciledBaseline(this.reconciledState, baseline);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      this.fallbackReason = error?.code || "RUNTIME_CONTROL_BASELINE_FAILED";
      this.fallbackReadiness = await this.legacy.ready(signal);
      this.readiness = null;
      return this._readLegacyState(signal, this.fallbackReason);
    }
  }

  async execute(command, request = {}) {
    const startedAt = Date.now();
    try {
      return await this._execute(command, request);
    } finally {
      recordRuntimeControlLatency(this.diagnostics, startedAt);
    }
  }

  async _execute(command, request = {}) {
    const signal = request.signal || null;
    assertNotAborted(signal);
    await this.ready(signal);
    const merge = command?.plannedAction?.type === "merge"
      ? command.plannedAction
      : command?.merge;
    const isProduction = command?.plannedAction?.type === "produce"
      && command?.producer != null;
    const canUseSemanticProduction = !this.fallbackReason
      && this.readiness?.capabilities?.production === true
      && command?.type === "run-board-action"
      && isProduction
      && merge == null;
    if (canUseSemanticProduction) {
      const producerIndex = Number(command.plannedAction.producer ?? command.producer);
      if (!Number.isInteger(producerIndex) || producerIndex < 0) {
        throw Object.assign(new Error("semantic production requires a non-negative integer producer index"), {
          code: "RUNTIME_CONTROL_COMMAND_INVALID",
          reason: "production-grid-invalid",
        });
      }
      const operationId = String(command.operationId || `production-${randomUUID()}`);
      const expectedRevision = command.expectedRevision == null
        ? (this.readiness?.revision ?? 0)
        : Number(command.expectedRevision);
      const semanticCommand = {
        operationId,
        expectedRevision,
        method: "production",
        producerGrid: producerIndex,
        expectedProductionModeId: command.plannedAction.productionModeId == null
          ? null
          : String(command.plannedAction.productionModeId),
      };
      this.cachedBaseline = null;
      const expression = `globalThis.miniGameCtl.executeCommand(${JSON.stringify(semanticCommand)})`;
      let acknowledgement = null;
      let deliveryError = null;
      for (let attempt = 0; attempt < 2 && acknowledgement == null; attempt += 1) {
        try {
          acknowledgement = await this._evaluate(expression, signal, "command");
        } catch (error) {
          if (error?.name === "AbortError") {
            this.requiresBroadReconciliation = true;
            acknowledgement = {
              ok: false,
              outcome: "aborted",
              reason: "semantic-production-aborted-after-dispatch",
              operationId,
              method: "production",
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
          reason: "semantic-production-acknowledgement-lost",
          operationId,
          method: "production",
          expectedRevision,
          revision: this.readiness.revision,
          changed: null,
          error: deliveryError?.message || String(deliveryError || "unknown bridge failure"),
        };
      }
      const ackValid = acknowledgement
        && typeof acknowledgement === "object"
        && acknowledgement.operationId === operationId
        && Number.isInteger(acknowledgement.revision)
        && typeof acknowledgement.outcome === "string"
        && typeof acknowledgement.reason === "string";
      if (!ackValid) {
        acknowledgement = {
          ok: false,
          outcome: "bridge-failure",
          reason: "semantic-production-acknowledgement-invalid",
          operationId,
          method: "production",
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
          uncertainAction: { type: "produce", producer: producerIndex },
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
      const producedItemIds = Array.isArray(acknowledgement.delta?.producedItemIds)
        ? [...acknowledgement.delta.producedItemIds].map(String).filter(Boolean)
        : [];
      const energyChange = Number(acknowledgement.delta?.energyChange || 0);
      const touches = Number(acknowledgement.delta?.touches || 1);
      const productionInvariantComplete = acknowledgement.outcome === "accepted-changed"
        && acknowledgement.changed === true
        && producedItemIds.length > 0;
      const action = {
        step: 1,
        type: "produce",
        producer: producerIndex,
        producerItemId: command.plannedAction.producerItemId == null
          ? null
          : String(command.plannedAction.producerItemId),
        productionModeId: semanticCommand.expectedProductionModeId,
        actualOutputItemIds: producedItemIds,
        touches,
        energyChange,
        verified: productionInvariantComplete,
      };
      if (productionInvariantComplete) {
        this.requiresBroadReconciliation = false;
        this._recordConfirmation("delta");
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
        ? "semantic-production-acknowledgement-incomplete"
        : ["uncertain-result", "bridge-failure"].includes(acknowledgement.outcome)
          ? acknowledgement.reason
          : null;
      if (uncertaintyReason) {
        try {
          targetedVerification = await this._evaluate("globalThis.miniGameCtl.readBoard()", signal, "targeted");
          if (Number.isInteger(targetedVerification?.revision)) {
            this.readiness.revision = targetedVerification.revision;
          }
          const verifiedGrids = Array.isArray(targetedVerification?.grids) ? targetedVerification.grids : [];
          const verifiedOutputIds = verifiedGrids
            .filter((grid) => Number(grid.index) !== producerIndex && !grid.empty && grid.itemId)
            .map((grid) => String(grid.itemId));
          if (verifiedOutputIds.length > 0) {
            this.requiresBroadReconciliation = false;
            this._recordConfirmation("targeted");
            return {
              ok: true,
              executed: true,
              reason: "production-complete-after-targeted-verification",
              stopReason: "max_actions_reached",
              actions: [{ ...action, actualOutputItemIds: verifiedOutputIds, verified: true }],
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
    const canUseSemanticOrderSubmission = !this.fallbackReason
      && this.readiness?.capabilities?.orderSubmission === true
      && command?.type === "submit-order";
    if (canUseSemanticOrderSubmission) {
      const slot = String(command.slot);
      if (!slot) {
        throw Object.assign(new Error("semantic order submission requires a non-empty slot"), {
          code: "RUNTIME_CONTROL_COMMAND_INVALID",
          reason: "order-slot-invalid",
        });
      }
      const operationId = String(command.operationId || `submit-order-${randomUUID()}`);
      const expectedRevision = command.expectedRevision == null
        ? (this.readiness?.revision ?? 0)
        : Number(command.expectedRevision);
      const expectedTaskId = command.before?.orders
        ?.find((o) => String(o.slot) === slot)?.taskId ?? null;
      const semanticCommand = {
        operationId,
        expectedRevision,
        method: "submit-order",
        slot,
        expectedTaskId: expectedTaskId != null ? String(expectedTaskId) : null,
      };
      this.cachedBaseline = null;
      const expression = `globalThis.miniGameCtl.executeCommand(${JSON.stringify(semanticCommand)})`;
      let acknowledgement = null;
      let deliveryError = null;
      for (let attempt = 0; attempt < 2 && acknowledgement == null; attempt += 1) {
        try {
          acknowledgement = await this._evaluate(expression, signal, "command");
        } catch (error) {
          if (error?.name === "AbortError") {
            this.requiresBroadReconciliation = true;
            acknowledgement = {
              ok: false,
              outcome: "aborted",
              reason: "semantic-order-submission-aborted-after-dispatch",
              operationId,
              method: "submit-order",
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
          reason: "semantic-order-submission-acknowledgement-lost",
          operationId,
          method: "submit-order",
          expectedRevision,
          revision: this.readiness.revision,
          changed: null,
          error: deliveryError?.message || String(deliveryError || "unknown bridge failure"),
        };
      }
      const ackValid = acknowledgement
        && typeof acknowledgement === "object"
        && acknowledgement.operationId === operationId
        && Number.isInteger(acknowledgement.revision)
        && typeof acknowledgement.outcome === "string"
        && typeof acknowledgement.reason === "string";
      if (!ackValid) {
        acknowledgement = {
          ok: false,
          outcome: "bridge-failure",
          reason: "semantic-order-submission-acknowledgement-invalid",
          operationId,
          method: "submit-order",
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
          uncertainAction: { type: "submit-order", slot },
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
      if (!["rejected-precondition", "unsupported-capability"].includes(acknowledgement.outcome)) {
        // Submission was dispatched. Poll the narrow order slot until the
        // asynchronous replacement is observable or the settle budget expires.
        const preCoins = Number(acknowledgement.delta?.preCoins ?? 0);
        const preTaskId = acknowledgement.delta?.order?.previousTaskId ?? null;
        const requestedPollMs = Number(request.options?.delayMs);
        const pollMs = Math.max(1, Math.min(250, requestedPollMs > 0 ? requestedPollMs : 100));
        const requestedBudgetMs = Number(request.options?.settleMs);
        const budgetMs = Math.max(pollMs, Math.min(10_000, requestedBudgetMs > 0 ? requestedBudgetMs : 1_000));
        const startedAt = Date.now();
        const slotExpr = `globalThis.miniGameCtl.readOrderSlot(${JSON.stringify(slot)})`;
        let targetedSlot = null;
        let slotReadError = null;
        let orderReplaced = false;
        do {
          assertNotAborted(signal);
          try {
            targetedSlot = await this._evaluate(slotExpr, signal, "targeted");
            slotReadError = null;
          } catch (error) {
            if (error?.name === "AbortError") throw error;
            targetedSlot = null;
            slotReadError = error?.message || String(error);
          }
          orderReplaced = targetedSlot?.ok === true
            && (!targetedSlot.occupied
              || (targetedSlot.taskId != null && String(targetedSlot.taskId) !== String(preTaskId)));
          if (orderReplaced || Date.now() - startedAt >= budgetMs) break;
          await waitForAbortable(new Promise((resolve) => setTimeout(resolve, pollMs)), signal);
        } while (Date.now() - startedAt < budgetMs);
        const coinsChanged = targetedSlot?.ok
          && Number.isFinite(targetedSlot.coins)
          && Number(targetedSlot.coins) > preCoins;
        const invariantComplete = acknowledgement.outcome === "accepted-changed"
          && acknowledgement.changed === true
          && orderReplaced;
        const action = {
          step: 1,
          type: "submit-order",
          slot,
          previousTaskId: preTaskId,
          currentTaskId: targetedSlot?.taskId ?? null,
          orderReplaced,
          coinsChanged,
          coinsBefore: preCoins,
          coinsAfter: targetedSlot?.coins ?? null,
          verified: invariantComplete && coinsChanged,
        };
        if (invariantComplete && coinsChanged) {
          this.requiresBroadReconciliation = false;
          this._recordConfirmation("targeted");
          return {
            ok: true,
            executed: true,
            reason: "order-submitted-and-coins-received",
            stopReason: "order-completed",
            actions: [action],
            acknowledgement: cloneRecord(acknowledgement),
            targetedVerification: cloneRecord(targetedSlot),
            before: command.before ?? null,
          };
        }
        if (invariantComplete && !coinsChanged) {
          this.requiresBroadReconciliation = false;
          this._recordConfirmation("targeted");
          return {
            ok: true,
            executed: true,
            reason: "order-replaced-but-coins-not-observed",
            stopReason: "order-completed",
            actions: [{ ...action, verified: true }],
            acknowledgement: cloneRecord(acknowledgement),
            targetedVerification: cloneRecord(targetedSlot),
            before: command.before ?? null,
          };
        }
        // Not yet replaced — uncertain. Preserve pause and recovery.
        const uncertaintyReason = slotReadError
          ? "order-submission-targeted-read-failed"
          : acknowledgement.outcome === "accepted-changed"
            ? "order-submission-awaiting-replacement"
            : acknowledgement.reason;
        return {
          ok: false,
          executed: true,
          reason: uncertaintyReason,
          stopReason: uncertaintyReason,
          actions: [],
          uncertainAction: action,
          pauseRequested: true,
          acknowledgement: cloneRecord(acknowledgement),
          targetedVerification: cloneRecord(targetedSlot),
          before: command.before ?? null,
          timing: { stage: "order-replacement", elapsedMs: Date.now() - startedAt, budgetMs },
        };
      }
      // Rejected or unsupported
      return {
        ok: false,
        executed: false,
        reason: acknowledgement.reason,
        stopReason: acknowledgement.reason,
        actions: [],
        uncertainAction: null,
        pauseRequested: false,
        acknowledgement: cloneRecord(acknowledgement),
        before: command.before ?? null,
      };
    }
    const canUseSemanticNavigation = !this.fallbackReason
      && this.readiness?.capabilities?.navigation === true
      && command?.type === "navigate";
    if (canUseSemanticNavigation) {
      const target = command.target;
      if (target !== "board" && target !== "map") {
        throw Object.assign(new Error("semantic navigation requires target board or map"), {
          code: "RUNTIME_CONTROL_COMMAND_INVALID",
          reason: "navigation-target-invalid",
        });
      }
      const operationId = String(command.operationId || `navigate-${randomUUID()}`);
      const expectedRevision = command.expectedRevision == null
        ? (this.readiness?.revision ?? 0)
        : Number(command.expectedRevision);
      const semanticCommand = {
        operationId,
        expectedRevision,
        method: "navigate",
        target,
      };
      this.cachedBaseline = null;
      const expression = `globalThis.miniGameCtl.executeCommand(${JSON.stringify(semanticCommand)})`;
      let acknowledgement = null;
      let deliveryError = null;
      for (let attempt = 0; attempt < 2 && acknowledgement == null; attempt += 1) {
        try {
          acknowledgement = await this._evaluate(expression, signal, "command");
        } catch (error) {
          if (error?.name === "AbortError") {
            this.requiresBroadReconciliation = true;
            acknowledgement = {
              ok: false,
              outcome: "aborted",
              reason: "semantic-navigation-aborted-after-dispatch",
              operationId,
              method: "navigate",
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
          reason: "semantic-navigation-acknowledgement-lost",
          operationId,
          method: "navigate",
          expectedRevision,
          revision: this.readiness.revision,
          changed: null,
          error: deliveryError?.message || String(deliveryError || "unknown bridge failure"),
        };
      }
      const ackValid = acknowledgement
        && typeof acknowledgement === "object"
        && acknowledgement.operationId === operationId
        && Number.isInteger(acknowledgement.revision)
        && typeof acknowledgement.outcome === "string"
        && typeof acknowledgement.reason === "string";
      if (!ackValid) {
        acknowledgement = {
          ok: false,
          outcome: "bridge-failure",
          reason: "semantic-navigation-acknowledgement-invalid",
          operationId,
          method: "navigate",
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
          uncertainAction: { type: "navigate", target },
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
      if (acknowledgement.outcome === "accepted-unchanged") {
        this.requiresBroadReconciliation = false;
        this._recordConfirmation("delta");
        return {
          ok: true,
          executed: false,
          reason: acknowledgement.reason,
          stopReason: acknowledgement.reason,
          actions: [],
          navigation: { target, alreadyThere: true },
          acknowledgement: cloneRecord(acknowledgement),
        };
      }
      // Dispatched — verify with gameplay-area targeted reads, no fixed settle delay.
      let arrived = acknowledgement.outcome === "accepted-changed"
        && acknowledgement.reason === "navigation-complete";
      let areaRead = null;
      let lastError = null;
      const maxVerificationAttempts = 6;
      for (let attempt = 0; !arrived && attempt < maxVerificationAttempts; attempt += 1) {
        assertNotAborted(signal);
        try {
          areaRead = await this._evaluate("globalThis.miniGameCtl.readGameplayArea()", signal, "targeted");
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          lastError = error?.message || String(error);
          continue;
        }
        if (areaRead && Number.isInteger(areaRead.revision)) {
          this.readiness.revision = areaRead.revision;
        }
        arrived = target === "board" ? areaRead?.boardVisible === true
          : (areaRead?.mapVisible === true && areaRead?.boardVisible !== true);
        if (arrived) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (arrived) {
        this.requiresBroadReconciliation = false;
        this._recordConfirmation(areaRead ? "targeted" : "delta");
        return {
          ok: true,
          executed: true,
          reason: "navigation-verified",
          stopReason: "navigation-complete",
          actions: [{ type: "navigate", target, verified: true }],
          acknowledgement: cloneRecord(acknowledgement),
          targetedVerification: cloneRecord(areaRead),
        };
      }
      const navigationReason = lastError || "navigation-not-observed";
      return {
        ok: false,
        executed: true,
        reason: navigationReason,
        stopReason: navigationReason,
        actions: [],
        uncertainAction: { type: "navigate", target },
        pauseRequested: false,
        acknowledgement: cloneRecord(acknowledgement),
        targetedVerification: cloneRecord(areaRead),
      };
    }
    // When navigation capability is unavailable, try button fallback before legacy
    const canUseButtonFallbackNavigation = !this.fallbackReason
      && this.readiness?.capabilities?.navigation !== true
      && command?.type === "navigate";
    if (canUseButtonFallbackNavigation) {
      const target = command.target;
      if (target !== "board" && target !== "map") {
        throw Object.assign(new Error("button-fallback navigation requires target board or map"), {
          code: "RUNTIME_CONTROL_COMMAND_INVALID",
          reason: "navigation-target-invalid",
        });
      }
      this.buttonFallbackUsage += 1;
      // Step 1: enumerate buttons to find candidates for navigation
      let buttonEnum = null;
      try {
        buttonEnum = await this._evaluate("globalThis.miniGameCtl.enumerateButtons()", signal, "targeted");
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        // Fall through to legacy if enumeration fails.
        return this._executeLegacy(command, request, "navigation");
      }
      if (!buttonEnum || !Array.isArray(buttonEnum.buttons) || buttonEnum.count === 0) {
        // No buttons found — fall through to legacy.
        return this._executeLegacy(command, request, "navigation");
      }
      // Step 2: build a hint for the button we want
      // For map→board navigation, look for button whose handler calls onBoardClick or targets EntranceViewController
      // For board→map navigation, look for button whose handler calls onMapButtonClick
      // Try by handler name first, then by component identity if handler name doesn't match
      const resolveHint = (target === "board"
        ? [
          { handlerName: "onBoardClick" },
          { targetName: "EntranceViewController" },
          { handlerComponent: "EntranceViewController" },
        ]
        : [
          { handlerName: "onMapButtonClick" },
          { handlerComponent: "UserBoardViewController" },
        ]);
      // Step 3: try each hint until one resolves uniquely
      let matchingButton = null;
      let chosenHint = null;
      for (const hint of resolveHint) {
        const matches = buttonEnum.buttons.filter((btn) => {
          if (!btn.activeInHierarchy || !btn.interactable) return false;
          if (!btn.inCurrentGameplayArea) return false;
          if (hint.handlerName != null
            && !btn.handlers.some((h) => h.handler === hint.handlerName)) return false;
          if (hint.targetName != null
            && !btn.handlers.some((h) => h.targetName === hint.targetName)) return false;
          if (hint.handlerComponent != null
            && !btn.handlers.some((h) => h.component === hint.handlerComponent)) return false;
          return true;
        });
        if (matches.length === 1) {
          matchingButton = matches[0];
          chosenHint = hint;
          break;
        }
        // Ambiguous — skip this hint, try next
      }
      if (!matchingButton) {
        // No unambiguous button match — fall through to legacy.
        return this._executeLegacy(command, request, "navigation");
      }
      // Step 4: execute button fallback via the injected bridge
      const operationId = String(command.operationId || `btn-fallback-${randomUUID()}`);
      const expectedRevision = command.expectedRevision == null
        ? (this.readiness?.revision ?? 0)
        : Number(command.expectedRevision);
      const fallbackCommand = {
        operationId,
        expectedRevision,
        method: "navigate",
        target,
        fallback: "button",
        buttonHint: chosenHint,
      };
      this.cachedBaseline = null;
      const expression = `globalThis.miniGameCtl.executeCommand(${JSON.stringify(fallbackCommand)})`;
      let acknowledgement = null;
      for (let attempt = 0; attempt < 2 && acknowledgement == null; attempt += 1) {
        try {
          acknowledgement = await this._evaluate(expression, signal, "command");
        } catch (error) {
          if (error?.name === "AbortError") {
            this.requiresBroadReconciliation = true;
            return {
              ok: false,
              executed: true,
              reason: "button-fallback-navigation-aborted",
              stopReason: "button-fallback-navigation-aborted",
              actions: [],
              uncertainAction: { type: "navigate", target },
              pauseRequested: false,
            };
          }
        }
      }
      if (acknowledgement == null) {
        // Bridge call failed — fall through to legacy.
        return this._executeLegacy(command, request, "navigation");
      }
      const ackValid = acknowledgement
        && typeof acknowledgement === "object"
        && Number.isInteger(acknowledgement.revision)
        && typeof acknowledgement.outcome === "string"
        && typeof acknowledgement.reason === "string";
      if (!ackValid) return this._executeLegacy(command, request, "navigation");
      this.readiness.revision = acknowledgement.revision;
      // Track fallback resolution tier
      const fallbackTier = acknowledgement.delta?.buttonFallback?.tier;
      if (fallbackTier && this.buttonFallbackResolutions[fallbackTier] != null) {
        this.buttonFallbackResolutions[fallbackTier] += 1;
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
      if (["rejected-precondition", "unsupported-capability", "bridge-failure"].includes(acknowledgement.outcome)) {
        // Button fallback rejected — fall through to legacy.
        return this._executeLegacy(command, request, "navigation");
      }
      // Dispatched — verify with gameplay-area targeted reads, same as semantic navigation
      let arrived = acknowledgement.outcome === "accepted-changed"
        && acknowledgement.reason === "button-fallback-complete";
      let areaRead = null;
      const maxVerificationAttempts = 6;
      for (let attempt = 0; !arrived && attempt < maxVerificationAttempts; attempt += 1) {
        assertNotAborted(signal);
        try {
          areaRead = await this._evaluate("globalThis.miniGameCtl.readGameplayArea()", signal, "targeted");
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          continue;
        }
        if (areaRead && Number.isInteger(areaRead.revision)) {
          this.readiness.revision = areaRead.revision;
        }
        arrived = target === "board" ? areaRead?.boardVisible === true
          : (areaRead?.mapVisible === true && areaRead?.boardVisible !== true);
        if (arrived) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (arrived) {
        this.requiresBroadReconciliation = false;
        this._recordConfirmation(areaRead ? "targeted" : "delta");
        return {
          ok: true,
          executed: true,
          reason: "navigation-verified-via-button-fallback",
          stopReason: "navigation-complete",
          actions: [{ type: "navigate", target, verified: true, fallback: "button", tier: fallbackTier }],
          acknowledgement: cloneRecord(acknowledgement),
          targetedVerification: cloneRecord(areaRead),
          diagnostics: { buttonFallback: { tier: fallbackTier, nodeName: acknowledgement.delta?.buttonFallback?.nodeName } },
        };
      }
      // Fall through to Legacy as the final per-capability fallback.
      return this._executeLegacy(command, request, "navigation");
    }
    const canUseSemanticMerge = !this.fallbackReason
      && this.readiness?.capabilities?.merge === true
      && command?.type === "run-board-action"
      && merge != null;
    if (!canUseSemanticMerge) {
      const capability = this._capabilityForCommand(command, merge);
      const reason = this.fallbackReason || "semantic-capability-unavailable";
      return this._executeLegacy(command, request, capability, reason);
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
      ? (this.readiness?.revision ?? 0)
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
        acknowledgement = await this._evaluate(expression, signal, "command");
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
    if (acknowledgement.outcome === "rejected-precondition" && acknowledgement.reason === "merge-not-ready") {
      const requestedPollMs = Number(request.options?.delayMs);
      const pollMs = Math.max(1, Math.min(250, requestedPollMs > 0 ? requestedPollMs : 100));
      const requestedBudgetMs = Number(request.options?.settleMs);
      const budgetMs = Math.max(pollMs, Math.min(2_000, requestedBudgetMs > 0 ? requestedBudgetMs : 1_000));
      const startedAt = Date.now();
      let replanState = null;
      do {
        await waitForAbortable(new Promise((resolve) => setTimeout(resolve, pollMs)), signal);
        replanState = await this.readState(signal);
        const source = replanState.board?.grids?.find((grid) => Number(grid.index) === sourceGrid);
        const target = replanState.board?.grids?.find((grid) => Number(grid.index) === targetGrid);
        const pairChanged = String(source?.itemId || "") !== String(semanticCommand.expectedItemId || "")
          || String(target?.itemId || "") !== String(semanticCommand.expectedItemId || "");
        const pairReady = source?.actionReady !== false && target?.actionReady !== false;
        if (pairChanged || pairReady) {
          this.requiresBroadReconciliation = false;
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
      } while (Date.now() - startedAt < budgetMs);
      return {
        ok: false,
        executed: false,
        reason: acknowledgement.reason,
        stopReason: acknowledgement.reason,
        actions: [],
        pauseRequested: false,
        acknowledgement: cloneRecord(acknowledgement),
        timing: { stage: "action-readiness", elapsedMs: Date.now() - startedAt, budgetMs },
      };
    }
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
      this._recordConfirmation("delta");
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
        targetedVerification = await this._evaluate("globalThis.miniGameCtl.readBoard()", signal, "targeted");
        const target = targetedVerification?.grids
          ?.find((grid) => Number(grid.index) === targetGrid);
        if (Number.isInteger(targetedVerification?.revision)) {
          this.readiness.revision = targetedVerification.revision;
        }
        if (targetedMergeInvariantComplete(targetedVerification, semanticCommand)) {
          this.requiresBroadReconciliation = false;
          this._recordConfirmation("targeted");
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
      latestFallback: cloneRecord(this.latestFallback),
      latestRecoveryReason: this.latestRecoveryReason,
      diagnostics: {
        ...cloneRecord(this.diagnostics),
        transport: typeof this.client.diagnosticsSnapshot === "function"
          ? this.client.diagnosticsSnapshot()
          : null,
      },
      eventBinding: { active: !!this.bindingListener, appliedRevision: this.appliedEventRevision },
      buttonFallback: {
        usageCount: this.buttonFallbackUsage,
        resolutions: cloneRecord(this.buttonFallbackResolutions),
      },
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
    this.diagnostics = createRuntimeControlDiagnostics();
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
    this.diagnostics.baselineReads += 1;
    this.diagnostics.broadSnapshots += 1;
    const snapshot = await this.lab.snapshot(this.selection, { signal });
    let boardState = null;
    try {
      this.diagnostics.targetedReads += 1;
      boardState = await this.lab.client.evaluate(BOARD_SCAN_EXPRESSION, this.selection.probe.context.id, { signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
    return buildGameState({ state: summarizeSnapshot(snapshot), boardState });
  }

  async execute(command, request = {}) {
    const startedAt = Date.now();
    try {
      return await this._execute(command, request);
    } finally {
      recordRuntimeControlLatency(this.diagnostics, startedAt);
    }
  }

  async _execute(command, { signal = null, options = {} } = {}) {
    assertNotAborted(signal);
    if (!command?.type) throw Object.assign(new Error("runtime control command type is required"), { code: "RUNTIME_CONTROL_COMMAND_INVALID" });
    this.diagnostics.confirmationPaths.legacy += 1;
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

  checkpoint() {
    return { contextGeneration: String(this.selection.probe.context.id), revision: null, gameFingerprint: null };
  }

  status() {
    return {
      adapterId: "legacy-cdp",
      ready: true,
      protocolVersion: null,
      bridgeVersion: null,
      gameFingerprint: null,
      contextGeneration: String(this.selection.probe.context.id),
      revision: null,
      capabilities: {
        baseline: true,
        merge: false,
        production: false,
        orderSubmission: false,
        navigation: false,
      },
      fallback: { active: true, reason: "semantic-runtime-control-unavailable" },
      latestFallback: null,
      latestRecoveryReason: null,
      diagnostics: {
        ...cloneRecord(this.diagnostics),
        transport: typeof this.lab.client?.diagnosticsSnapshot === "function"
          ? this.lab.client.diagnosticsSnapshot()
          : null,
      },
    };
  }
}

/**
 * In-memory Adapter for Automation Runtime scenarios. Script entries may be
 * records, Errors, or async functions receiving the command and AbortSignal.
 */
class FakeRuntimeControlAdapter {
  constructor({ states = [], results = [], readiness = null, controlPath = "semantic" } = {}) {
    this.states = [...states];
    this.results = [...results];
    this.controlPath = controlPath === "legacy" ? "legacy" : "semantic";
    this.readiness = readiness || { adapterId: "fake-runtime-control", contextId: "fake-context", capabilities: ["state", "actions"] };
    this.commands = [];
    this.readCount = 0;
    this.readyCount = 0;
    this.diagnostics = createRuntimeControlDiagnostics();
    this.latestRecoveryReason = null;
  }

  async ready(signal = null) {
    this.readyCount += 1;
    return resolveFakeEntry(this.readiness, { signal, adapter: this });
  }

  async readState(signal = null) {
    const index = this.readCount;
    this.readCount += 1;
    this.diagnostics.baselineReads += 1;
    if (this.controlPath === "legacy") {
      this.diagnostics.broadSnapshots += 1;
      this.diagnostics.targetedReads += 1;
    }
    const entry = this.states[Math.min(index, this.states.length - 1)];
    if (entry == null) throw Object.assign(new Error("fake runtime control has no state"), { code: "FAKE_RUNTIME_CONTROL_STATE_MISSING" });
    return resolveFakeEntry(entry, { signal, readIndex: index, adapter: this });
  }

  async execute(command, { signal = null } = {}) {
    assertNotAborted(signal);
    const startedAt = Date.now();
    try {
      const index = this.commands.length;
      this.commands.push(cloneRecord(command));
      if (this.controlPath === "semantic") this.diagnostics.semanticCommands += 1;
      else {
        this.diagnostics.broadSnapshots += 1;
        this.diagnostics.targetedReads += 1;
        this.diagnostics.confirmationPaths.legacy += 1;
      }
      const entry = this.results[index];
      if (entry == null) throw Object.assign(new Error(`fake runtime control has no result for ${command?.type || "unknown"}`), { code: "FAKE_RUNTIME_CONTROL_RESULT_MISSING" });
      const result = await resolveFakeEntry(entry, { signal, command: cloneRecord(command), commandIndex: index, adapter: this });
      if (this.controlPath === "semantic") {
        if (result?.targetedVerification !== null && result?.targetedVerification !== undefined) {
          this.diagnostics.targetedReads += 1;
          this.diagnostics.confirmationPaths.targeted += 1;
        } else if (result?.acknowledgement?.delta !== null && result?.acknowledgement?.delta !== undefined) {
          this.diagnostics.confirmationPaths.delta += 1;
        }
      }
      return result;
    } finally {
      recordRuntimeControlLatency(this.diagnostics, startedAt);
    }
  }

  checkpoint() {
    return {
      contextGeneration: this.readiness?.contextGeneration ?? this.readiness?.contextId ?? null,
      revision: this.readiness?.revision ?? null,
      gameFingerprint: this.readiness?.gameFingerprint ?? null,
    };
  }

  async reconcileForMutation(checkpoint, signal = null) {
    assertNotAborted(signal);
    const current = this.checkpoint();
    const changed = checkpoint?.contextGeneration !== current.contextGeneration
      || checkpoint?.revision !== current.revision
      || checkpoint?.gameFingerprint !== current.gameFingerprint;
    if (changed) {
      this.diagnostics.resyncs += 1;
      this.latestRecoveryReason = checkpoint?.contextGeneration !== current.contextGeneration
        ? "idle-context-generation-changed"
        : "idle-runtime-revision-changed";
    }
    return { reconciled: changed, reason: changed ? this.latestRecoveryReason : "idle-runtime-unchanged", checkpoint: current };
  }

  status() {
    return {
      adapterId: this.controlPath === "legacy"
        ? "fake-legacy-runtime-control"
        : this.readiness?.adapterId || "fake-runtime-control",
      ready: true,
      protocolVersion: this.readiness?.protocolVersion ?? null,
      bridgeVersion: this.readiness?.bridgeVersion ?? null,
      gameFingerprint: this.readiness?.gameFingerprint ?? null,
      contextGeneration: this.readiness?.contextGeneration ?? this.readiness?.contextId ?? null,
      revision: this.readiness?.revision ?? null,
      capabilities: cloneRecord(this.readiness?.capabilities || {}),
      fallback: this.controlPath === "legacy"
        ? { active: true, reason: "fake-legacy-baseline" }
        : { active: false, reason: null },
      latestFallback: null,
      latestRecoveryReason: this.latestRecoveryReason,
      diagnostics: cloneRecord(this.diagnostics),
    };
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
