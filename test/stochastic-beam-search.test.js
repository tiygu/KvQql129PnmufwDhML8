"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const {
  adaptiveSearchBudget,
  representativeProductionBranches,
  planStochasticOrder,
  StochasticPlanCache,
} = require("../src/stochastic-beam-search");
const { OrderCoinLoop } = require("../src/order-coin-loop");
const { buildOptimizationPlan } = require("../src/order-optimizer");

function fixture({ empty = 3, drops = [{ itemId: "a1", probability: 0.9, count: 1 }], orderItemId = "a1", warehouseSlots = [] } = {}) {
  const occupied = 1;
  const grids = [{ index: 0, itemId: "p", empty: false, executable: true, protected: false, produceCount: 20, currentProductionModeId: "single", availableProductionModes: [{ modeId: "single", unlocked: true }], productionModeSwitchEntry: { status: "available", method: "setMultipleMode" } }];
  for (let index = 0; index < empty; index += 1) grids.push({ index: index + 1, itemId: "", empty: true, executable: true, protected: false });
  return {
    schemaVersion: 1,
    board: { capacity: occupied + empty, occupied, empty, spaceKnown: true, grids },
    warehouse: {
      inventoryKnowledge: { status: "loaded", revision: "warehouse-r1", retrievalPath: { status: "trusted" }, exchangeCapacity: 4, unlockedSlots: 5, occupiedSlots: warehouseSlots.length, slots: warehouseSlots },
      storeAvailability: { status: "unknown" },
    },
    orders: [{ slot: "slot-1", rewardCoins: 20, ready: false, items: [{ itemId: orderItemId, complete: false }] }],
    energy: 20,
    coins: 0,
    mapCoinDeficit: 100,
    catalog: {
      items: [
        { id: "p", chainId: "producer", level: 1, baseUnits: 1, evidenceSufficient: true, mergeEvidenceActive: true, mergeTarget: null },
        { id: "a1", chainId: "a", level: 1, baseUnits: 1, evidenceSufficient: true, mergeEvidenceActive: true, mergeTarget: "a2" },
        { id: "a2", chainId: "a", level: 2, baseUnits: 2, evidenceSufficient: true, mergeEvidenceActive: true, mergeTarget: null },
        { id: "junk", chainId: "junk", level: 1, baseUnits: 1, evidenceSufficient: true, mergeEvidenceActive: true, mergeTarget: null },
      ],
      producers: [{ itemId: "p", energyCost: 1, drops, modes: [{ modeId: "single", energyCost: 1, unlocked: true, inferred: false, humanLocked: false, planningDistribution: { feasibilityOutcomesPerAction: Number(drops[0]?.count || 1) }, drops }] }],
      evidence: [],
    },
    protection: { itemIds: [], rules: {} },
  };
}

test("production expansion includes common, conservative, and worst-space branches", () => {
  const state = fixture({ drops: [{ itemId: "a1", probability: 0.99, count: 2 }, { itemId: "junk", probability: 0.01, count: 2 }] });
  const branches = representativeProductionBranches(state, { type: "produce", producer: 0, productionModeId: "single", drops: state.catalog.producers[0].modes[0].drops }, "slot-1");
  assert.deepEqual(branches.map((branch) => branch.kind), ["common", "conservative", "worst-space"]);
  assert.ok(branches.every((branch) => branch.outcomeItemIds.length === 2));
  assert.deepEqual(branches.at(-1).outcomeItemIds.sort(), ["a1", "junk"]);
});

test("low-probability board-space disaster prevents a high-probability production path", () => {
  const state = fixture({ empty: 2, orderItemId: "a2", drops: [{ itemId: "a1", probability: 0.99, count: 2 }, { itemId: "junk", probability: 0.01, count: 2 }] });
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-r1", stateRevision: "board-r1" });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.reason, "stochastic-space-risk");
  assert.ok(plan.explanation.riskBranches.some((branch) => branch.kind === "worst-space" && branch.safe === false), JSON.stringify(plan.explanation.riskBranches));
});

