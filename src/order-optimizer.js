"use strict";

const { gridUnavailabilityReasons } = require("./inventory-availability");
const { normalizePlannerState, planDeterministicOrder, comparePathScores, buildWarehouseStoreCandidates, buildWarehouseRetrieveCandidates, buildMergeCandidates } = require("./space-planner");
const { selectProductionMode, selectableProductionModes } = require("./production-modes");
const { planStochasticOrder } = require("./stochastic-beam-search");
const { buildSaleSuggestions, normalizeSalePolicy } = require("./sale-policy");

function countBy(values, keyOf) {
  const result = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (key != null && key !== "") result.set(String(key), (result.get(String(key)) || 0) + 1);
  }
  return result;
}

function countsObject(grids) {
  return Object.fromEntries(countBy(grids, (grid) => grid.itemId));
}

function rankPlans(plans, strategy = "efficiency", prioritySlot = null) {
  const feasible = plans.filter((plan) => plan.feasible);
  const common = (a, b) => {
    if (a.pathScore && b.pathScore) {
      const comparison = comparePathScores(a.pathScore, b.pathScore);
      if (comparison) return comparison;
    }
    return Number(b.ready) - Number(a.ready) || Number(b.mergeOnly) - Number(a.mergeOnly);
  };
  if (strategy === "min-energy" || strategy === "fastest") {
    return [...feasible].sort((a, b) => common(a, b) || a.estimatedEnergy - b.estimatedEnergy || b.rewardCoins - a.rewardCoins);
  }
  if (strategy === "specified" && prioritySlot != null) {
    return [...feasible].sort((a, b) => Number(String(b.slot) === String(prioritySlot)) - Number(String(a.slot) === String(prioritySlot)) || common(a, b) || b.efficiency - a.efficiency);
  }
  return [...feasible].sort((a, b) => common(a, b) || b.efficiency - a.efficiency || a.estimatedEnergy - b.estimatedEnergy);
}

const EVIDENCE_FIELDS = Object.freeze({
  "item-identity": ["itemId", "chainId", "level", "baseUnits"],
  "merge-relation": ["itemId", "chainId", "level", "mergeTarget"],
  "production-profile": ["producerItemId", "energyCost", "planningDistribution"],
  "production-mode": ["producerItemId", "modeId", "energyCost", "outputs", "unlocked", "switchEntry", "humanLocked"],
});

function makeEvidenceBlocker(objectType, objectId, object = null) {
  const fields = EVIDENCE_FIELDS[objectType];
  return {
    objectType, objectId: String(objectId), status: object?.status || "missing", disposition: object?.disposition || "enabled",
    fields,
    requiredEvidence: ["structured-runtime", "human-ruling"],
    reviewTarget: { objectType, objectId: String(objectId) },
    scanAction: { type: "active-catalog-scan", itemId: objectType === "production-mode" ? String(objectId).split(":")[0] : String(objectId) },
  };
}

function catalogEvidenceBlock(catalog, orderSlot, itemIds, producerItemIds = [], productionModeIds = []) {
  const objects = new Map((catalog.evidence?.objects || []).map((object) => [`${object.objectType}:${object.objectId}`, object]));
  const blockers = [];
  const add = (objectType, objectId) => {
    const key = `${objectType}:${objectId}`;
    if (blockers.some((blocker) => `${blocker.objectType}:${blocker.objectId}` === key)) return;
    const object = objects.get(key) || null;
    if (object?.status === "active" && object.disposition === "enabled") return;
    blockers.push(makeEvidenceBlocker(objectType, objectId, object));
  };
  for (const itemId of itemIds) {
    add("item-identity", itemId);
    add("merge-relation", itemId);
  }
  for (const producerItemId of producerItemIds) add("production-profile", producerItemId);
  for (const productionModeId of productionModeIds) add("production-mode", productionModeId);
  return blockers.length ? { orderSlot: String(orderSlot), blockers } : null;
}

