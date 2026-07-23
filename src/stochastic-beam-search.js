"use strict";

const { createHash } = require("node:crypto");
const { canonicalJson } = require("./canonical-json");
const { selectableProductionModes } = require("./production-modes");
const {
  simulateDeterministicTransition,
  simulateProductionOutcome,
  simulateWarehouseStoreProposal,
  comparePathScores,
  buildWarehouseStoreCandidates,
  buildWarehouseRetrieveCandidates,
  buildMergeCandidates,
} = require("./space-planner");

const MAX_SEARCH_DEPTH = 12;
const MAX_BEAM_WIDTH = 64;
const UNKNOWN_PRODUCTION_OUTCOME = "__unknown_production_outcome__";

function orderFor(state, orderSlot) {
  return state.orders.find((order) => String(order.slot) === String(orderSlot)) || null;
}

function orderSatisfied(state, orderSlot) {
  return orderFor(state, orderSlot)?.ready === true;
}

function orderProgress(state, orderSlot) {
  const order = orderFor(state, orderSlot);
  if (!order?.items?.length) return order?.ready ? 1 : 0;
  return order.items.filter((item) => item.complete).length / order.items.length;
}

function orderMaterialProgress(state, orderSlot) {
  const order = orderFor(state, orderSlot);
  const missing = order?.items?.filter((item) => !item.complete) || [];
  if (!missing.length) return order?.ready ? 1 : 0;
  const items = new Map((state.catalog.items || []).map((item) => [String(item.id), item]));
  const available = [...(state.board.grids || []).filter((grid) => !grid.empty), ...(state.warehouse?.inventoryKnowledge?.slots || []).filter((slot) => slot.occupied)];
  let progress = 0;
  for (const requirement of missing) {
    const target = items.get(String(requirement.itemId));
    const targetUnits = Number(target?.baseUnits || 0);
    if (!target?.chainId || targetUnits <= 0) continue;
    const availableUnits = available.reduce((sum, entry) => {
      const item = items.get(String(entry.itemId || ""));
      return String(item?.chainId) === String(target.chainId) && Number(item.level || 0) <= Number(target.level || 0)
        ? sum + Number(item.baseUnits || 0) : sum;
    }, 0);
    progress += Math.min(1, availableUnits / targetUnits);
  }
  return progress / missing.length;
}

function adaptiveSearchBudget(state, orderSlot) {
  const order = orderFor(state, orderSlot);
  const remaining = order?.items?.filter((item) => !item.complete).length ?? Infinity;
  const tightSpace = Number(state.board.empty) <= 2;
  const nearCompletion = remaining <= 1;
  const simple = Number(state.board.empty) >= 4 && remaining > 1 && state.catalog.producers.length <= 1;
  const maxDepth = tightSpace || nearCompletion ? 4 : simple ? 2 : 3;
  const maxWidth = tightSpace || nearCompletion ? 8 : simple ? 4 : 6;
  return { maxDepth: Math.min(MAX_SEARCH_DEPTH, maxDepth), maxWidth: Math.min(MAX_BEAM_WIDTH, maxWidth), reason: simple ? "simple-state" : tightSpace ? "space-pressure" : nearCompletion ? "near-order-completion" : "standard" };
}

function outcomeCount(action) {
  const projected = Number(action.planningDistribution?.feasibilityOutcomesPerAction);
  if (Number.isFinite(projected) && projected > 0) return Math.max(1, Math.ceil(projected));
  return Math.max(1, Math.ceil(Math.max(...(action.drops || []).map((drop) => Number(drop.count || 1)), 1)));
}