test("bounded beam search chooses a high-probability executable path and explains it", () => {
  const state = fixture({ empty: 3, drops: [{ itemId: "a1", probability: 0.9, count: 1 }, { itemId: "junk", probability: 0.1, count: 1 }] });
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-r1", stateRevision: "board-r1" });
  assert.equal(plan.status, "planned", JSON.stringify(plan));
  assert.equal(plan.nextAction.type, "produce");
  assert.ok(plan.nextAction.predictedBranches.length >= 2);
  assert.ok(plan.explanation.selected.includes("bounded stochastic beam"));
  assert.ok(plan.explanation.searchBudget.maxDepth <= 12);
  assert.ok(plan.explanation.searchBudget.maxWidth <= 64);
  assert.ok(plan.energyRequired >= 1);
  assert.equal(plan.energyRequired, plan.explanation.expectedEnergy);
});

test("spare board capacity keeps stochastic planning responsive on a populated board", () => {
  const state = fixture({ empty: 14, drops: [{ itemId: "a1", probability: 0.9, count: 1 }, { itemId: "junk", probability: 0.1, count: 1 }] });
  for (let index = 0; index < 48; index += 1) {
    const itemId = `board-${index}`;
    state.catalog.items.push({ id: itemId, chainId: itemId, level: 1, baseUnits: 1, evidenceSufficient: true, mergeEvidenceActive: true, mergeTarget: null });
    state.board.grids.push({ index: state.board.grids.length, itemId, empty: false, executable: true, protected: false });
  }
  while (state.catalog.items.length < 112) {
    const itemId = `catalog-${state.catalog.items.length}`;
    state.catalog.items.push({ id: itemId, chainId: itemId, level: 1, baseUnits: 1, evidenceSufficient: true, mergeEvidenceActive: true, mergeTarget: null });
  }
  state.board.occupied = 49;
  state.board.capacity = 63;

  const started = performance.now();
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-populated", stateRevision: "board-populated", cache: new StochasticPlanCache() });
  const elapsedMs = performance.now() - started;

  assert.equal(plan.status, "planned", JSON.stringify(plan));
  assert.equal(plan.nextAction.type, "produce");
  assert.equal(plan.explanation.selectedReason, "safe-immediate-production");
  assert.equal(plan.explanation.consideredStates, 1);
  assert.ok(elapsedMs < 1500, `stochastic planner blocked for ${elapsedMs.toFixed(1)}ms`);
});

test("specified strategy fully plans only the selected actionable order", () => {
  const normalized = fixture({
    empty: 7,
    orderItemId: "a2",
    drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, probability: 0.9, count: 1 }, { itemId: "junk", chainId: "junk", level: 1, baseUnits: 1, probability: 0.1, count: 1 }],
  });
  const catalog = { revision: "catalog-specified", coverage: {}, ...normalized.catalog, evidence: { objects: [] } };
  const state = {
    schemaVersion: 1,
    resources: { energy: normalized.energy },
    board: { ...normalized.board, signature: normalized.board.grids.map((grid) => grid.itemId).join("|") },
    warehouse: normalized.warehouse,
    orders: [
      { slot: "priority", rewardCoins: 20, ready: false, items: [{ itemId: "a2", complete: false }] },
      { slot: "other", rewardCoins: 10, ready: false, items: [{ itemId: "a1", complete: false }] },
    ],
  };

  const plan = buildOptimizationPlan({ catalog, state, strategy: "specified", prioritySlot: "priority", executionMode: "automatic" });

  assert.equal(plan.recommended.slot, "priority");
  assert.equal(plan.recommended.nextAction.type, "produce");
  assert.equal(plan.plans.find((item) => item.slot === "other").nextAction, undefined);
});

