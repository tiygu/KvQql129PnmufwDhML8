"use strict";

const { gridUnavailabilityReasons } = require("./inventory-availability");
const { normalizeWarehouseState, unknownWarehouseInventoryKnowledge, warehouseGridEligibility } = require("./warehouse-domain");

const ITEM_OPPORTUNITY_POLICY = Object.freeze({
  exactOrderDemand: 1000,
  chainDemandPerBaseUnit: 10,
  rebuildingEnergy: 1,
  chainScarcity: 1,
  currentLevel: 0.1,
  saleReturn: 1,
  boardOccupancyPenalty: 5,
  warehouseOccupancyPenalty: 5,
  unknownWarehouseCapacityPenalty: 5,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function itemRecord(catalog, itemId) {
  return (catalog.items || []).find((item) => String(item.id) === String(itemId)) || null;
}

function normalizePlannerState({ state, catalog, protectionRules = {} }) {
  const sourceGrids = state.board?.grids || [];
  const occupied = Number.isFinite(Number(state.board?.occupied)) ? Number(state.board.occupied) : sourceGrids.filter((grid) => grid.itemId && !grid.empty).length;
  const reportedEmpty = Number(state.board?.empty);
  const empty = Number.isFinite(reportedEmpty) ? Math.max(0, reportedEmpty) : 0;
  const dimensions = Number(state.board?.width) * Number(state.board?.height);
  const capacity = Math.max(occupied + empty, Number.isFinite(dimensions) ? dimensions : 0);
  const explicitProtected = new Set((protectionRules.itemIds || []).map(String));
  const gridFacts = sourceGrids.map((grid) => ({ grid, reasons: grid.itemId ? gridUnavailabilityReasons(grid) : [] }));
  const taskNeedCounts = new Map();
  for (const { grid, reasons } of gridFacts) if (grid.taskNeed && grid.itemId && reasons.length === 0) taskNeedCounts.set(String(grid.itemId), (taskNeedCounts.get(String(grid.itemId)) || 0) + 1);
  const remainingRequired = new Map(Object.entries(state.board?.requiredItemCounts || {}).map(([itemId, count]) => [String(itemId), Math.max(0, (Number(count) || 0) - (taskNeedCounts.get(String(itemId)) || 0))]));
  const grids = gridFacts.map(({ grid, reasons }) => {
    const itemId = String(grid.itemId || "");
    const requiredReservation = reasons.length === 0 && !grid.taskNeed && (remainingRequired.get(itemId) || 0) > 0;
    if (requiredReservation) remainingRequired.set(itemId, Math.max(0, (remainingRequired.get(itemId) || 0) - 1));
    return {
      index: Number(grid.index), itemId, empty: !itemId || !!grid.empty,
      level: grid.level == null ? itemRecord(catalog, itemId)?.level ?? null : Number(grid.level),
      mergeTarget: grid.mergeTarget == null ? itemRecord(catalog, itemId)?.mergeTarget ?? null : String(grid.mergeTarget),
      produceCount: grid.produceCount == null ? null : Number(grid.produceCount),
      energyCost: grid.energyCost == null ? null : Number(grid.energyCost),
      currentProductionModeId: grid.currentProductionModeId == null ? null : String(grid.currentProductionModeId),
      availableProductionModes: (grid.availableProductionModes || []).map((mode) => ({ modeId: String(mode.modeId), unlocked: mode.unlocked !== false })),
      productionModeSwitchEntry: grid.productionModeSwitchEntry ? { ...grid.productionModeSwitchEntry } : { status: "unknown", method: null },
      executable: !itemId || reasons.length === 0,
      unavailableReasons: reasons,
      protected: !!grid.taskNeed || requiredReservation || explicitProtected.has(itemId),
    };
  });
  const mapRequirement = (state.mapMission?.requirements || []).find((requirement) => Number(requirement.resourceType) === 1);
  const rawMapCoinDeficit = Number(mapRequirement?.deficit ?? (Number(mapRequirement?.required || 0) - Number(mapRequirement?.current || 0)));
  const normalizedItems = (catalog.items || []).map((item) => {
    const inferredTarget = (catalog.items || []).find((candidate) => String(candidate.chainId) === String(item.chainId) && Number(candidate.level) === Number(item.level) + 1);
    const relevantEvidence = (catalog.evidence?.objects || []).filter((object) => String(object.objectId) === String(item.id) && ["item-identity", "merge-relation"].includes(object.objectType));
    const mergeEvidenceActive = ["item-identity", "merge-relation"].every((objectType) => relevantEvidence.some((object) => object.objectType === objectType && object.status === "active" && object.disposition === "enabled"));
    const evidenceSufficient = !item.inferred && (relevantEvidence.length === 0 || ["item-identity", "merge-relation"].every((objectType) => relevantEvidence.some((object) => object.objectType === objectType && object.status === "active" && object.disposition === "enabled")));
    return {
      id: String(item.id), chainId: item.chainId == null ? null : String(item.chainId), level: Number(item.level || 0),
      baseUnits: Number(item.baseUnits || 0), saleValue: Number(item.saleValue || item.sellValue || 0),
      evidenceSufficient, mergeEvidenceActive,
      mergeTarget: item.mergeTarget == null || item.mergeTarget === "" ? (inferredTarget ? String(inferredTarget.id) : null) : String(item.mergeTarget),
    };
  });
  const normalized = {
    schemaVersion: 1,
    scene: state.scene,
    board: {
      capacity, occupied, empty: Math.max(0, capacity - occupied),
      spaceKnown: Number.isFinite(reportedEmpty) || Number.isFinite(dimensions),
      grids,
    },
    warehouse: normalizeWarehouseState(state.warehouse),
    orders: (state.orders || []).map((order) => ({
      slot: String(order.slot), rewardCoins: Number(order.rewardCoins || 0), ready: !!order.ready,
      items: (order.items || []).map((item) => ({ itemId: String(item.itemId), complete: !!item.complete })),
    })),
    energy: Number(state.resources?.energy || 0),
    coins: Number(state.resources?.coins || 0),
    mapCoinDeficit: Number.isFinite(rawMapCoinDeficit) ? Math.max(0, rawMapCoinDeficit) : 0,
    catalog: {
      items: normalizedItems,
      producers: (catalog.producers || []).map((producer) => ({
        itemId: String(producer.itemId), energyCost: Number(producer.energyCost || 0),
        drops: (producer.drops || []).map((drop) => ({ itemId: String(drop.itemId), probability: Number(drop.probability), baseUnits: Number(drop.baseUnits || 0) })),
        modes: (producer.modes || []).map((mode) => ({
          modeId: String(mode.modeId), energyCost: Number(mode.energyCost || 0), unlocked: mode.unlocked !== false,
          humanLocked: !!mode.humanLocked, inferred: !!mode.inferred,
          planningDistribution: mode.planningDistribution ? {
            sampleSize: Number(mode.planningDistribution.sampleSize || 0),
            uncertaintyMass: Number(mode.planningDistribution.uncertaintyMass || 0),
            expectedOutcomesPerAction: Number(mode.planningDistribution.expectedOutcomesPerAction || 1),
            feasibilityOutcomesPerAction: Number(mode.planningDistribution.feasibilityOutcomesPerAction || mode.planningDistribution.expectedOutcomesPerAction || 1),
          } : null,
          drops: (mode.drops || []).map((drop) => ({ itemId: String(drop.itemId), chainId: drop.chainId == null ? null : String(drop.chainId), level: Number(drop.level || 0), probability: Number(drop.probability), count: Number(drop.count ?? 1), baseUnits: Number(drop.baseUnits || 0) })),
        })),
      })),
      evidence: (catalog.evidence?.objects || []).map((object) => ({ objectType: object.objectType, objectId: String(object.objectId), status: object.status, disposition: object.disposition })),
    },
    protection: {
      itemIds: [...explicitProtected].sort(),
      rules: { neverTransformTaskItems: true, excludeUnavailable: true, ...(protectionRules.rules || {}) },
    },
  };
  return deepFreeze(normalized);
}

function mutableCopy(state) {
  return JSON.parse(JSON.stringify(state));
}

function catalogItem(state, itemId) {
  return state.catalog.items.find((item) => item.id === String(itemId)) || null;
}

function gridAt(state, index) {
  return state.board.grids.find((grid) => Number(grid.index) === Number(index)) || null;
}

function orderSatisfied(state, order) {
  if (order.ready) return true;
  const counts = new Map();
  for (const grid of state.board.grids) if (grid.itemId && !grid.empty && grid.executable) counts.set(grid.itemId, (counts.get(grid.itemId) || 0) + 1);
  for (const item of [...order.items.filter((entry) => entry.complete), ...order.items.filter((entry) => !entry.complete)]) {
    const count = counts.get(item.itemId) || 0;
    if (count <= 0) return false;
    counts.set(item.itemId, count - 1);
  }
  return true;
}

function updateOrderReadiness(state) {
  for (const order of state.orders) {
    const counts = new Map();
    for (const grid of state.board.grids) if (grid.itemId && !grid.empty && grid.executable) counts.set(grid.itemId, (counts.get(grid.itemId) || 0) + 1);
    let completeMaterialsPresent = true;
    for (const item of order.items.filter((entry) => entry.complete)) {
      const count = counts.get(item.itemId) || 0;
      if (count <= 0) { completeMaterialsPresent = false; continue; }
      counts.set(item.itemId, count - 1);
    }
    for (const item of order.items.filter((entry) => !entry.complete)) {
      const count = counts.get(item.itemId) || 0;
      if (count > 0) { item.complete = true; counts.set(item.itemId, count - 1); }
    }
    order.ready = completeMaterialsPresent && order.items.length > 0 && order.items.every((item) => item.complete);
  }
}

function totalItemOpportunityValue(state, demandState = state, { includeBoardOccupancy = true } = {}) {
  const exactDemand = new Map(), chainDemandUnits = new Map(), chainSupply = new Map();
  for (const order of demandState.orders) for (const requirement of order.items.filter((item) => !item.complete)) {
    exactDemand.set(requirement.itemId, (exactDemand.get(requirement.itemId) || 0) + 1);
    const item = catalogItem(state, requirement.itemId);
    if (item?.chainId) chainDemandUnits.set(item.chainId, (chainDemandUnits.get(item.chainId) || 0) + item.baseUnits);
  }
  for (const grid of state.board.grids.filter((entry) => entry.itemId && !entry.empty && entry.executable)) {
    const item = catalogItem(state, grid.itemId);
    if (item?.chainId) chainSupply.set(item.chainId, (chainSupply.get(item.chainId) || 0) + Math.max(0, item.baseUnits));
  }
  const energyPerBaseUnitByChain = new Map();
  for (const producer of state.catalog.producers) for (const drop of producer.drops) {
    const output = catalogItem(state, drop.itemId);
    if (!output?.chainId) continue;
    const energyPerBaseUnit = producer.energyCost / Math.max(1, drop.baseUnits || output.baseUnits);
    energyPerBaseUnitByChain.set(output.chainId, Math.min(energyPerBaseUnitByChain.get(output.chainId) ?? Infinity, energyPerBaseUnit));
  }
  const pressure = state.board.capacity > 0 ? state.board.occupied / state.board.capacity : 0;
  const remainingExactDemand = new Map(exactDemand);
  const remainingChainDemandUnits = new Map(chainDemandUnits);
  let total = 0;
  for (const grid of state.board.grids.filter((entry) => entry.itemId && !entry.empty)) {
    const item = catalogItem(state, grid.itemId);
    if (!item) continue;
    const scarcity = item.chainId ? item.baseUnits / Math.max(1, chainSupply.get(item.chainId) || 0) : 0;
    const energyPerBaseUnit = energyPerBaseUnitByChain.get(item.chainId) ?? Infinity;
    const rebuildingEnergy = Number.isFinite(energyPerBaseUnit) ? energyPerBaseUnit * item.baseUnits : item.baseUnits;
    const exactDemandContribution = grid.executable && (remainingExactDemand.get(item.id) || 0) > 0 ? 1 : 0;
    if (exactDemandContribution) remainingExactDemand.set(item.id, remainingExactDemand.get(item.id) - 1);
    const chainDemandContribution = grid.executable ? Math.min(item.baseUnits, remainingChainDemandUnits.get(item.chainId) || 0) : 0;
    if (chainDemandContribution) remainingChainDemandUnits.set(item.chainId, remainingChainDemandUnits.get(item.chainId) - chainDemandContribution);
    total += exactDemandContribution * ITEM_OPPORTUNITY_POLICY.exactOrderDemand
      + chainDemandContribution * ITEM_OPPORTUNITY_POLICY.chainDemandPerBaseUnit
      + rebuildingEnergy * ITEM_OPPORTUNITY_POLICY.rebuildingEnergy
      + scarcity * ITEM_OPPORTUNITY_POLICY.chainScarcity
      + item.level * ITEM_OPPORTUNITY_POLICY.currentLevel
      + item.saleValue * ITEM_OPPORTUNITY_POLICY.saleReturn
      - (includeBoardOccupancy ? pressure * ITEM_OPPORTUNITY_POLICY.boardOccupancyPenalty : 0);
  }
  return total;
}

function simulateMerge(state, action) {
  const from = gridAt(state, action.from), to = gridAt(state, action.to);
  if (!from || !to || from.empty || to.empty || from.itemId !== to.itemId) return { ok: false, reason: "merge-pair-invalid" };
  if (!from.executable || !to.executable || from.protected || to.protected) return { ok: false, reason: "unsafe-merge" };
  const sourceItem = catalogItem(state, from.itemId);
  const resultItem = sourceItem?.mergeTarget ? catalogItem(state, sourceItem.mergeTarget) : null;
  if (!sourceItem || !resultItem) return { ok: false, reason: "merge-relation-unavailable" };
  const beforeUnits = Number(sourceItem.baseUnits) * 2;
  const afterUnits = Number(resultItem.baseUnits);
  if (!(beforeUnits > 0) || beforeUnits !== afterUnits) return { ok: false, reason: "merge-material-not-conserved" };
  const next = mutableCopy(state);
  const nextFrom = gridAt(next, action.from), nextTo = gridAt(next, action.to);
  Object.assign(nextFrom, { itemId: "", empty: true, level: null, mergeTarget: null, protected: false });
  Object.assign(nextTo, { itemId: resultItem.id, empty: false, level: resultItem.level, mergeTarget: resultItem.mergeTarget, protected: false });
  next.board.occupied -= 1;
  next.board.empty += 1;
  updateOrderReadiness(next);
  return { ok: true, state: deepFreeze(next), conservation: { beforeUnits, afterUnits } };
}

function simulateProduce(state, action) {
  const producerGrid = gridAt(state, action.producer);
  const profile = state.catalog.producers.find((producer) => producer.itemId === producerGrid?.itemId);
  const deterministic = profile?.drops?.length === 1 && profile.drops[0].probability === 1 ? profile.drops[0] : null;
  if (!producerGrid?.executable || producerGrid?.produceCount === 0) return { ok: false, reason: "unsafe-production" };
  if (!deterministic || deterministic.itemId !== String(action.outputItemId || deterministic.itemId)) return { ok: false, reason: "production-not-deterministic" };
  if (state.board.empty <= 0) return { ok: false, reason: "board-space-required" };
  if (state.energy < profile.energyCost) return { ok: false, reason: "insufficient-energy" };
  const resultItem = catalogItem(state, deterministic.itemId);
  if (!resultItem) return { ok: false, reason: "production-output-unavailable" };
  const next = mutableCopy(state);
  let target = next.board.grids.find((grid) => grid.empty);
  if (!target) {
    const nextIndex = next.board.grids.reduce((maximum, grid) => Math.max(maximum, Number(grid.index)), -1) + 1;
    target = { index: nextIndex };
    next.board.grids.push(target);
  }
  Object.assign(target, { itemId: resultItem.id, empty: false, level: resultItem.level, mergeTarget: resultItem.mergeTarget, executable: true, unavailableReasons: [], protected: false, produceCount: null, energyCost: null });
  next.board.occupied += 1;
  next.board.empty -= 1;
  next.energy -= profile.energyCost;
  const nextProducer = gridAt(next, action.producer);
  if (nextProducer.produceCount != null) nextProducer.produceCount -= 1;
  updateOrderReadiness(next);
  return { ok: true, state: deepFreeze(next) };
}

function simulateProductionOutcome(state, action, outcomeItemIds) {
  const producerGrid = gridAt(state, action.producer);
  const profile = state.catalog.producers.find((producer) => producer.itemId === producerGrid?.itemId);
  const mode = (profile?.modes || []).find((candidate) => String(candidate.modeId) === String(action.productionModeId));
  const energyCost = Number(action.energyCost ?? mode?.energyCost ?? profile?.energyCost);
  const outputs = (outcomeItemIds || []).map(String).filter(Boolean);
  if (!producerGrid?.executable || producerGrid?.produceCount === 0) return { ok: false, reason: "unsafe-production" };
  if (!outputs.length) return { ok: false, reason: "production-outcome-required" };
  if (producerGrid.currentProductionModeId != null && action.productionModeId != null && String(producerGrid.currentProductionModeId) !== String(action.productionModeId)) return { ok: false, reason: "production-mode-mismatch" };
  if (state.board.empty < outputs.length) return { ok: false, reason: "board-space-required" };
  if (!Number.isFinite(energyCost) || state.energy < energyCost) return { ok: false, reason: "insufficient-energy" };
  const next = mutableCopy(state);
  for (const outputItemId of outputs) {
    const resultItem = catalogItem(next, outputItemId);
    const target = next.board.grids.find((grid) => grid.empty);
    if (!target) return { ok: false, reason: "board-space-required" };
    Object.assign(target, {
      itemId: outputItemId, empty: false, level: resultItem?.level ?? null, mergeTarget: resultItem?.mergeTarget ?? null,
      executable: !!resultItem?.evidenceSufficient, unavailableReasons: resultItem ? [] : ["unknown-production-outcome"],
      protected: false, produceCount: null, energyCost: null,
    });
    next.board.occupied += 1;
    next.board.empty -= 1;
  }
  next.energy -= energyCost;
  const nextProducer = gridAt(next, action.producer);
  if (nextProducer.produceCount != null) nextProducer.produceCount -= 1;
  updateOrderReadiness(next);
  return { ok: true, state: deepFreeze(next), energyCost, outcomeItemIds: outputs };
}

function simulateProductionModeSwitch(state, action) {
  const producer = gridAt(state, action.producer);
  const available = producer?.availableProductionModes?.some((mode) => String(mode.modeId) === String(action.productionModeId) && mode.unlocked !== false);
  if (!producer?.executable || !available || producer.productionModeSwitchEntry?.status !== "available") return { ok: false, reason: "production-mode-switch-unavailable" };
  const next = mutableCopy(state);
  gridAt(next, action.producer).currentProductionModeId = String(action.productionModeId);
  return { ok: true, state: deepFreeze(next) };
}

function simulateSubmit(state, action) {
  const order = state.orders.find((candidate) => candidate.slot === String(action.slot));
  if (!order || !order.ready) return { ok: false, reason: "order-not-ready" };
  const next = mutableCopy(state);
  const nextOrder = next.orders.find((candidate) => candidate.slot === String(action.slot));
  for (const item of nextOrder.items) {
    const grid = next.board.grids.find((candidate) => candidate.itemId === item.itemId && !candidate.empty);
    if (!grid) {
      if (!item.complete) return { ok: false, reason: "order-material-missing" };
      continue;
    }
    Object.assign(grid, { itemId: "", empty: true, level: null, mergeTarget: null, protected: false });
    next.board.occupied -= 1;
    next.board.empty += 1;
  }
  next.orders = next.orders.filter((candidate) => candidate.slot !== String(action.slot));
  next.coins += nextOrder.rewardCoins;
  next.mapCoinDeficit = Math.max(0, next.mapCoinDeficit - nextOrder.rewardCoins);
  return { ok: true, state: deepFreeze(next) };
}

function simulateWarehouseStoreTransition(state, action, { requireVerifiedAvailability }) {
  const verified = action.storeAvailability?.status === "available" && !!action.storeAvailability.targetSlotId;
  if (requireVerifiedAvailability && !verified) return { ok: false, reason: "warehouse-native-preflight-required" };
  const source = gridAt(state, action.sourceIndex);
  const sourceItem = catalogItem(state, source.itemId);
  const eligibility = warehouseGridEligibility(source, { catalogItemKnown: !!sourceItem?.evidenceSufficient });
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };
  const knowledge = state.warehouse.inventoryKnowledge;
  if (knowledge.status === "loaded" && knowledge.exchangeCapacity <= 0) return { ok: false, reason: "warehouse-full" };
  const beforeCapacity = knowledge.exchangeCapacity;
  const next = mutableCopy(state);
  const nextSource = gridAt(next, action.sourceIndex);
  Object.assign(nextSource, { itemId: "", empty: true, level: null, mergeTarget: null, protected: false });
  next.board.occupied -= 1;
  next.board.empty += 1;
  const afterCapacity = beforeCapacity == null ? null : Math.max(0, beforeCapacity - 1);
  next.warehouse.inventoryKnowledge = unknownWarehouseInventoryKnowledge("warehouse-store-invalidated");
  next.warehouse.storeAvailability = { status: "unknown" };
  updateOrderReadiness(next);
  return {
    ok: true,
    state: deepFreeze(next),
    opportunityCost: Number(action.opportunityCost || 0),
    warehouseExchange: { beforeCapacity, afterCapacity, targetSlotId: verified ? String(action.storeAvailability.targetSlotId) : null, ...(!verified ? { hypotheticalPreflight: true } : {}) },
  };
}

function simulateWarehouseStore(state, action) {
  return simulateWarehouseStoreTransition(state, action, { requireVerifiedAvailability: true });
}

function simulateWarehouseStoreProposal(state, action) {
  return simulateWarehouseStoreTransition(state, action, { requireVerifiedAvailability: false });
}

function simulateWarehouseRetrieve(state, action) {
  const knowledge = state.warehouse.inventoryKnowledge;
  if (knowledge.status !== "loaded" || knowledge.retrievalPath?.status !== "trusted" || String(knowledge.revision) !== String(action.inventoryRevision)) return { ok: false, reason: "warehouse-revision-mismatch" };
  if (state.board.empty <= 0) return { ok: false, reason: "board-space-required" };
  const slot = (knowledge.slots || []).find((candidate) => String(candidate.slotId) === String(action.warehouseSlotId) && candidate.occupied && String(candidate.itemId) === String(action.itemId));
  const item = catalogItem(state, action.itemId);
  if (!slot || !item?.evidenceSufficient) return { ok: false, reason: "warehouse-slot-unavailable" };
  const next = mutableCopy(state);
  const target = next.board.grids.find((grid) => grid.empty);
  Object.assign(target, { itemId: item.id, empty: false, level: item.level, mergeTarget: item.mergeTarget, executable: true, unavailableReasons: [], protected: false, produceCount: null, energyCost: null });
  next.board.occupied += 1;
  next.board.empty -= 1;
  next.warehouse.inventoryKnowledge = unknownWarehouseInventoryKnowledge("warehouse-retrieval-invalidated");
  updateOrderReadiness(next);
  return { ok: true, state: deepFreeze(next) };
}

function simulateDeterministicTransition(state, action) {
  if (action?.type === "merge") return simulateMerge(state, action);
  if (action?.type === "produce") return simulateProduce(state, action);
  if (action?.type === "submit-order") return simulateSubmit(state, action);
  if (action?.type === "store-to-warehouse") return simulateWarehouseStore(state, action);
  if (action?.type === "retrieve-from-warehouse") return simulateWarehouseRetrieve(state, action);
  if (action?.type === "switch-production-mode") return simulateProductionModeSwitch(state, action);
  return { ok: false, reason: "unsupported-deterministic-transition" };
}

function buildWarehouseStoreCandidates(state) {
  const knowledge = state.warehouse.inventoryKnowledge;
  if (knowledge.status === "loaded" && knowledge.exchangeCapacity != null && knowledge.exchangeCapacity <= 0) return [];
  const beforeOpportunity = totalItemOpportunityValue(state, state, { includeBoardOccupancy: false });
  const candidates = [];
  for (const grid of state.board.grids) {
    const eligibility = warehouseGridEligibility(grid, { catalogItemKnown: !!catalogItem(state, grid.itemId)?.evidenceSufficient });
    if (!eligibility.eligible) continue;
    const after = mutableCopy(state);
    const removed = gridAt(after, grid.index);
    Object.assign(removed, { itemId: "", empty: true, level: null, mergeTarget: null, protected: false });
    after.board.occupied -= 1;
    after.board.empty += 1;
    const intrinsicCost = Math.max(0, beforeOpportunity - totalItemOpportunityValue(after, state, { includeBoardOccupancy: false }));
    const warehouseOccupancyCost = knowledge.status === "loaded" && Number(knowledge.unlockedSlots) > 0
      ? Number(knowledge.occupiedSlots) / Number(knowledge.unlockedSlots) * ITEM_OPPORTUNITY_POLICY.warehouseOccupancyPenalty
      : ITEM_OPPORTUNITY_POLICY.unknownWarehouseCapacityPenalty;
    const opportunityCost = intrinsicCost + warehouseOccupancyCost;
    const observedAvailability = state.warehouse.storeAvailability;
    const storeAvailability = observedAvailability?.status === "available"
      && Number(observedAvailability.sourceIndex) === Number(grid.index)
      && String(observedAvailability.itemId) === String(grid.itemId)
      ? { ...observedAvailability }
      : { status: "native-preflight-required" };
    candidates.push({
      type: "store-to-warehouse", sourceIndex: grid.index, itemId: grid.itemId, opportunityCost,
      warehouseInventoryKnowledge: { ...knowledge },
      storeAvailability,
    });
  }
  return candidates.sort((left, right) => left.opportunityCost - right.opportunityCost || left.sourceIndex - right.sourceIndex);
}

function buildWarehouseRetrieveCandidates(state, orderSlot) {
  const knowledge = state.warehouse.inventoryKnowledge;
  if (knowledge.status !== "loaded" || knowledge.retrievalPath?.status !== "trusted" || !knowledge.revision) return [];
  if (state.board.empty <= 0) return [];
  const order = state.orders.find((entry) => String(entry.slot) === String(orderSlot));
  if (!order) return [];
  const missingTargets = order.items.filter((item) => !item.complete).map((item) => catalogItem(state, item.itemId)).filter(Boolean);
  const demands = new Map();
  for (const target of missingTargets) {
    const demand = demands.get(target.chainId) || { units: 0, maxTargetLevel: 0 };
    demand.units += Number(target.baseUnits || 0);
    demand.maxTargetLevel = Math.max(demand.maxTargetLevel, Number(target.level || 0));
    demands.set(target.chainId, demand);
  }
  for (const grid of state.board.grids) {
    if (grid.empty || !grid.executable || grid.protected) continue;
    const item = catalogItem(state, grid.itemId), demand = demands.get(item?.chainId);
    if (demand && item.level <= demand.maxTargetLevel) demand.units = Math.max(0, demand.units - Number(item.baseUnits || 0));
  }
  const eligibleSlots = [];
  for (const slot of knowledge.slots || []) {
    const item = catalogItem(state, slot.itemId), demand = demands.get(item?.chainId);
    if (slot.occupied && item?.evidenceSufficient && demand?.units > 0 && item.level <= demand.maxTargetLevel) eligibleSlots.push({ slot, item, demand });
  }
  for (const demand of demands.values()) {
    const available = eligibleSlots.filter((entry) => entry.demand === demand).reduce((sum, entry) => sum + Number(entry.item.baseUnits || 0), 0);
    if (available + 1e-9 < demand.units) demand.insufficientWarehouseSupply = true;
  }
  const candidates = [];
  const selectedUnits = new Map();
  for (const { slot, item, demand } of eligibleSlots.sort((left, right) => Number(right.item.baseUnits || 0) - Number(left.item.baseUnits || 0))) {
    if (demand.insufficientWarehouseSupply || (selectedUnits.get(item.chainId) || 0) >= demand.units) continue;
    let bufferPolicy = "preserve-one-buffer";
    if (state.board.empty === 1) {
      const immediatelyMergeable = item.mergeEvidenceActive && !!item.mergeTarget && state.board.grids.some((grid) => !grid.empty && grid.executable && !grid.protected && grid.itemId === item.id);
      if (!immediatelyMergeable) continue;
      bufferPolicy = "verified-immediate-merge";
    }
    candidates.push({
      type: "retrieve-from-warehouse", warehouseSlotId: String(slot.slotId), itemId: item.id,
      inventoryRevision: knowledge.revision, bufferPolicy,
      opportunityValue: Math.min(Number(item.baseUnits || 0), demand.units),
    });
    selectedUnits.set(item.chainId, (selectedUnits.get(item.chainId) || 0) + Number(item.baseUnits || 0));
  }
  return candidates.sort((left, right) => right.opportunityValue - left.opportunityValue || left.warehouseSlotId.localeCompare(right.warehouseSlotId));
}

function comparePathScores(a, b) {
  return Number(!a.safe) - Number(!b.safe)
    || Number(!a.boardSpaceFeasible) - Number(!b.boardSpaceFeasible)
    || a.peakOccupied - b.peakOccupied
    || b.orderProgress - a.orderProgress
    || b.mapProgressCoins - a.mapProgressCoins
    || a.opportunityLoss - b.opportunityLoss
    || b.saleReturn - a.saleReturn
    || a.actionCount - b.actionCount
    || String(a.tieBreaker || "").localeCompare(String(b.tieBreaker || ""));
}

function stateKey(state) {
  const grids = state.board.grids.filter((grid) => grid.itemId && !grid.empty).map((grid) => `${grid.index}:${grid.itemId}:${grid.produceCount ?? ""}`).sort();
  return `${state.energy}|${grids.join("|")}`;
}

function buildMergeCandidates(state, onPruned = null) {
  const actions = [];
  const groups = new Map();
  for (const grid of state.board.grids.filter((entry) => entry.itemId && !entry.empty)) {
    if (!groups.has(grid.itemId)) groups.set(grid.itemId, []);
    groups.get(grid.itemId).push(grid);
  }
  for (const [itemId, grids] of groups) {
    for (let left = 0; left < grids.length; left += 1) for (let right = left + 1; right < grids.length; right += 1) {
      const action = { type: "merge", from: grids[left].index, to: grids[right].index, itemId, resultItemId: catalogItem(state, itemId)?.mergeTarget || null };
      const simulated = simulateMerge(state, action);
      if (simulated.ok) actions.push(action);
      else onPruned?.(simulated.reason);
    }
  }
  return actions;
}

function candidateActions(state, pruned) {
  const actions = buildMergeCandidates(state, (reason) => { pruned[reason] = (pruned[reason] || 0) + 1; });
  for (const profile of state.catalog.producers) {
    if (profile.drops.length !== 1 || profile.drops[0].probability !== 1) continue;
    for (const grid of state.board.grids.filter((entry) => entry.itemId === profile.itemId)) {
      const action = { type: "produce", producer: grid.index, producerItemId: profile.itemId, outputItemId: profile.drops[0].itemId, energyCost: profile.energyCost };
      const simulated = simulateProduce(state, action);
      if (simulated.ok) actions.push(action);
      else pruned[simulated.reason] = (pruned[simulated.reason] || 0) + 1;
    }
  }
  for (const candidate of buildWarehouseStoreCandidates(state)) {
    if (candidate.storeAvailability.status === "available") actions.push(candidate);
    else pruned["warehouse-native-preflight-required"] = (pruned["warehouse-native-preflight-required"] || 0) + 1;
  }
  return actions.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function planDeterministicOrder(state, orderSlot, { maxStates = 768, maxDepth = 32 } = {}) {
  const order = state.orders.find((candidate) => candidate.slot === String(orderSlot));
  if (!order) return { status: "blocked", reason: "order-not-found", nextAction: null, boardSpaceFeasibility: { feasible: false, peakOccupied: state.board.occupied }, explanation: { selected: null, pruned: {} } };
  if (order.ready) {
    const score = { safe: true, boardSpaceFeasible: true, peakOccupied: state.board.occupied, orderProgress: 1, mapProgressCoins: Math.min(order.rewardCoins, state.mapCoinDeficit), opportunityLoss: 0, saleReturn: 0, actionCount: 1, tieBreaker: `submit:${order.slot}` };
    return {
      status: "planned", nextAction: { type: "submit-order", slot: order.slot },
      boardSpaceFeasibility: { feasible: true, peakOccupied: state.board.occupied, capacity: state.board.capacity, minimumEmpty: state.board.empty },
      energyRequired: 0,
      score,
      explanation: { selected: "order is ready for deterministic submission", pruned: {}, consideredStates: 1 },
    };
  }
  const pruned = {};
  const queue = [{ state, firstAction: null, depth: 0, peakOccupied: state.board.occupied, minimumEmpty: state.board.empty, opportunityLoss: 0 }];
  const visited = new Set([stateKey(state)]);
  const goals = [];
  let consideredStates = 0;
  while (queue.length && consideredStates < maxStates) {
    const node = queue.shift();
    consideredStates += 1;
    if (node.depth >= maxDepth) { pruned["horizon-limit"] = (pruned["horizon-limit"] || 0) + 1; continue; }
    for (const action of candidateActions(node.state, pruned)) {
      const transition = simulateDeterministicTransition(node.state, action);
      if (!transition.ok) { pruned[transition.reason] = (pruned[transition.reason] || 0) + 1; continue; }
      const next = transition.state;
      if (next.board.occupied < 0 || next.board.occupied > next.board.capacity || next.board.empty < 0) { pruned["board-capacity-violation"] = (pruned["board-capacity-violation"] || 0) + 1; continue; }
      const firstAction = node.firstAction || action;
      const transitionOpportunityLoss = action.type === "store-to-warehouse"
        ? Math.max(0, Number(action.opportunityCost || 0))
        : Math.max(0, totalItemOpportunityValue(node.state, state) - totalItemOpportunityValue(next, state));
      const nextNode = { state: next, firstAction, depth: node.depth + 1, peakOccupied: Math.max(node.peakOccupied, next.board.occupied), minimumEmpty: Math.min(node.minimumEmpty, next.board.empty), opportunityLoss: node.opportunityLoss + transitionOpportunityLoss };
      if (orderSatisfied(next, order)) {
        const mapProgressCoins = Math.min(order.rewardCoins, state.mapCoinDeficit);
        const score = { safe: true, boardSpaceFeasible: true, peakOccupied: nextNode.peakOccupied, orderProgress: 1, mapProgressCoins, opportunityLoss: nextNode.opportunityLoss, saleReturn: 0, actionCount: nextNode.depth, tieBreaker: JSON.stringify(firstAction) };
        goals.push({ ...nextNode, score });
        continue;
      }
      const key = stateKey(next);
      if (visited.has(key)) { pruned["duplicate-state"] = (pruned["duplicate-state"] || 0) + 1; continue; }
      visited.add(key);
      queue.push(nextNode);
    }
  }
  if (!goals.length) {
    const reason = state.board.empty === 0 && (pruned["board-space-required"] || 0) > 0 ? "board-space-deadlock"
      : (pruned["insufficient-energy"] || 0) > 0 ? "insufficient-energy"
        : "deterministic-path-not-found";
    return { status: "blocked", reason, nextAction: null, boardSpaceFeasibility: { feasible: false, peakOccupied: state.board.occupied, capacity: state.board.capacity, minimumEmpty: state.board.empty }, explanation: { selected: null, pruned, consideredStates } };
  }
  goals.sort((left, right) => comparePathScores(left.score, right.score));
  const selected = goals[0];
  const releasesBeforeProduction = selected.firstAction.type === "merge" && state.board.empty === 0;
  return {
    status: "planned",
    nextAction: selected.firstAction,
    boardSpaceFeasibility: { feasible: true, peakOccupied: selected.peakOccupied, capacity: state.board.capacity, minimumEmpty: selected.minimumEmpty },
    energyRequired: Math.max(0, state.energy - selected.state.energy),
    score: selected.score,
    explanation: {
      selected: releasesBeforeProduction ? "merge releases board space before deterministic production" : `${selected.firstAction.type} is the first safe action on the best feasible path`,
      pruned, consideredStates, goalDepth: selected.depth,
    },
  };
}

module.exports = {
  normalizePlannerState,
  simulateDeterministicTransition,
  simulateProductionOutcome,
  simulateWarehouseStoreProposal,
  planDeterministicOrder,
  comparePathScores,
  buildWarehouseStoreCandidates,
  buildWarehouseRetrieveCandidates,
  buildMergeCandidates,
};