function representativeProductionBranches(state, action, orderSlot) {
  const drops = (action.drops || []).filter((drop) => drop.itemId && Number(drop.probability) > 0)
    .sort((left, right) => Number(right.probability) - Number(left.probability) || String(left.itemId).localeCompare(String(right.itemId)));
  const uncertaintyMass = Number(action.planningDistribution?.uncertaintyMass || 0);
  if (uncertaintyMass > 0) drops.push({ itemId: UNKNOWN_PRODUCTION_OUTCOME, probability: uncertaintyMass, count: outcomeCount(action), unknown: true });
  drops.sort((left, right) => Number(right.probability) - Number(left.probability) || String(left.itemId).localeCompare(String(right.itemId)));
  if (!drops.length) return [];
  const count = outcomeCount(action);
  const order = orderFor(state, orderSlot);
  const demanded = new Set((order?.items || []).filter((item) => !item.complete).map((item) => String(item.itemId)));
  const common = drops[0];
  const conservative = [...drops].sort((left, right) => Number(demanded.has(String(left.itemId))) - Number(demanded.has(String(right.itemId))) || Number(left.probability) - Number(right.probability) || String(left.itemId).localeCompare(String(right.itemId)))[0];
  const mergePartners = (drop) => drop.unknown ? -1 : state.board.grids.filter((grid) => !grid.empty && grid.executable && !grid.protected && String(grid.itemId) === String(drop.itemId)).length;
  const adversarialSpaceDrops = [...drops].sort((left, right) => mergePartners(left) - mergePartners(right) || Number(left.probability) - Number(right.probability) || String(left.itemId).localeCompare(String(right.itemId)));
  const worstSpace = Array.from({ length: count }, (_, index) => String(adversarialSpaceDrops[index % adversarialSpaceDrops.length].itemId));
  const repeat = (drop) => Array.from({ length: count }, () => String(drop.itemId));
  return [
    { kind: "common", probability: Number(common.probability) ** count, outcomeItemIds: repeat(common) },
    { kind: "conservative", probability: Number(conservative.probability) ** count, outcomeItemIds: repeat(conservative) },
    { kind: "worst-space", probability: Math.min(...adversarialSpaceDrops.map((drop) => Number(drop.probability))), outcomeItemIds: worstSpace },
  ];
}

function productionActions(state) {
  const actions = [];
  for (const producer of state.catalog.producers) for (const grid of state.board.grids.filter((entry) => entry.itemId === producer.itemId && entry.executable)) {
    const configuredModes = producer.modes?.length ? producer.modes : [{ modeId: grid.currentProductionModeId || "current", energyCost: producer.energyCost, drops: producer.drops, unlocked: true }];
    const modes = selectableProductionModes({ modes: configuredModes, currentModeId: grid.currentProductionModeId, availableModes: grid.availableProductionModes, switchEntry: grid.productionModeSwitchEntry });
    for (const mode of modes.filter((candidate) => candidate.unlocked !== false && !candidate.inferred)) {
      if (mode.requiresSwitch) {
        actions.push({ type: "switch-production-mode", producer: grid.index, producerItemId: producer.itemId, currentModeId: grid.currentProductionModeId, productionModeId: mode.modeId });
        continue;
      }
      actions.push({
        type: "produce", producer: grid.index, producerItemId: producer.itemId, productionModeId: mode.modeId,
        energyCost: Number(mode.energyCost ?? producer.energyCost), drops: mode.drops || producer.drops,
        planningDistribution: mode.planningDistribution || null,
      });
    }
  }
  return actions;
}