test("specified strategy resolves one fallback when the selected slot disappears", () => {
  const normalized = fixture({
    empty: 7,
    orderItemId: "a2",
    drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, probability: 0.9, count: 1 }, { itemId: "junk", chainId: "junk", level: 1, baseUnits: 1, probability: 0.1, count: 1 }],
  });
  const catalog = { revision: "catalog-specified-missing", coverage: {}, ...normalized.catalog, evidence: { objects: [] } };
  const state = {
    schemaVersion: 1,
    resources: { energy: normalized.energy },
    board: { ...normalized.board, signature: normalized.board.grids.map((grid) => grid.itemId).join("|") },
    warehouse: normalized.warehouse,
    orders: [
      { slot: "slower", rewardCoins: 20, ready: false, items: [{ itemId: "a2", complete: false }] },
      { slot: "fallback", rewardCoins: 10, ready: false, items: [{ itemId: "a1", complete: false }] },
    ],
  };

  const plan = buildOptimizationPlan({ catalog, state, strategy: "specified", prioritySlot: "gone", executionMode: "automatic" });

  assert.equal(plan.recommended.slot, "slower");
  assert.equal(plan.resolvedPrioritySlot, "slower");
  assert.equal(plan.recommended.nextAction.type, "produce");
  assert.equal(plan.plans.find((item) => item.slot === "fallback").nextAction, undefined);
});

test("specified strategy resolves one fallback when the selected order is not executable", () => {
  const normalized = fixture({
    empty: 7,
    orderItemId: "a1",
    drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, probability: 0.9, count: 1 }, { itemId: "junk", chainId: "junk", level: 1, baseUnits: 1, probability: 0.1, count: 1 }],
  });
  const catalog = { revision: "catalog-specified-blocked", coverage: {}, ...normalized.catalog, evidence: { objects: [] } };
  const state = {
    schemaVersion: 1,
    resources: { energy: normalized.energy },
    board: { ...normalized.board, signature: normalized.board.grids.map((grid) => grid.itemId).join("|") },
    warehouse: normalized.warehouse,
    orders: [
      { slot: "blocked", rewardCoins: 100, ready: false, items: [{ itemId: "unknown-item", complete: false }] },
      { slot: "fallback", rewardCoins: 10, ready: false, items: [{ itemId: "a1", complete: false }] },
    ],
  };

  const plan = buildOptimizationPlan({ catalog, state, strategy: "specified", prioritySlot: "blocked", executionMode: "automatic" });

  assert.equal(plan.recommended.slot, "fallback");
  assert.equal(plan.resolvedPrioritySlot, "fallback");
  assert.equal(plan.plans.find((item) => item.slot === "blocked").nextAction, null);
  assert.equal(plan.recommended.nextAction.type, "produce");
});

test("orders beyond the search horizon still emit one safe rolling progress action", () => {
  const state = fixture({ empty: 14, orderItemId: "a8", drops: [{ itemId: "a1", probability: 0.9, count: 1 }, { itemId: "junk", probability: 0.1, count: 1 }] });
  for (let level = 3; level <= 8; level += 1) {
    state.catalog.items.push({ id: `a${level}`, chainId: "a", level, baseUnits: 2 ** (level - 1), evidenceSufficient: true, mergeEvidenceActive: true, mergeTarget: level < 8 ? `a${level + 1}` : null });
  }
  state.catalog.items.find((item) => item.id === "a2").mergeTarget = "a3";

  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-long-order", stateRevision: "board-long-order", cache: new StochasticPlanCache() });

  assert.equal(plan.status, "planned", JSON.stringify(plan));
  assert.equal(plan.nextAction.type, "produce");
  assert.equal(plan.explanation.selectedReason, "safe-immediate-production");
  assert.ok(plan.energyRequired > 0);
  assert.equal(plan.boardSpaceFeasibility.feasible, true);
});

test("contingent lookahead rejects a branch that is safe immediately but deadlocks one step later", () => {
  const state = fixture({ empty: 3, orderItemId: "a2", drops: [{ itemId: "a1", probability: 0.99, count: 2 }, { itemId: "junk", probability: 0.01, count: 2 }] });
  state.warehouse.inventoryKnowledge.exchangeCapacity = 0;
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-deferred", stateRevision: "board-deferred", cache: new StochasticPlanCache() });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.reason, "stochastic-space-risk");
  assert.ok(plan.explanation.riskBranches.some((branch) => branch.reason === "no-safe-contingent-continuation"));
});