function buildOptimizationPlan({ catalog, state, boardScan, strategy = "efficiency", prioritySlot = null, salePolicy = null, executionMode = "observation" }) {
  const gameState = state?.schemaVersion === 1;
  const tasks = gameState ? (state.orders || []) : (state.tasks || []);
  const grids = gameState ? (state.board?.grids || []) : (boardScan?.grids || []);
  const energyAvailableValue = gameState ? state.resources.energy : state.energy?.[0]?.amount ?? state.resources?.find((item) => Number(item.type) === 3)?.amount;
  const energyAvailable = Number(energyAvailableValue);
  const itemById = new Map((catalog.items || []).map((item) => [String(item.id), item]));
  const inferredItemIds = new Set();
  const resolveItem = (itemId) => {
    const id = String(itemId);
    if (itemById.has(id)) return itemById.get(id);
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId)) return null;
    const candidates = (catalog.chains || []).filter((chain) => !chain.complete && chain.minLevel === 1 && Number.isSafeInteger(Number(chain.minItemId)))
      .map((chain) => ({ chain, level: numericId - Number(chain.minItemId) + 1 }))
      .filter(({ level }) => level >= 2 && level <= 15);
    if (candidates.length !== 1) return null;
    const { chain, level } = candidates[0];
    const inferred = { id, chainId: chain.id, level, baseUnits: 2 ** (level - 1), inferred: true };
    itemById.set(id, inferred);
    inferredItemIds.add(id);
    return inferred;
  };
  const producerById = new Map((catalog.producers || []).map((producer) => [String(producer.itemId), producer]));
  const normalizedState = gameState ? normalizePlannerState({ state, catalog }) : null;
  const warehouseKnowledge = normalizedState?.warehouse.inventoryKnowledge;
  const activePlanningItemIds = new Set((normalizedState?.catalog.items || []).filter((item) => item.evidenceSufficient).map((item) => item.id));
  const concreteWarehouseSlots = warehouseKnowledge?.status === "loaded" ? (warehouseKnowledge.slots || []).filter((slot) => slot.occupied && slot.itemId) : [];
  const trustedWarehouseSlots = warehouseKnowledge?.retrievalPath?.status === "trusted"
    ? (warehouseKnowledge.slots || []).filter((slot) => slot.occupied && slot.itemId && activePlanningItemIds.has(String(slot.itemId)))
    : [];
  const trustedWarehouseKeys = new Set(trustedWarehouseSlots.map((slot) => `${slot.slotId}:${slot.itemId}`));
  const unavailableWarehouseSlots = concreteWarehouseSlots.filter((slot) => !trustedWarehouseKeys.has(`${slot.slotId}:${slot.itemId}`));
  const warehouseCounts = countBy(trustedWarehouseSlots, (slot) => slot.itemId);
  const observableGrids = grids.filter((grid) => grid.itemId);
  const classifiedGrids = observableGrids.map((grid) => ({ grid, reasons: gridUnavailabilityReasons(grid) }));
  const executableGrids = classifiedGrids.filter((entry) => entry.reasons.length === 0).map((entry) => entry.grid);
  const unavailableGrids = classifiedGrids.filter((entry) => entry.reasons.length > 0).map((entry) => entry.grid);
  const unavailableItems = classifiedGrids
    .filter((entry) => entry.reasons.length > 0)
    .map(({ grid, reasons }) => ({ index: grid.index, itemId: String(grid.itemId), reasons }));
  const inventoryCounts = countBy(executableGrids, (grid) => grid.itemId);
  const unavailableCounts = countBy(unavailableGrids, (grid) => grid.itemId);
  const unavailableWarehouseCounts = countBy(unavailableWarehouseSlots, (slot) => slot.itemId);
  const allUnavailableCounts = new Map(unavailableCounts);
  for (const [itemId, count] of unavailableWarehouseCounts) allUnavailableCounts.set(itemId, (allUnavailableCounts.get(itemId) || 0) + count);
  const reservedCounts = countBy(tasks.flatMap((task) => task.items.filter((item) => item.complete)), (item) => item.itemId);
  const availableCounts = new Map(inventoryCounts);
  for (const [itemId, count] of reservedCounts) availableCounts.set(itemId, Math.max(0, (availableCounts.get(itemId) || 0) - count));
  const boardProducers = executableGrids.map((grid) => ({ grid, config: producerById.get(String(grid.itemId)) })).filter((entry) => entry.config);

  const hasExecutableMerge = (demands) => {
    const boardCandidates = gameState ? (state.board?.mergeCandidates || []) : (boardScan?.mergeCandidates || []);
    if (boardCandidates.some((candidate) => {
      const item = itemById.get(String(candidate.itemId));
      const demand = item ? demands.get(item.chainId) : null;
      return demand && Number(item.level || 0) < demand.maxTargetLevel;
    })) return true;
    const pairCounts = countBy(executableGrids.filter((grid) => {
      const item = itemById.get(String(grid.itemId));
      const demand = item ? demands.get(item.chainId) : null;
      return demand && Number(item.level || 0) < demand.maxTargetLevel;
    }), (grid) => grid.itemId);
    return [...pairCounts.values()].some((count) => count >= 2);
  };

  const plans = tasks.map((task) => {
    const missing = task.items.filter((item) => !item.complete);
    if (missing.length === 0) return {
      slot: task.slot, taskId: task.taskId, rewardCoins: task.rewardCoins ?? task.rewards?.find((reward) => Number(reward.type) === 1)?.count ?? task.awardValue,
      ready: true, feasible: true, actionable: true, estimatedEnergy: 0, efficiency: Infinity, missingItems: [], missingCatalogItemIds: [], producerSteps: [],
    };
    const missingCatalogItemIds = missing.map((item) => String(item.itemId)).filter((itemId) => !resolveItem(itemId));
    const demands = new Map();
    for (const requirement of missing) {
      const item = resolveItem(requirement.itemId);
      if (!item) continue;
      const current = demands.get(item.chainId) || { chainId: item.chainId, units: 0, maxTargetLevel: 0, targetItemIds: [] };
      current.units += Number(item.baseUnits || 0);
      current.maxTargetLevel = Math.max(current.maxTargetLevel, Number(item.level || 0));
      current.targetItemIds.push(item.id);
      demands.set(item.chainId, current);
    }
    for (const demand of demands.values()) {
      let boardSupply = 0;
      let warehouseSupply = 0;
      let unavailableSupply = 0;
      for (const [itemId, count] of availableCounts) {
        const item = itemById.get(itemId);
        if (item?.chainId === demand.chainId && item.level <= demand.maxTargetLevel) boardSupply += count * Number(item.baseUnits || 0);
      }
      for (const [itemId, count] of warehouseCounts) {
        const item = itemById.get(itemId);
        if (item?.chainId === demand.chainId && item.level <= demand.maxTargetLevel) warehouseSupply += count * Number(item.baseUnits || 0);
      }
      for (const [itemId, count] of allUnavailableCounts) {
        const item = itemById.get(itemId);
        if (item?.chainId === demand.chainId && item.level <= demand.maxTargetLevel) unavailableSupply += count * Number(item.baseUnits || 0);
      }
      demand.boardSupplyUnits = boardSupply;
      demand.warehouseSupplyUnits = warehouseSupply;
      demand.unavailableSupplyUnits = unavailableSupply;
      demand.availableUnits = boardSupply + warehouseSupply;
      demand.unavailableUnits = unavailableSupply;
      demand.deficitUnits = Math.max(0, demand.units - boardSupply - warehouseSupply);
    }
    const remaining = new Map([...demands].map(([chainId, demand]) => [chainId, demand.deficitUnits]));
    const producerSteps = new Map();
    const productionModeEvidenceGaps = new Set();
    let productionModeLockBlocked = false;
    let guard = 0;
    while ([...remaining.values()].some((value) => value > 1e-9) && guard++ < 100000) {
      let best = null;
      for (const producer of boardProducers) {
        const availableModeIds = new Set((producer.grid.availableProductionModes || []).filter((mode) => mode.unlocked !== false).map((mode) => String(mode.modeId)));
        const modeAwareRuntime = producer.grid.currentProductionModeId != null && availableModeIds.size > 0;
        const configuredModes = producer.config.modes || [];
        const selectableModes = selectableProductionModes({ modes: configuredModes, currentModeId: producer.grid.currentProductionModeId, availableModes: producer.grid.availableProductionModes, switchEntry: producer.grid.productionModeSwitchEntry });
        const modeDecision = selectProductionMode({
          producer: { ...producer.config, modes: selectableModes }, currentModeId: producer.grid.currentProductionModeId,
          demands: [...demands.values()].map((demand) => ({ ...demand, deficitUnits: remaining.get(demand.chainId) || 0 })),
          board: normalizedState?.board || { occupied: observableGrids.length, capacity: observableGrids.length },
        });
        if (modeAwareRuntime && !modeDecision) {
          productionModeEvidenceGaps.add(`${producer.config.itemId}:${producer.grid.currentProductionModeId}`);
          continue;
        }
        if (modeDecision?.executable === false) {
          if (modeDecision.reason === "human-mode-lock-infeasible") productionModeLockBlocked = true;
          continue;
        }
        const effectiveConfig = modeDecision ? { ...producer.config, energyCost: modeDecision.mode.energyCost, drops: modeDecision.mode.drops } : producer.config;
        const contribution = new Map();
        let usefulUnits = 0;
        for (const drop of effectiveConfig.drops || []) {
          const deficit = remaining.get(drop.chainId) || 0;
          if (deficit <= 0 || !drop.baseUnits) continue;
          const expected = Number(drop.probability) * Number(drop.count ?? drop.weight ?? 1) * Number(drop.baseUnits);
          contribution.set(drop.chainId, (contribution.get(drop.chainId) || 0) + expected);
          usefulUnits += Math.min(deficit, expected);
        }
        const score = usefulUnits / Math.max(1, Number(effectiveConfig.energyCost || 1));
        if (score > 0 && (!best || score > best.score)) best = { producer, contribution, score, modeDecision, effectiveConfig };
      }
      if (!best) break;
      const key = `${best.producer.grid.index}:${best.producer.config.itemId}:${best.modeDecision?.mode.modeId ?? "current"}`;
      const step = producerSteps.get(key) || {
        gridIndex: best.producer.grid.index, producerItemId: best.producer.config.itemId, clicks: 0, energy: 0,
        currentProductionModeId: best.producer.grid.currentProductionModeId,
        productionModeId: best.modeDecision?.mode.modeId ?? best.producer.grid.currentProductionModeId ?? null,
        productionModeDecision: best.modeDecision ? { metrics: best.modeDecision.metrics, reason: best.modeDecision.reason, shouldSwitch: best.modeDecision.shouldSwitch } : null,
      };
      step.clicks += 1;
      step.energy += Number(best.effectiveConfig.energyCost || 1);
      producerSteps.set(key, step);
      for (const [chainId, expected] of best.contribution) remaining.set(chainId, Math.max(0, (remaining.get(chainId) || 0) - expected));
    }
    const unresolvedChains = [...remaining].filter(([, units]) => units > 1e-9).map(([chainId, units]) => ({ chainId, deficitUnits: units }));
    const steps = [...producerSteps.values()];
    const estimatedEnergy = steps.reduce((sum, step) => sum + step.energy, 0);
    const rewardCoins = task.rewardCoins ?? task.rewards?.find((reward) => Number(reward.type) === 1)?.count ?? task.awardValue;
    const supplyFeasible = missingCatalogItemIds.length === 0 && unresolvedChains.length === 0;
    const mergeAvailable = supplyFeasible && steps.length === 0 && hasExecutableMerge(demands);
    const feasible = supplyFeasible && (steps.length > 0 || mergeAvailable);
    const hasUnavailableSupply = [...demands.values()].some((demand) => demand.unavailableUnits > 0 && demand.deficitUnits > 0);
    const unclassifiedProducerItemIds = executableGrids.filter((grid) => grid.produceCount != null && Number(grid.energyCost) > 0 && !producerById.has(String(grid.itemId))).map((grid) => String(grid.itemId));
    let evidenceBlock = catalogEvidenceBlock(catalog, task.slot, missingCatalogItemIds, unresolvedChains.length ? unclassifiedProducerItemIds : [], [...productionModeEvidenceGaps]);
    if (missingCatalogItemIds.length && !evidenceBlock) evidenceBlock = { orderSlot: String(task.slot), blockers: missingCatalogItemIds.map((itemId) => makeEvidenceBlocker("merge-relation", itemId)) };
    const blockingReason = feasible ? null
      : evidenceBlock ? "catalog-evidence-insufficient"
        : productionModeLockBlocked ? "production-mode-human-lock-unavailable"
        : hasUnavailableSupply ? "inventory-unavailable"
          : unresolvedChains.length > 0 ? "no-executable-producer"
            : "no-executable-action";
    return {
      slot: task.slot,
      taskId: task.taskId,
      rewardCoins,
      ready: false,
      feasible,
      actionable: feasible,
      supplyFeasible,
      mergeOnly: feasible && mergeAvailable,
      estimatedEnergy: feasible ? estimatedEnergy : null,
      efficiency: feasible && estimatedEnergy > 0 ? rewardCoins / estimatedEnergy : 0,
      missingItems: missing.map((item) => item.itemId),
      missingCatalogItemIds,
      demands: [...demands.values()],
      unresolvedChains,
      producerSteps: steps,
      blockingReason,
      evidenceBlock,
    };
  });

  let warehouseStoreCandidates = [];
  let warehouseRetrieveCandidates = [];
  let specifiedResolvedPlan = null;
  if (gameState) {
    warehouseStoreCandidates = buildWarehouseStoreCandidates(normalizedState);
    const hasStochasticProduction = (catalog.producers || []).some((producer) => {
      const distributions = producer.modes?.length ? producer.modes.map((mode) => mode.drops || []) : [producer.drops || []];
      return distributions.some((drops) => drops.length !== 1 || Number(drops[0]?.probability) !== 1);
    });
    const detailPlan = (plan) => {
      const stateRevision = state.board?.signature || state.collectedAt || `${normalizedState.board.occupied}:${normalizedState.energy}:${normalizedState.warehouse.inventoryKnowledge.revision || "warehouse-unknown"}`;
      const spacePlan = hasStochasticProduction && normalizedState.board.spaceKnown
        ? planStochasticOrder(normalizedState, plan.slot, { catalogRevision: catalog.revision, stateRevision })
        : planDeterministicOrder(normalizedState, plan.slot);
      plan.nextAction = spacePlan.nextAction;
      plan.boardSpaceFeasibility = spacePlan.boardSpaceFeasibility;
      plan.explanation = spacePlan.explanation;
      plan.pathScore = spacePlan.score || null;
      if (plan.blockingReason === "production-mode-human-lock-unavailable") {
        plan.nextAction = null;
        plan.feasible = false;
        plan.actionable = false;
        plan.explanation = "Human Catalog Ruling locks a production mode that is not currently executable; algorithmic mode switching is blocked.";
        return;
      }
      if (spacePlan.status === "planned") {
        plan.actionable = true;
        if (!plan.evidenceBlock && plan.blockingReason !== "inventory-unavailable") plan.feasible = true;
        if (!plan.ready && Number.isFinite(spacePlan.energyRequired)) {
          const selectedModeEnergy = plan.producerSteps.some((step) => step.productionModeId) ? plan.producerSteps.reduce((sum, step) => sum + Number(step.energy || 0), 0) : null;
          plan.estimatedEnergy = selectedModeEnergy ?? spacePlan.energyRequired;
          plan.efficiency = plan.estimatedEnergy > 0 ? plan.rewardCoins / plan.estimatedEnergy : 0;
        }
      } else if (normalizedState.board.spaceKnown && spacePlan.reason === "board-space-deadlock") {
        plan.feasible = false;
        plan.actionable = false;
        plan.blockingReason = "board-space-deadlock";
      } else if (spacePlan.reason === "insufficient-energy") {
        plan.feasible = false;
        plan.actionable = false;
        plan.blockingReason = "insufficient-energy";
      } else if (spacePlan.reason === "stochastic-space-risk") {
        plan.feasible = false;
        plan.actionable = false;
        plan.blockingReason = "stochastic-space-risk";
      } else if (!hasStochasticProduction && spacePlan.reason === "deterministic-path-not-found" && plan.supplyFeasible) {
        plan.feasible = false;
        plan.actionable = false;
        plan.blockingReason = "deterministic-path-not-found";
      }
      const retrieveCandidates = buildWarehouseRetrieveCandidates(normalizedState, plan.slot);
      warehouseRetrieveCandidates.push(...retrieveCandidates.map((candidate) => ({ ...candidate, orderSlot: String(plan.slot) })));
      if (!plan.ready && retrieveCandidates.length) {
        plan.nextAction = retrieveCandidates[0];
        plan.feasible = true;
        plan.actionable = true;
        plan.blockingReason = null;
        plan.explanation = "Trusted warehouse supply can be retrieved through the native click path; replan after observing its actual landing.";
      }
      const modeStep = plan.producerSteps.find((step) => Number(step.gridIndex) === Number(plan.nextAction?.producer)) || plan.producerSteps[0];
      if (modeStep?.productionModeDecision?.metrics && plan.boardSpaceFeasibility) {
        plan.boardSpaceFeasibility.peakOccupied = Math.max(Number(plan.boardSpaceFeasibility.peakOccupied || 0), Number(modeStep.productionModeDecision.metrics.peakOccupied || 0));
      }
      if (!retrieveCandidates.length && modeStep?.productionModeId && (plan.nextAction?.type === "produce" || (!plan.nextAction && plan.feasible))) {
        if (String(modeStep.currentProductionModeId) !== String(modeStep.productionModeId)) {
          plan.nextAction = {
            type: "switch-production-mode", producer: modeStep.gridIndex, producerItemId: modeStep.producerItemId,
            currentModeId: modeStep.currentProductionModeId, productionModeId: modeStep.productionModeId,
            decision: modeStep.productionModeDecision,
          };
        } else if (plan.nextAction?.type === "produce") {
          plan.nextAction = { ...plan.nextAction, productionModeId: modeStep.productionModeId, productionModeDecision: modeStep.productionModeDecision };
        }
      }
    };
    if (strategy === "specified") {
      const requested = prioritySlot == null ? null : plans.find((plan) => String(plan.slot) === String(prioritySlot));
      const fallbackCandidates = plans.filter((plan) => plan !== requested);
      const rankedFallbacks = rankPlans(fallbackCandidates, "efficiency");
      const rankedSlots = new Set(rankedFallbacks.map((plan) => String(plan.slot)));
      const detailOrder = [requested, ...rankedFallbacks, ...fallbackCandidates.filter((plan) => !rankedSlots.has(String(plan.slot)))].filter(Boolean);
      for (const plan of detailOrder) {
        detailPlan(plan);
        if (plan.ready || plan.nextAction) {
          specifiedResolvedPlan = plan;
          break;
        }
      }
    } else {
      for (const plan of plans) detailPlan(plan);
    }
  }

  for (const plan of plans) plan.affordable = plan.feasible && (plan.ready || !Number.isFinite(energyAvailable) || plan.estimatedEnergy <= energyAvailable);
  const feasible = plans.filter((plan) => plan.feasible);
  const recommended = strategy === "specified" && gameState ? specifiedResolvedPlan : rankPlans(plans, strategy, prioritySlot)[0] || null;
  const lowestEnergy = [...feasible].sort((a, b) => a.estimatedEnergy - b.estimatedEnergy || b.rewardCoins - a.rewardCoins)[0] || null;
  const evidenceBlocks = plans.map((plan) => plan.evidenceBlock).filter(Boolean);
  const allCatalogBlocked = plans.length > 0 && plans.every((plan) => !!plan.evidenceBlock);
  const warehouseInventoryLoadRequired = warehouseKnowledge?.status !== "loaded" && plans.some((plan) => !plan.ready && !plan.feasible && !plan.evidenceBlock);
  const warehouseLoadRequest = warehouseInventoryLoadRequired ? {
    reason: "concrete-order-supply-required",
    orderSlots: plans.filter((plan) => !plan.ready && !plan.feasible && !plan.evidenceBlock).map((plan) => String(plan.slot)),
    itemIds: [...new Set(plans.filter((plan) => !plan.ready && !plan.feasible && !plan.evidenceBlock).flatMap((plan) => plan.missingItems.map(String)))],
  } : null;
  const boundaryReason = recommended ? null
    : allCatalogBlocked ? "evidence-waiting"
      : plans.find((plan) => plan.blockingReason === "inventory-unavailable")?.blockingReason
      || plans.find((plan) => plan.blockingReason)?.blockingReason
      || "no-feasible-order";
  const saleSuggestions = normalizedState ? buildSaleSuggestions(normalizedState, {
    policy: normalizeSalePolicy(salePolicy || {}),
    spacePressureUnresolved: !recommended && ["board-space-deadlock", "stochastic-space-risk"].includes(boundaryReason),
    safeMergeAvailable: buildMergeCandidates(normalizedState).length > 0,
    warehouseBufferAvailable: warehouseStoreCandidates.length > 0 && normalizedState.warehouse.inventoryKnowledge.exchangeCapacity !== 0,
  }) : [];
  return {
    generatedAt: new Date().toISOString(),
    energyAvailable: Number.isFinite(energyAvailable) ? energyAvailable : null,
    catalogCoverage: catalog.coverage,
    inferredCatalogItemIds: [...inferredItemIds],
    boardProducerIds: boardProducers.map((entry) => ({ gridIndex: entry.grid.index, itemId: entry.config.itemId, level: entry.config.level })),
    inventory: {
      observable: { total: observableGrids.length, counts: countsObject(observableGrids) },
      executable: { total: executableGrids.length, counts: countsObject(executableGrids) },
      unavailable: { total: unavailableItems.length, counts: countsObject(unavailableGrids), items: unavailableItems },
      boardSupply: { total: executableGrids.length, counts: countsObject(executableGrids) },
      warehouseSupply: { total: trustedWarehouseSlots.length, counts: countsObject(trustedWarehouseSlots) },
      unavailableSupply: {
        total: unavailableItems.length + unavailableWarehouseSlots.length,
        counts: Object.fromEntries(allUnavailableCounts),
        items: [...unavailableItems, ...unavailableWarehouseSlots.map((slot) => ({ warehouseSlotId: slot.slotId, itemId: slot.itemId, reasons: [warehouseKnowledge?.retrievalPath?.status === "trusted" ? "catalog-evidence-insufficient" : "warehouse-retrieval-path-untrusted"] }))],
      },
    },
    warehouse: normalizedState ? {
      inventoryKnowledge: normalizedState.warehouse.inventoryKnowledge,
      storeAvailability: normalizedState.warehouse.storeAvailability,
      exchangeCapacity: normalizedState.warehouse.inventoryKnowledge.exchangeCapacity,
    } : null,
    warehouseStoreCandidates,
    warehouseRetrieveCandidates,
    warehouseInventoryLoadRequired,
    warehouseLoadRequest,
    saleSuggestions,
    saleExecutionPolicy: { mode: executionMode, confirmationRequired: true, automaticEnabled: false },
    plans,
    status: allCatalogBlocked ? "evidence-waiting" : recommended ? "ready" : "waiting",
    evidenceBlocks,
    recommended,
    lowestEnergy,
    boundaryReason,
    strategy,
    prioritySlot: strategy === "specified" ? prioritySlot : null,
    resolvedPrioritySlot: strategy === "specified" ? specifiedResolvedPlan?.slot ?? null : null,
  };
}

