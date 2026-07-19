"use strict";

const { normalizeWarehouseState } = require("./warehouse-domain");

const RESOURCE_TYPES = Object.freeze({ coins: 1, diamonds: 2, energy: 3 });

function numberOr(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function resourceAmount(resources, type) {
  return numberOr((resources || []).find((item) => Number(item.type) === type)?.amount, 0);
}

function normalizeOrder(task, liveOrder) {
  const sourceItems = liveOrder?.items || task?.items || [];
  const items = sourceItems.map((item) => ({
    itemId: String(item.itemId ?? ""),
    complete: !!item.complete,
    status: item.status ?? null,
  }));
  const rewardCoins = liveOrder?.rewardCoins
    ?? task?.rewards?.find((reward) => Number(reward.type) === RESOURCE_TYPES.coins)?.count
    ?? task?.awardValue
    ?? 0;
  return {
    slot: String(liveOrder?.slot ?? task?.slot ?? ""),
    taskId: liveOrder?.taskId ?? task?.taskId ?? null,
    rewardCoins: numberOr(rewardCoins),
    items,
    requiredItemIds: items.map((item) => item.itemId).filter(Boolean),
    missingItemIds: items.filter((item) => !item.complete).map((item) => item.itemId).filter(Boolean),
    ready: items.length > 0 && items.every((item) => item.complete),
  };
}

function normalizeMapMission(mission, coins, mapProgress = null) {
  if (!mission) return null;
  const requirements = (mission.requirements || []).map((requirement) => {
    const resourceType = Number(requirement.resourceType);
    const current = resourceType === RESOURCE_TYPES.coins ? coins : 0;
    const required = numberOr(requirement.required);
    return { resourceType, current, required, deficit: Math.max(0, required - current), enough: current >= required };
  });
  const progressTaskId = mapProgress?.currentTask ?? null;
  const configurationStale = progressTaskId != null
    && mission.id != null
    && String(progressTaskId) !== String(mission.id);
  return {
    id: mission.id ?? null,
    titleKey: mission.titleKey ?? null,
    reward: mission.reward ?? null,
    nextId: mission.nextId ?? null,
    runtimeCanUpgrade: !!mission.canUpgrade,
    progressTaskId,
    configurationStale,
    requirements,
    canComplete: !configurationStale && requirements.length > 0 && requirements.every((item) => item.enough),
  };
}

/**
 * Converts snapshot/runtime-specific fields into the only state shape consumed by
 * planners, the orchestrator and the future renderer.
 */
function buildGameState({ state = {}, boardState = null, overlays = [] } = {}) {
  const resources = {
    coins: resourceAmount(state.resources, RESOURCE_TYPES.coins),
    diamonds: resourceAmount(state.resources, RESOURCE_TYPES.diamonds),
    energy: numberOr(state.energy?.[0]?.amount, resourceAmount(state.resources, RESOURCE_TYPES.energy)),
  };
  const liveOrders = new Map((boardState?.orders || []).map((order) => [String(order.slot), order]));
  const snapshotTasks = new Map((state.tasks || []).map((task) => [String(task.slot), task]));
  const orderSlots = new Set([...snapshotTasks.keys(), ...liveOrders.keys()]);
  const orders = [...orderSlots].map((slot) => normalizeOrder(snapshotTasks.get(slot), liveOrders.get(slot)));
  const boardOk = !!boardState?.ok;
  const mode = state.gameplay?.mode ?? null;
  const scene = boardOk && boardState.boardVisible ? "board"
    : mode === "warehouse" ? "warehouse"
      : mode === "map-mission" ? "map-mission"
        : mode === "board" ? "board" : "map";
  const grids = boardOk ? (boardState.grids || []).map((grid) => ({ ...grid, itemId: String(grid.itemId ?? "") })) : [];
  const producers = boardOk ? (boardState.producers || []).map((producer) => ({ ...producer, itemId: String(producer.itemId ?? "") })) : [];

  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    scene,
    resources,
    energy: {
      amount: resources.energy,
      limit: state.energy?.[0]?.limit ?? null,
      recoverIntervalSeconds: state.energy?.[0]?.recoverIntervalSeconds ?? null,
      recoverTimestamp: state.energy?.[0]?.recoverTimestamp ?? null,
      recovering: !!state.energy?.[0]?.recovering,
    },
    board: {
      available: boardOk,
      visible: !!boardState?.boardVisible,
      width: boardState?.width ?? null,
      height: boardState?.height ?? null,
      occupied: numberOr(boardState?.occupied),
      empty: numberOr(boardState?.empty),
      signature: boardState?.signature ?? "",
      grids,
      mergeCandidates: boardOk ? (boardState.mergeCandidates || []).map((candidate) => ({ ...candidate })) : [],
      requiredItemCounts: boardOk ? { ...(boardState.requiredItemCounts || {}) } : {},
    },
    orders,
    producers,
    warehouse: normalizeWarehouseState(state.gameplay?.warehouse),
    mapProgress: {
      currentTask: state.mapProgress?.currentTask ?? null,
      currentSeason: state.mapProgress?.currentSeason ?? null,
      seasonDisplay: state.mapProgress?.seasonDisplay ?? null,
      allFinished: !!state.mapProgress?.allFinished,
      episodeFinished: !!state.mapProgress?.episodeFinished,
    },
    mapMission: normalizeMapMission(state.mapMission, resources.coins, state.mapProgress),
    overlays: [...overlays],
    selectedItem: state.gameplay?.selectedItem ? { ...state.gameplay.selectedItem } : null,
    source: { adapter: state.sourceAdapter ?? null, engine: state.engine ?? null },
  };
}

module.exports = { buildGameState, RESOURCE_TYPES, normalizeOrder };