test("adaptive limits deepen for tight space and shrink for simple states", () => {
  const simpleState = fixture({ empty: 5 });
  simpleState.orders[0].items.push({ itemId: "a2", complete: false });
  const simple = adaptiveSearchBudget(simpleState, "slot-1");
  const tight = adaptiveSearchBudget(fixture({ empty: 1 }), "slot-1");
  assert.ok(tight.maxDepth > simple.maxDepth);
  assert.ok(tight.maxWidth > simple.maxWidth);
  assert.ok(tight.maxDepth <= 12 && tight.maxWidth <= 64);
});

test("near-complete orders deepen the horizon instead of taking the simple-state shortcut", () => {
  const near = adaptiveSearchBudget(fixture({ empty: 5 }), "slot-1");
  assert.equal(near.reason, "near-order-completion");
  assert.ok(near.maxDepth <= 4);
  assert.ok(near.maxWidth <= 8);
});

test("normalized-state cache reuses exact revisions and invalidates state or evidence changes", () => {
  const state = fixture();
  const cache = new StochasticPlanCache();
  const first = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-r1", stateRevision: "board-r1", cache });
  const second = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-r1", stateRevision: "board-r1", cache });
  const catalogChanged = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-r2", stateRevision: "board-r1", cache });
  const stateChanged = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-r2", stateRevision: "board-r2", cache });
  assert.equal(first.explanation.cache.hit, false);
  assert.equal(second.explanation.cache.hit, true);
  assert.equal(catalogChanged.explanation.cache.hit, false);
  assert.equal(stateChanged.explanation.cache.hit, false);
});

test("a safe merge bypasses the expensive stochastic expansion before the first action", () => {
  const state = fixture({ empty: 4, orderItemId: "a2" });
  state.board.grids.splice(1, 2,
    { index: 1, itemId: "a1", empty: false, executable: true, protected: false },
    { index: 2, itemId: "a1", empty: false, executable: true, protected: false },
  );
  state.board.occupied = 3;
  state.board.empty = 2;
  state.board.capacity = 5;

  const started = performance.now();
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-fast-merge", stateRevision: "board-fast-merge", cache: new StochasticPlanCache() });
  const elapsedMs = performance.now() - started;

  assert.equal(plan.status, "planned");
  assert.equal(plan.nextAction.type, "merge");
  assert.equal(plan.explanation.selectedReason, "safe-space-release");
  assert.equal(plan.explanation.consideredStates, 1);
  assert.ok(elapsedMs < 250, `safe merge planning took ${elapsedMs.toFixed(1)}ms`);
});

test("cache diagnostics expose a bounded digest instead of the complete planner state", () => {
  const state = fixture({ empty: 8 });
  for (let index = 0; index < 80; index += 1) {
    const itemId = `cache-item-${index}`;
    state.catalog.items.push({ id: itemId, chainId: itemId, level: 1, baseUnits: 1, mergeTarget: null });
  }
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-cache-digest", stateRevision: "board-cache-digest", cache: new StochasticPlanCache() });
  assert.match(plan.explanation.cache.key, /^stochastic-plan:[a-f0-9]{64}$/);
  assert.ok(plan.explanation.cache.key.length < 100);
});

test("beam search can select a trusted warehouse slot before production", () => {
  const state = fixture({ empty: 2, drops: [], warehouseSlots: [{ slotId: "w-2", occupied: true, itemId: "a1" }] });
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-r1", stateRevision: "board-r1" });
  assert.equal(plan.status, "planned");
  assert.equal(plan.nextAction.type, "retrieve-from-warehouse");
  assert.equal(plan.nextAction.warehouseSlotId, "w-2");
  assert.equal(plan.explanation.selectedReason, "trusted-warehouse-buffer");
});