function candidateActions(state, orderSlot, { includeWarehouseStore = state.board.empty <= 0 || state.warehouse.storeAvailability?.status === "available" } = {}) {
  const actions = [];
  if (orderSatisfied(state, orderSlot)) actions.push({ type: "submit-order", slot: String(orderSlot) });
  actions.push(...buildWarehouseRetrieveCandidates(state, orderSlot));
  actions.push(...buildMergeCandidates(state, null, { canonicalOnly: true }));
  actions.push(...productionActions(state));
  if (includeWarehouseStore) {
    actions.push(...buildWarehouseStoreCandidates(state));
  }
  return actions.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function simulateCandidateAction(state, action) {
  if (action.type === "store-to-warehouse" && action.storeAvailability?.status !== "available") {
    return simulateWarehouseStoreProposal(state, action);
  }
  return simulateDeterministicTransition(state, action);
}

function hasImmediateRelease(state) {
  return state.board.empty > 0 || state.orders.some((order) => order.ready)
    || buildMergeCandidates(state, null, { canonicalOnly: true }).length > 0;
}

function contingentBranchSafe(state, orderSlot, depth, width, seen = new Set()) {
  if (orderSatisfied(state, orderSlot)) return true;
  if (!hasImmediateRelease(state)) return false;
  if (depth <= 0) return true;
  const identity = canonicalJson(state);
  if (seen.has(identity)) return false;
  const nextSeen = new Set(seen).add(identity);
  for (const action of candidateActions(state, orderSlot, { includeWarehouseStore: false }).slice(0, width)) {
    if (action.type === "produce") {
      const outcomes = representativeProductionBranches(state, action, orderSlot).map((branch) => simulateProductionOutcome(state, action, branch.outcomeItemIds));
      if (outcomes.length && outcomes.every((transition) => transition.ok && contingentBranchSafe(transition.state, orderSlot, depth - 1, width, nextSeen))) return true;
      continue;
    }
    const transition = simulateCandidateAction(state, action);
    if (transition.ok && contingentBranchSafe(transition.state, orderSlot, depth - 1, width, nextSeen)) return true;
  }
  for (const action of buildWarehouseStoreCandidates(state).slice(0, width)) {
    const transition = simulateCandidateAction(state, action);
    if (transition.ok && contingentBranchSafe(transition.state, orderSlot, depth - 1, width, nextSeen)) return true;
  }
  return false;
}

function nodeScore(node, orderSlot) {
  return {
    safe: node.safe,
    boardSpaceFeasible: node.safe && node.minimumEmpty >= 0,
    peakOccupied: node.peakOccupied,
    orderProgress: orderProgress(node.state, orderSlot),
    mapProgressCoins: 0,
    opportunityLoss: node.opportunityLoss,
    saleReturn: 0,
    actionCount: node.depth,
    tieBreaker: JSON.stringify(node.firstAction || {}),
  };
}

function normalizedCacheKey(state, orderSlot, catalogRevision, stateRevision) {
  const serialized = canonicalJson({ orderSlot: String(orderSlot), catalogRevision: String(catalogRevision || "unknown"), stateRevision: String(stateRevision || "unknown"), state });
  return `stochastic-plan:${createHash("sha256").update(serialized).digest("hex")}`;
}

class StochasticPlanCache {
  constructor(maxEntries = 64) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 64);
    this.entries = new Map();
  }

  get(key) {
    const value = this.entries.get(key);
    if (!value) return null;
    this.entries.delete(key);
    this.entries.set(key, value);
    return structuredClone(value);
  }

  set(key, value) {
    this.entries.set(key, structuredClone(value));
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
}

const defaultCache = new StochasticPlanCache();

