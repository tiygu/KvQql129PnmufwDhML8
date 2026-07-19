"use strict";

const { BaseAdapter } = require("../base-adapter");

const MATCH_MARKERS = ["entryAudio", "mapPanel", "farmArea", "taskBoard"];

class TargetGameAdapter extends BaseAdapter {
  constructor() {
    super({ id: "target-game", label: "Target Farm Game Inspector", engine: "cocos" });
  }

  match(probeResult) {
    const data = probeResult?.data;
    if (!data?.engines?.cocos?.present) return 0;
    const markers = data?.hints?.sceneMarkers || {};
    const markerCount = MATCH_MARKERS.filter((name) => markers[name]).length;
    if (markerCount < 2) return 0;
    const sceneBonus = data.engines.cocos.scene === "main" ? 10 : 0;
    const globalBonus = data.hints?.engineLikeGlobals?.includes("MainScene") ? 10 : 0;
    return 80 + markerCount * 15 + sceneBonus + globalBonus;
  }

  async snapshot(client, context, _probe = null, options = {}) {
    return client.evaluate(`(() => {
      const G = globalThis;
      const cc = G.cc || G.GameGlobal?.cc;
      const scene = cc?.director?.getScene?.();
      const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };
      const ownKeys = (value, limit = 80) => safe(() => Object.getOwnPropertyNames(value).slice(0, limit), []);
      const pathOf = (node) => {
        const parts = [];
        let current = node;
        while (current) { parts.push(current.name || "<unnamed>"); current = current.parent; }
        return "/" + parts.reverse().join("/");
      };
      const findPath = (segments) => {
        let node = scene;
        for (const name of segments) {
          node = safe(() => node?.getChildByName?.(name) || node?.children?.find?.((child) => child?.name === name), null);
          if (!node) return null;
        }
        return node;
      };
      const componentSummary = (node) => (node?._components || []).map((component, index) => ({
        index,
        type: component?.constructor?.name || "unknown",
        keys: ownKeys(component, 50),
        string: typeof component?.string === "string" ? component.string.slice(0, 200) : undefined
      }));
      const primitiveFields = (value, limit = 80) => {
        const result = {};
        for (const key of ownKeys(value, limit)) {
          const field = safe(() => value[key]);
          if (field == null || ["string", "number", "boolean"].includes(typeof field)) result[key] = field;
        }
        return result;
      };
      const describeValue = (value, name = null) => value == null ? null : ({
        name,
        type: typeof value,
        className: safe(() => value.constructor?.name, null),
        keys: ownKeys(value, 120),
        primitiveFields: primitiveFields(value)
      });
      const describeCollection = (value, limit = 160) => {
        if (value == null) return [];
        let entries = [];
        if (value instanceof Map) entries = Array.from(value.entries());
        else if (Array.isArray(value)) entries = value.map((item, index) => [index, item]);
        else entries = safe(() => Object.entries(value), []);
        return entries.slice(0, limit).map(([key, item]) => describeValue(item, String(key)));
      };
      const snapshotValue = (value, depth = 2, seen = new WeakSet()) => {
        if (value == null || ["string", "number", "boolean"].includes(typeof value)) return value;
        if (typeof value === "function") return { kind: "Function", name: value.name || null };
        if (typeof value !== "object") return String(value);
        if (seen.has(value)) return { kind: "Circular" };
        seen.add(value);
        if (value instanceof Map) return {
          kind: "Map",
          size: value.size,
          entries: Array.from(value.entries()).slice(0, 100)
            .map(([key, item]) => [String(key), depth > 0 ? snapshotValue(item, depth - 1, seen) : describeValue(item)])
        };
        if (value instanceof Set) return {
          kind: "Set",
          size: value.size,
          values: Array.from(value.values()).slice(0, 100)
            .map((item) => depth > 0 ? snapshotValue(item, depth - 1, seen) : describeValue(item))
        };
        if (Array.isArray(value)) return {
          kind: "Array",
          length: value.length,
          items: value.slice(0, 100)
            .map((item) => depth > 0 ? snapshotValue(item, depth - 1, seen) : describeValue(item))
        };
        const ignored = new Set(["node", "entry", "viewManager", "mEventListeners", "mTimerHandlers"]);
        const keys = ownKeys(value, 100).filter((key) => !ignored.has(key));
        const fields = {};
        for (const key of keys) {
          const field = safe(() => value[key]);
          if (field == null || ["string", "number", "boolean"].includes(typeof field)) fields[key] = field;
          else if (depth > 0 && /data|map|list|set|state|task|item|resource|reward|energy|config|info|model|schema|need|price|cost|count|num|grid|slot|board|warehouse/i.test(key)) {
            fields[key] = snapshotValue(field, depth - 1, seen);
          }
        }
        return { kind: "Object", className: safe(() => value.constructor?.name, null), keys, fields };
      };
      const anchors = {
        mapPanel: findPath(["Canvas", "ui", "root", "map_panel"]),
        farmArea: findPath(["Canvas", "ui", "root", "map_panel", "scale_root", "map", "map_root", "AreaThumb_Area_Farms"]),
        taskBoard: findPath(["Canvas", "ui", "content", "board_view", "board", "task_view"]),
        entry: findPath(["Entry"]),
        audioManager: findPath(["Entry", "AudioManager"])
      };
      const interesting = [];
      const labels = [];
      const counts = { total: 0, active: 0, inactive: 0 };
      const interestingName = /farm|field|crop|plant|seed|harvest|warehouse|store|player|task|map|area|mushroom|pond|woodland|mart/i;
      const walk = (node) => {
        if (!node || counts.total >= 3000) return;
        counts.total += 1;
        if (node.active) counts.active += 1; else counts.inactive += 1;
        const path = pathOf(node);
        if (interestingName.test(node.name || "") && interesting.length < 250) {
          interesting.push({ path, active: !!node.active, components: componentSummary(node).map((item) => item.type) });
        }
        for (const component of node._components || []) {
          if (typeof component?.string === "string" && component.string.trim() && labels.length < 150) {
            labels.push({ path, text: component.string.slice(0, 200) });
          }
        }
        for (const child of node.children || []) walk(child);
      };
      walk(scene);
      const describeGlobal = (name) => {
        const value = G[name];
        return value == null ? null : { type: typeof value, keys: ownKeys(value, 120) };
      };
      const entryComponent = (anchors.entry?._components || []).find((component) =>
        component && ("mManagers" in component || "mControllers" in component || "mGame" in component));
      const managers = Array.isArray(entryComponent?.mManagers) ? entryComponent.mManagers : [];
      const controllers = Array.isArray(entryComponent?.mControllers) ? entryComponent.mControllers : [];
      const managerByField = (field) => managers.find((manager) => manager && field in manager) || null;
      const domainManager = (fieldNames) => {
        const manager = fieldNames.map(managerByField).find(Boolean) || null;
        if (!manager) return null;
        const data = {};
        for (const field of fieldNames) if (field in manager) data[field] = snapshotValue(safe(() => manager[field]), 3);
        return { index: managers.indexOf(manager), summary: describeValue(manager), data };
      };
      const controllerByName = (name) => controllers.find((controller) =>
        controller?._controllerClazzName === name || controller?._viewClazzName === name) || null;
      const focusedController = (name, fields = []) => {
        const controller = controllerByName(name);
        if (!controller) return null;
        const data = {};
        for (const field of fields) if (field in controller) data[field] = snapshotValue(safe(() => controller[field]), 3);
        return {
          index: controllers.indexOf(controller),
          controllerName: controller._controllerClazzName || null,
          viewName: controller._viewClazzName || null,
          visible: !!controller.isViewVisible,
          controller: snapshotValue(controller, 2),
          view: snapshotValue(controller.view, 4),
          data
        };
      };
      const mapBehaviorComponent = (anchors.mapPanel?._components || []).find((component) =>
        component && ownKeys(component, 80).some((key) => /^m[A-Z].*Behavior$/.test(key)));
      const mapBehaviors = mapBehaviorComponent ? ownKeys(mapBehaviorComponent, 100)
        .filter((key) => /^m[A-Z].*Behavior$/.test(key))
        .map((key) => describeValue(safe(() => mapBehaviorComponent[key]), key)) : [];
      const boardController = controllerByName("UserBoardViewController");
      const selectedItemController = controllerByName("MergeChainViewController");
      const warehouseController = controllerByName("WarehouseViewController");
      const mapMissionController = controllerByName("AreaMissionInfoViewController");
      const labelByPath = (pattern) => labels.find((item) => pattern.test(item.path))?.text ?? null;
      const textOfNode = (node) => {
        for (const component of node?._components || []) {
          if (typeof component?.string === "string") return component.string.slice(0, 500);
        }
        return null;
      };
      const boardBottomPath = ["Canvas", "ui", "content", "board_view", "board", "board_bottom_view", "container"];
      const itemInfoPath = [...boardBottomPath, "item_info_view", "info_container"];
      const itemInfoContainer = findPath(itemInfoPath);
      const emptyInfoContainer = findPath([...boardBottomPath, "item_info_view", "empty_container"]);
      const directLabel = (tail, fallbackPattern) => textOfNode(findPath([...itemInfoPath, ...tail])) ?? labelByPath(fallbackPattern);
      const selectedName = directLabel(["item_name$Label"], /board_bottom_view.*item_name\$Label$/);
      const selectedDescription = directLabel(["item_info$Label"], /board_bottom_view.*item_info\$Label$/);
      const selectedItemUi = {
        selected: !!itemInfoContainer?.active && !emptyInfoContainer?.active,
        infoContainerActive: !!itemInfoContainer?.active,
        emptyContainerActive: !!emptyInfoContainer?.active,
        prompt: textOfNode(findPath([...boardBottomPath, "item_info_view", "empty_container", "no_item_prompt$Label"])),
        name: itemInfoContainer?.active ? selectedName : null,
        description: itemInfoContainer?.active ? selectedDescription : null,
        price: textOfNode(findPath([...boardBottomPath, "item_info_view", "button_container", "opr_btn_view", "content", "res_container", "price"]))
          ?? labelByPath(/board_bottom_view.*opr_btn_view.*(?:price|number)$/),
        detailControllerVisible: !!selectedItemController?.isViewVisible
      };
      const warehouseSlots = [];
      const warehouseData = safe(() => warehouseController?.view?._warehouseData, null);
      const gridTypeMap = safe(() => warehouseData?._gridTypeMap, null);
      if (gridTypeMap instanceof Map) {
        for (const [type, grids] of gridTypeMap.entries()) {
          for (const grid of Array.isArray(grids) ? grids : []) {
            const itemData = safe(() => grid?.itemData, null);
            warehouseSlots.push({
              gridId: safe(() => grid.id, null),
              type: Number(type),
              unlocked: !!safe(() => grid.unlocked, false),
              unlockLevel: safe(() => grid.unlockLevel, null),
              unlockPrice: safe(() => grid.unlockPrice, null),
              occupied: itemData != null,
              item: itemData == null ? null : snapshotValue(itemData, 4)
            });
          }
        }
      }
      const missionCfg = mapMissionController?.mmTaskCfg;
      const mapMissionState = missionCfg ? {
        id: safe(() => missionCfg.id, null),
        titleKey: safe(() => missionCfg.TaskTitle, null),
        needType: snapshotValue(safe(() => missionCfg.NeedType), 3),
        needAmount: snapshotValue(safe(() => missionCfg.NeedNum), 3),
        reward: snapshotValue(safe(() => missionCfg.Reward), 3),
        nextId: safe(() => missionCfg.NextId, null),
        canUpgrade: !!safe(() => mapMissionController.view?._canUpgrade, false),
        rewardPhase: safe(() => mapMissionController.view?._curRewardPhase, null)
      } : null;
      return {
        adapter: "target-game",
        engine: { version: cc?.ENGINE_VERSION || cc?.VERSION || null, scene: scene?.name || null },
        counts,
        anchors: Object.fromEntries(Object.entries(anchors).map(([name, node]) => [name, node ? {
          path: pathOf(node), active: !!node.active, components: componentSummary(node)
        } : null])),
        globals: {
          MainScene: describeGlobal("MainScene"),
          LoadingManager: describeGlobal("LoadingManager"),
          thinkingdata: describeGlobal("thinkingdata")
        },
        entryRuntime: entryComponent ? {
          component: describeValue(entryComponent, "EntryRuntime"),
          game: describeValue(entryComponent.mGame, "mGame"),
          managers: describeCollection(entryComponent.mManagers, 80),
          controllers: describeCollection(entryComponent.mControllers, 200).filter((item) =>
            item?.primitiveFields?._controllerClazzName || item?.primitiveFields?.isViewVisible ||
            item?.keys?.some((key) => /farm|field|board|task|item|warehouse|resource|energy/i.test(key)))
        } : null,
        domainManagers: {
          resources: domainManager(["_resourceMap", "_tempResourceMap"]),
          energy: domainManager(["_energyDataMap", "_energyCountdownListenerMap"]),
          tasks: domainManager(["clientTaskDataMap", "serverTaskDataMap", "clientTimeoutTaskDataMap", "_inCompleteTaskMap"]),
          items: domainManager(["_historyItemMap", "_clientHistoryItemSet", "_pendingNewItemPresentationOrder"]),
          rewards: domainManager(["_rewardMap", "_claimedRewardIds"]),
          board: domainManager(["boardData"]),
          statistics: domainManager(["_statisticsDataMap"])
        },
        focusedControllers: {
          board: focusedController("UserBoardViewController", ["_getTaskInfoListFuncMap"]),
          selectedItem: focusedController("MergeChainViewController", ["buyItemIds"]),
          warehouse: focusedController("WarehouseViewController", ["_itemAtlas", "_boardType"]),
          mapMission: focusedController("AreaMissionInfoViewController", ["mmTaskCfg"])
        },
        gameplayState: {
          mode: mapMissionController?.isViewVisible ? "map-mission"
            : warehouseController?.isViewVisible ? "warehouse"
              : boardController?.isViewVisible ? "board" : "map",
          selectedItemUi,
          warehouse: {
            visible: !!warehouseController?.isViewVisible,
            totalSlots: warehouseSlots.length,
            unlockedSlots: warehouseSlots.filter((slot) => slot.unlocked).length,
            occupiedSlots: warehouseSlots.filter((slot) => slot.occupied),
            slots: warehouseSlots
          },
          mapMission: mapMissionState
        },
        mapBehaviors,
        interestingNodes: interesting,
        labels
      };
    })()`, context.id, options);
  }
}

module.exports = { TargetGameAdapter, adapter: new TargetGameAdapter() };