test("beam search emits the submission action for a ready order", () => {
  const state = fixture();
  state.orders[0].ready = true;
  state.orders[0].items[0].complete = true;
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-ready", stateRevision: "board-ready", cache: new StochasticPlanCache() });
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.nextAction, { type: "submit-order", slot: "slot-1" });
  assert.equal(plan.explanation.selectedReason, "order-ready");
});

test("beam search proposes native preflight before storing a low-value item for buffer space", () => {
  const state = fixture({ empty: 1, drops: [{ itemId: "a1", probability: 1, count: 1 }] });
  Object.assign(state.board.grids[1], { itemId: "junk", empty: false, executable: true, protected: false });
  Object.assign(state.board, { occupied: 2, empty: 0 });
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-store", stateRevision: "board-store", cache: new StochasticPlanCache() });
  assert.equal(plan.status, "planned");
  assert.equal(plan.nextAction.type, "store-to-warehouse");
  assert.equal(plan.nextAction.sourceIndex, 1);
  assert.equal(plan.nextAction.preflightRequired, true);
  assert.equal(plan.explanation.selectedReason, "warehouse-space-buffer");
  assert.equal(plan.explanation.requiresNativePreflight, true);
});

test("beam search selects a better Production Mode before producing", () => {
  const state = fixture({ empty: 3, drops: [{ itemId: "junk", probability: 1, count: 1 }] });
  const producer = state.catalog.producers[0];
  producer.modes = [
    { modeId: "single", energyCost: 1, unlocked: true, inferred: false, humanLocked: false, drops: [{ itemId: "junk", probability: 1, count: 1 }] },
    { modeId: "double", energyCost: 1, unlocked: true, inferred: false, humanLocked: false, drops: [{ itemId: "a1", probability: 1, count: 1 }] },
  ];
  state.board.grids[0].availableProductionModes.push({ modeId: "double", unlocked: true });
  const plan = planStochasticOrder(state, "slot-1", { catalogRevision: "catalog-mode", stateRevision: "board-mode", cache: new StochasticPlanCache() });
  assert.equal(plan.status, "planned");
  assert.equal(plan.nextAction.type, "switch-production-mode");
  assert.equal(plan.nextAction.productionModeId, "double");
});

test("an actual production outcome outside every predicted branch triggers immediate replanning", async () => {
  let planCalls = 0;
  const state = { resources: { energy: 10 }, board: { empty: 3, mergeCandidates: [] }, orders: [{ slot: "slot-1", ready: false }] };
  const predicted = [{ kind: "common", outcomeItemIds: ["a1"] }, { kind: "conservative", outcomeItemIds: ["a2"] }];
  const loop = new OrderCoinLoop({
    collectState: async () => state,
    planOrders: async () => {
      planCalls += 1;
      if (planCalls > 1) return { plans: [], recommended: null, boundaryReason: "no-feasible-order", warehouseStoreCandidates: [] };
      const target = { slot: "slot-1", feasible: true, actionable: true, nextAction: { type: "produce", producer: 0, predictedBranches: predicted }, boardSpaceFeasibility: { feasible: true }, producerSteps: [{ gridIndex: 0 }] };
      return { plans: [target], recommended: target, warehouseStoreCandidates: [] };
    },
    runBoardAction: async () => ({ ok: true, stopReason: "max_actions_reached", actions: [{ type: "produce", verified: true, actualOutputItemIds: ["unexpected"] }] }),
    submitOrder: async () => ({ ok: true }),
  });
  const result = await loop.run({ execute: true, maxActions: 2 });
  assert.equal(planCalls, 2);
  assert.equal(result.actions[0].predictionDiverged, true);
  assert.equal(result.actions[0].replanReason, "actual-production-outside-predicted-branches");
});