function planStochasticOrder(state, orderSlot, options = {}) {
  const budget = { ...adaptiveSearchBudget(state, orderSlot), ...(options.maxDepth == null ? {} : { maxDepth: Math.min(MAX_SEARCH_DEPTH, Number(options.maxDepth)) }), ...(options.maxWidth == null ? {} : { maxWidth: Math.min(MAX_BEAM_WIDTH, Number(options.maxWidth)) }) };
  const cache = options.cache || defaultCache;
  const key = normalizedCacheKey(state, orderSlot, options.catalogRevision, options.stateRevision);
  const cached = cache.get(key);
  if (cached) return { ...cached, explanation: { ...cached.explanation, cache: { hit: true, key } } };
  const order = orderFor(state, orderSlot);
  if (!order) return { status: "blocked", reason: "order-not-found", nextAction: null, explanation: { selected: null, riskBranches: [], searchBudget: budget, cache: { hit: false, key } } };
  if (order.ready) {
    const result = {
      status: "planned", nextAction: { type: "submit-order", slot: String(orderSlot) },
      boardSpaceFeasibility: { feasible: true, peakOccupied: state.board.occupied, capacity: state.board.capacity, minimumEmpty: state.board.empty },
      energyRequired: 0,
      score: { safe: true, boardSpaceFeasible: true, peakOccupied: state.board.occupied, orderProgress: 1, mapProgressCoins: Math.min(Number(order.rewardCoins || 0), Number(state.mapCoinDeficit || 0)), opportunityLoss: 0, saleReturn: 0, actionCount: 1, tieBreaker: `submit:${orderSlot}` },
      explanation: { selected: "submit-order is the first safe action from the bounded stochastic beam", selectedReason: "order-ready", riskBranches: [], pruned: {}, consideredStates: 1, goalDepth: 1, searchBudget: budget, cache: { hit: false, key } },
    };
    cache.set(key, result);
    return result;
  }

  const immediateMerges = buildMergeCandidates(state, null, { canonicalOnly: true })
    .map((action) => ({ action, transition: simulateDeterministicTransition(state, action) }))
    .filter(({ transition }) => transition.ok)
    .map(({ action, transition }) => ({
      action,
      transition,
      score: {
        safe: true,
        boardSpaceFeasible: transition.state.board.empty >= 0,
        peakOccupied: state.board.occupied,
        orderProgress: orderProgress(transition.state, orderSlot),
        mapProgressCoins: 0,
        opportunityLoss: Number(transition.opportunityCost || 0),
        saleReturn: 0,
        actionCount: 1,
        tieBreaker: JSON.stringify(action),
      },
    }))
    .sort((left, right) => comparePathScores(left.score, right.score));
  if (immediateMerges.length) {
    const selected = immediateMerges[0];
    const result = {
      status: "planned",
      nextAction: selected.action,
      boardSpaceFeasibility: {
        feasible: true,
        peakOccupied: state.board.occupied,
        capacity: state.board.capacity,
        minimumEmpty: selected.transition.state.board.empty,
      },
      energyRequired: 0,
      score: selected.score,
      explanation: {
        selected: "merge safely releases board space before stochastic production expansion",
        selectedReason: "safe-space-release",
        expectedEnergy: 0,
        expectedEnergyBasis: "deterministic merge",
        representativeCoverage: 1,
        requiresNativePreflight: false,
        riskBranches: [],
        selectedRiskBranches: [],
        pruned: {},
        consideredStates: 1,
        goalDepth: 1,
        searchBudget: budget,
        cache: { hit: false, key },
      },
    };
    cache.set(key, result);
    return result;
  }

  const initialMaterialProgress = orderMaterialProgress(state, orderSlot);
  const immediateProductions = [];
  for (const action of productionActions(state)) {
    const branches = representativeProductionBranches(state, action, orderSlot);
    const outcomes = branches.map((branch) => {
      const transition = simulateProductionOutcome(state, action, branch.outcomeItemIds);
      const immediateSafe = transition.ok && hasImmediateRelease(transition.state);
      const safe = immediateSafe && contingentBranchSafe(transition.state, orderSlot, 1, Math.min(4, budget.maxWidth));
      return {
        branch,
        transition,
        detail: {
          kind: branch.kind,
          probability: branch.probability,
          outcomeItemIds: branch.outcomeItemIds,
          safe,
          peakOccupied: transition.ok ? transition.state.board.occupied : state.board.occupied,
          minimumEmpty: transition.ok ? transition.state.board.empty : state.board.empty,
          reason: transition.ok ? safe ? "bounded-contingent-branch-feasible" : immediateSafe ? "no-safe-contingent-continuation" : "board-space-no-release" : transition.reason,
        },
      };
    });
    if (!outcomes.length || outcomes.some((outcome) => !outcome.detail.safe)) continue;
    const probabilityMass = outcomes.reduce((sum, outcome) => sum + Number(outcome.branch.probability || 0), 0) || outcomes.length;
    const weightedProgress = outcomes.reduce((sum, outcome) => sum + orderMaterialProgress(outcome.transition.state, orderSlot) * (Number(outcome.branch.probability || 0) || 1), 0) / probabilityMass;
    if (weightedProgress <= initialMaterialProgress + 1e-12) continue;
    immediateProductions.push({
      action: { ...action, predictedBranches: outcomes.map((outcome) => outcome.detail) },
      outcomes,
      expectedMaterialProgress: weightedProgress,
      minimumEmpty: Math.min(...outcomes.map((outcome) => outcome.transition.state.board.empty)),
      peakOccupied: Math.max(...outcomes.map((outcome) => outcome.transition.state.board.occupied)),
    });
  }
  immediateProductions.sort((left, right) => right.expectedMaterialProgress - left.expectedMaterialProgress
    || left.peakOccupied - right.peakOccupied || Number(left.action.energyCost || 0) - Number(right.action.energyCost || 0)
    || JSON.stringify(left.action).localeCompare(JSON.stringify(right.action)));
  if (immediateProductions.length) {
    const selected = immediateProductions[0];
    const result = {
      status: "planned",
      nextAction: selected.action,
      boardSpaceFeasibility: { feasible: selected.minimumEmpty >= 0, peakOccupied: selected.peakOccupied, capacity: state.board.capacity, minimumEmpty: selected.minimumEmpty },
      energyRequired: Number(selected.action.energyCost || 0),
      score: { safe: true, boardSpaceFeasible: selected.minimumEmpty >= 0, peakOccupied: selected.peakOccupied, orderProgress: selected.expectedMaterialProgress, mapProgressCoins: 0, opportunityLoss: 0, saleReturn: 0, actionCount: 1, tieBreaker: JSON.stringify(selected.action) },
      explanation: {
        selected: "produce is the safe immediate fast path from the bounded stochastic beam with one-step contingency",
        selectedReason: "safe-immediate-production",
        expectedEnergy: Number(selected.action.energyCost || 0),
        expectedEnergyBasis: "single rolling production action",
        representativeCoverage: selected.outcomes.length,
        requiresNativePreflight: false,
        riskBranches: selected.action.predictedBranches,
        selectedRiskBranches: selected.action.predictedBranches,
        pruned: {}, consideredStates: 1, goalDepth: 1, searchBudget: budget, cache: { hit: false, key },
      },
    };
    cache.set(key, result);
    return result;
  }

  let beam = [{ state, firstAction: null, depth: 0, peakOccupied: state.board.occupied, minimumEmpty: state.board.empty, energyUsed: 0, probability: 1, opportunityLoss: 0, safe: true, riskBranches: [] }];
  const visited = new Set([canonicalJson(state)]);
  const goals = [];
  const rollingNodes = [];
  const pruned = {};
  const riskBranches = [];
  let consideredStates = 0;
  for (let depth = 0; depth < budget.maxDepth && beam.length; depth += 1) {
    const expanded = [];
    for (const node of beam) {
      consideredStates += 1;
      for (const action of candidateActions(node.state, orderSlot)) {
        if (action.type === "produce") {
          const branches = representativeProductionBranches(node.state, action, orderSlot);
          const outcomes = branches.map((branch) => {
            const transition = simulateProductionOutcome(node.state, action, branch.outcomeItemIds);
            const immediateSafe = transition.ok && hasImmediateRelease(transition.state);
            const contingentDepth = 1;
            const safe = immediateSafe && contingentBranchSafe(transition.state, orderSlot, Math.min(contingentDepth, budget.maxDepth - node.depth - 1), Math.min(4, budget.maxWidth));
            const detail = { kind: branch.kind, probability: branch.probability, outcomeItemIds: branch.outcomeItemIds, safe, peakOccupied: transition.ok ? transition.state.board.occupied : node.state.board.occupied, minimumEmpty: transition.ok ? transition.state.board.empty : node.state.board.empty, reason: transition.ok ? safe ? "bounded-contingent-branch-feasible" : immediateSafe ? "no-safe-contingent-continuation" : "board-space-no-release" : transition.reason };
            riskBranches.push(detail);
            return { branch, transition, detail };
          });
          if (!outcomes.length || outcomes.some((outcome) => !outcome.detail.safe)) {
            pruned["stochastic-space-risk"] = (pruned["stochastic-space-risk"] || 0) + 1;
            continue;
          }
          const firstAction = node.firstAction || { ...action, predictedBranches: outcomes.map((outcome) => outcome.detail) };
          for (const outcome of outcomes) {
            const next = outcome.transition.state;
            expanded.push({ state: next, firstAction, depth: node.depth + 1, peakOccupied: Math.max(node.peakOccupied, next.board.occupied), minimumEmpty: Math.min(node.minimumEmpty, next.board.empty), energyUsed: node.energyUsed + Number(outcome.transition.energyCost || 0), probability: node.probability * outcome.branch.probability, opportunityLoss: node.opportunityLoss, safe: true, riskBranches: [...node.riskBranches, outcome.detail] });
          }
          continue;
        }
        const transition = simulateCandidateAction(node.state, action);
        if (!transition.ok) { pruned[transition.reason] = (pruned[transition.reason] || 0) + 1; continue; }
        const next = transition.state;
        expanded.push({ state: next, firstAction: node.firstAction || action, depth: node.depth + 1, peakOccupied: Math.max(node.peakOccupied, next.board.occupied), minimumEmpty: Math.min(node.minimumEmpty, next.board.empty), energyUsed: node.energyUsed + Math.max(0, node.state.energy - next.energy), probability: node.probability, opportunityLoss: node.opportunityLoss + Number(transition.opportunityCost || 0), safe: true, riskBranches: node.riskBranches });
      }
    }
    const unique = [];
    if (depth === 0) rollingNodes.push(...expanded);
    for (const node of expanded) {
      if (orderSatisfied(node.state, orderSlot)) goals.push(node);
      const stateIdentity = canonicalJson(node.state);
      if (visited.has(stateIdentity)) { pruned["duplicate-state"] = (pruned["duplicate-state"] || 0) + 1; continue; }
      visited.add(stateIdentity);
      unique.push(node);
    }
    unique.sort((left, right) => comparePathScores(nodeScore(left, orderSlot), nodeScore(right, orderSlot)) || right.probability - left.probability || left.energyUsed - right.energyUsed);
    beam = unique.slice(0, budget.maxWidth);
  }

  let result;
  if (!goals.length) {
    const groupedRollingNodes = new Map();
    for (const node of rollingNodes) {
      const actionKey = JSON.stringify(node.firstAction);
      if (!groupedRollingNodes.has(actionKey)) groupedRollingNodes.set(actionKey, []);
      groupedRollingNodes.get(actionKey).push(node);
    }
    const rollingCandidates = [...groupedRollingNodes.values()].map((siblings) => {
      const probabilityMass = siblings.reduce((sum, node) => sum + Number(node.probability || 0), 0) || siblings.length;
      const weighted = (read) => siblings.reduce((sum, node) => sum + read(node) * (Number(node.probability || 0) || 1), 0) / probabilityMass;
      return {
        siblings,
        node: siblings[0],
        expectedMaterialProgress: weighted((node) => orderMaterialProgress(node.state, orderSlot)),
        expectedEmpty: weighted((node) => Number(node.state.board.empty || 0)),
        expectedEnergy: weighted((node) => Number(node.energyUsed || 0)),
        peakOccupied: Math.max(...siblings.map((node) => Number(node.peakOccupied || 0))),
        minimumEmpty: Math.min(...siblings.map((node) => Number(node.minimumEmpty || 0))),
      };
    }).filter((candidate) => candidate.expectedMaterialProgress > initialMaterialProgress + 1e-12
      || candidate.expectedEmpty > Number(state.board.empty || 0)
      || ["retrieve-from-warehouse", "store-to-warehouse", "switch-production-mode"].includes(candidate.node.firstAction?.type));
    rollingCandidates.sort((left, right) => right.expectedMaterialProgress - left.expectedMaterialProgress
      || right.expectedEmpty - left.expectedEmpty || left.expectedEnergy - right.expectedEnergy
      || JSON.stringify(left.node.firstAction).localeCompare(JSON.stringify(right.node.firstAction)));
    const rolling = rollingCandidates[0];
    if (rolling) {
      const preflightRequired = rolling.node.firstAction.type === "store-to-warehouse" && rolling.node.firstAction.storeAvailability?.status !== "available";
      const nextAction = preflightRequired ? { ...rolling.node.firstAction, preflightRequired: true } : rolling.node.firstAction;
      result = {
        status: "planned", nextAction,
        boardSpaceFeasibility: { feasible: rolling.minimumEmpty >= 0, peakOccupied: rolling.peakOccupied, capacity: state.board.capacity, minimumEmpty: rolling.minimumEmpty },
        energyRequired: rolling.expectedEnergy,
        score: { ...nodeScore(rolling.node, orderSlot), orderProgress: rolling.expectedMaterialProgress },
        explanation: {
          selected: `${nextAction.type} is the first safe rolling action beyond the bounded stochastic horizon`,
          selectedReason: "bounded-rolling-progress",
          expectedEnergy: rolling.expectedEnergy,
          expectedEnergyBasis: "safe immediate representative branches",
          representativeCoverage: rolling.siblings.length,
          requiresNativePreflight: preflightRequired,
          riskBranches: nextAction.predictedBranches || [],
          selectedRiskBranches: nextAction.predictedBranches || [],
          pruned, consideredStates, goalDepth: null, searchBudget: budget, cache: { hit: false, key },
        },
      };
    } else {
      const reason = pruned["stochastic-space-risk"] ? "stochastic-space-risk" : pruned["insufficient-energy"] ? "insufficient-energy" : "stochastic-path-not-found";
      result = { status: "blocked", reason, nextAction: null, boardSpaceFeasibility: { feasible: false, peakOccupied: state.board.occupied, capacity: state.board.capacity, minimumEmpty: state.board.empty }, explanation: { selected: null, selectedReason: null, riskBranches, pruned, consideredStates, searchBudget: budget, cache: { hit: false, key } } };
    }
  } else {
    const groupedGoals = new Map();
    for (const goal of goals) {
      const actionKey = JSON.stringify(goal.firstAction);
      if (!groupedGoals.has(actionKey)) groupedGoals.set(actionKey, []);
      groupedGoals.get(actionKey).push(goal);
    }
    const actionCandidates = [...groupedGoals.values()].map((siblings) => {
      siblings.sort((left, right) => comparePathScores(nodeScore(left, orderSlot), nodeScore(right, orderSlot)) || right.probability - left.probability || left.energyUsed - right.energyUsed);
      const node = siblings[0];
      const predicted = node.firstAction.predictedBranches || [];
      const robustScore = { ...nodeScore(node, orderSlot), peakOccupied: Math.max(node.peakOccupied, ...predicted.map((branch) => Number(branch.peakOccupied || 0))), boardSpaceFeasible: predicted.every((branch) => branch.safe !== false) };
      return { node, siblings, robustScore };
    });
    actionCandidates.sort((left, right) => comparePathScores(left.robustScore, right.robustScore) || right.node.probability - left.node.probability || left.node.energyUsed - right.node.energyUsed);
    const selectedCandidate = actionCandidates[0];
    const selected = selectedCandidate.node;
    const uniqueSiblingGoals = [...new Map(selectedCandidate.siblings.map((goal) => [JSON.stringify(goal.riskBranches[0]?.outcomeItemIds || []), goal])).values()];
    const probabilityMass = uniqueSiblingGoals.reduce((sum, goal) => sum + Number(goal.probability || 0), 0);
    const expectedEnergy = probabilityMass > 0 ? uniqueSiblingGoals.reduce((sum, goal) => sum + goal.energyUsed * Number(goal.probability || 0), 0) / probabilityMass : selected.energyUsed;
    const preflightRequired = selected.firstAction.type === "store-to-warehouse" && selected.firstAction.storeAvailability?.status !== "available";
    const nextAction = preflightRequired ? { ...selected.firstAction, preflightRequired: true } : selected.firstAction;
    const selectedReason = nextAction.type === "retrieve-from-warehouse" ? "trusted-warehouse-buffer" : nextAction.type === "store-to-warehouse" ? "warehouse-space-buffer" : "lexicographic-safe-path";
    result = {
      status: "planned", nextAction,
      boardSpaceFeasibility: { feasible: selectedCandidate.robustScore.boardSpaceFeasible, peakOccupied: selectedCandidate.robustScore.peakOccupied, capacity: state.board.capacity, minimumEmpty: Math.min(selected.minimumEmpty, ...(selected.firstAction.predictedBranches || []).map((branch) => Number(branch.minimumEmpty))) },
      energyRequired: expectedEnergy,
      score: nodeScore(selected, orderSlot),
      explanation: { selected: `${nextAction.type} is the first safe action from the bounded stochastic beam`, selectedReason, expectedEnergy, expectedEnergyBasis: "normalized unique goal-reaching representative branches", representativeCoverage: uniqueSiblingGoals.length, requiresNativePreflight: preflightRequired, riskBranches, selectedRiskBranches: selected.riskBranches, pruned, consideredStates, goalDepth: selected.depth, searchBudget: budget, cache: { hit: false, key } },
    };
  }
  cache.set(key, result);
  return result;
}

module.exports = { adaptiveSearchBudget, representativeProductionBranches, planStochasticOrder, StochasticPlanCache };