function printOptimizationPlan(plan, output = console) {
  output.log(`当前体力：${plan.energyAvailable ?? "unknown"}`);
  output.log("\n订单梯度评估：");
  output.table(plan.plans.map((item) => ({
    槽位: item.slot,
    奖励金币: item.rewardCoins,
    缺少物品: item.missingItems.join(", ") || "-",
    预计体力: item.estimatedEnergy ?? "数据不足",
    金币每体力: Number.isFinite(item.efficiency) ? item.efficiency.toFixed(2) : "∞",
    状态: item.ready ? "可提交" : item.feasible ? "可规划" : item.missingCatalogItemIds.length ? "缺少图鉴" : "无可用产出物",
  })));
  if (plan.recommended) {
    output.log(`\n推荐订单：${plan.recommended.slot}，预计体力 ${plan.recommended.estimatedEnergy}，奖励 ${plan.recommended.rewardCoins} 金币`);
    output.table(plan.recommended.producerSteps.map((step) => ({ 产出物格子: step.gridIndex, 产出物ID: step.producerItemId, 预计点击: step.clicks, 预计体力: step.energy })));
  }
  const missing = [...new Set(plan.plans.flatMap((item) => item.missingCatalogItemIds))];
  if (missing.length) output.log(`\n仍需补充状态栏图鉴的物品ID：${missing.join(", ")}`);
  const unresolved = [...new Set(plan.plans.flatMap((item) => item.unresolvedChains || []).map((item) => item.chainId))];
  if (unresolved.length) output.log(`当前棋盘没有对应产出物的合成链：${unresolved.join(", ")}`);
  if (plan.inferredCatalogItemIds?.length) output.log(`按连续等级规则推断的物品ID：${plan.inferredCatalogItemIds.join(", ")}`);
}

module.exports = { buildOptimizationPlan, printOptimizationPlan, rankPlans };