test("a beam-selected warehouse store is preflighted and dispatched by the runtime loop", async () => {
  let stored = false;
  const state = { resources: { energy: 10 }, board: { empty: 0, mergeCandidates: [], grids: [{ index: 4, itemId: "junk" }] }, orders: [{ slot: "slot-1", ready: false }], warehouse: {} };
  const storeAction = { type: "store-to-warehouse", sourceIndex: 4, itemId: "junk", storeAvailability: { status: "native-preflight-required" } };
  const activePlan = () => {
    const target = { slot: "slot-1", feasible: true, actionable: true, nextAction: storeAction, boardSpaceFeasibility: { feasible: true } };
    return { plans: [target], recommended: target, warehouseStoreCandidates: [storeAction] };
  };
  const loop = new OrderCoinLoop({
    collectState: async () => state,
    planOrders: async () => stored ? { plans: [], recommended: null, boundaryReason: "no-feasible-order", warehouseStoreCandidates: [] } : activePlan(),
    runBoardAction: async () => { throw new Error("store must not be dispatched as a board action"); },
    submitOrder: async () => ({ ok: true }),
    preflightStore: async () => ({ ok: true, before: state, storeAvailability: { status: "available", sourceIndex: 4, itemId: "junk", targetSlotId: "w-4" } }),
    storeBoardItem: async () => { stored = true; return { ok: true, before: state, after: { ...state, board: { ...state.board, empty: 1 } } }; },
  });
  const result = await loop.run({ execute: true, maxActions: 2 });
  assert.equal(stored, true);
  assert.equal(result.actions[0].type, "move-to-warehouse");
  assert.equal(result.actions[0].targetSlotId, "w-4");
});

test("a beam-selected warehouse retrieval is dispatched before board actions", async () => {
  let retrieved = false;
  const state = { resources: { energy: 10 }, board: { empty: 2, mergeCandidates: [] }, orders: [{ slot: "slot-1", ready: false }], warehouse: { inventoryKnowledge: { status: "loaded" } } };
  const retrieveAction = { type: "retrieve-from-warehouse", warehouseSlotId: "w-2", itemId: "a1", inventoryRevision: "wr-1" };
  const target = { slot: "slot-1", feasible: true, actionable: true, nextAction: retrieveAction, boardSpaceFeasibility: { feasible: true } };
  const loop = new OrderCoinLoop({
    collectState: async () => state,
    planOrders: async () => retrieved ? { plans: [], recommended: null, boundaryReason: "no-feasible-order", warehouseStoreCandidates: [] } : { plans: [target], recommended: target, warehouseStoreCandidates: [] },
    runBoardAction: async () => { throw new Error("retrieval must not be dispatched as a board action"); },
    submitOrder: async () => ({ ok: true }),
    retrieveWarehouseItem: async () => { retrieved = true; return { ok: true, actualBoardIndex: 3, before: state, after: state }; },
  });
  const result = await loop.run({ execute: true, maxActions: 2 });
  assert.equal(retrieved, true);
  assert.equal(result.actions[0].type, "retrieve-from-warehouse");
  assert.equal(result.actions[0].warehouseSlotId, "w-2");
});

test("order optimization rejects a stochastic mode whose rare branch deadlocks the board", () => {
  const drops = [
    { itemId: "a1", chainId: "a", level: 1, baseUnits: 1, probability: 0.99, count: 2 },
    { itemId: "junk", chainId: "junk", level: 1, baseUnits: 1, probability: 0.01, count: 2 },
  ];
  const normalized = fixture({ empty: 2, orderItemId: "a2", drops });
  const catalog = { revision: "catalog-r1", coverage: {}, items: normalized.catalog.items, producers: normalized.catalog.producers, evidence: { objects: [] }, chains: [] };
  const state = {
    schemaVersion: 1, scene: "board", resources: { energy: 20, coins: 0 }, mapMission: { requirements: [] },
    board: { ...normalized.board, signature: "board-r1", requiredItemCounts: { a2: 1 }, mergeCandidates: [] },
    warehouse: normalized.warehouse,
    orders: normalized.orders,
  };
  const plan = buildOptimizationPlan({ catalog, state });
  assert.equal(plan.recommended, null);
  assert.equal(plan.plans[0].blockingReason, "stochastic-space-risk");
  assert.ok(plan.plans[0].explanation.riskBranches.some((branch) => branch.safe === false));
});
