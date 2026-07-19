"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGameState } = require("../src/game-state");
const { normalizePlannerState, buildWarehouseStoreCandidates, simulateDeterministicTransition, planDeterministicOrder } = require("../src/space-planner");
const { buildOptimizationPlan } = require("../src/order-optimizer");

function catalog() {
  return {
    coverage: {},
    items: [
      { id: "safe", chainId: "s", level: 1, baseUnits: 1 },
      { id: "valuable", chainId: "v", level: 2, baseUnits: 2 },
      { id: "reserved", chainId: "r", level: 1, baseUnits: 1 },
      { id: "producer", chainId: "p", level: 1, baseUnits: 1 },
    ],
    producers: [{ itemId: "producer", energyCost: 1, drops: [{ itemId: "safe", probability: 1, baseUnits: 1 }] }],
    evidence: { objects: [] },
  };
}

function state(warehouse) {
  return {
    schemaVersion: 1, scene: "board", resources: { coins: 0, energy: 5 },
    board: {
      width: 6, height: 1, occupied: 5, empty: 1, requiredItemCounts: { reserved: 1 },
      grids: [
        { index: 0, itemId: "safe", normal: true, moveable: true },
        { index: 1, itemId: "valuable", normal: true, moveable: true },
        { index: 2, itemId: "reserved", normal: true, moveable: true, taskNeed: true },
        { index: 3, itemId: "producer", normal: true, moveable: true, produceCount: 3, energyCost: 1 },
        { index: 4, itemId: "unknown", normal: true, moveable: true },
      ], mergeCandidates: [],
    },
    orders: [{ slot: "o", rewardCoins: 5, ready: false, items: [{ itemId: "reserved", complete: true }] }],
    warehouse,
  };
}

test("warehouse normalization separates inventory knowledge from store availability and does not treat unloaded zeros as capacity", () => {
  const gameState = buildGameState({ state: { gameplay: { mode: "board", warehouse: { loaded: false, visible: false, totalSlots: 0, unlockedSlots: 0, occupiedSlots: 0 } } } });
  assert.equal(gameState.warehouse.inventoryKnowledge.status, "unknown");
  assert.equal(gameState.warehouse.inventoryKnowledge.totalSlots, null);
  assert.equal(gameState.warehouse.inventoryKnowledge.exchangeCapacity, null);
  assert.equal(gameState.warehouse.storeAvailability.status, "unknown");

  const loaded = buildGameState({ state: { gameplay: { mode: "warehouse", warehouse: { loaded: true, visible: true, totalSlots: 4, unlockedSlots: 3, occupiedSlots: 2 } } } });
  assert.equal(loaded.warehouse.inventoryKnowledge.status, "loaded");
  assert.equal(loaded.warehouse.inventoryKnowledge.exchangeCapacity, 1);
});

test("warehouse store candidates require safe Active catalog items and rank lower opportunity cost first", () => {
  const normalized = normalizePlannerState({ state: state({ inventoryKnowledge: { status: "unknown", exchangeCapacity: null }, storeAvailability: { status: "unknown" } }), catalog: catalog() });
  const candidates = buildWarehouseStoreCandidates(normalized);
  assert.deepEqual(candidates.map((candidate) => candidate.itemId), ["safe", "valuable"]);
  assert.ok(candidates[0].opportunityCost < candidates[1].opportunityCost);
  assert.equal(candidates[0].storeAvailability.status, "native-preflight-required");
  assert.equal(candidates[0].warehouseInventoryKnowledge.status, "unknown");
});

test("Provisional evidence and zero-cost producers never become store candidates", () => {
  const inputCatalog = catalog();
  inputCatalog.evidence.objects = [
    { objectType: "item-identity", objectId: "safe", status: "provisional", disposition: "enabled" },
    { objectType: "merge-relation", objectId: "safe", status: "active", disposition: "enabled" },
  ];
  const current = state({ inventoryKnowledge: { status: "unknown", exchangeCapacity: null }, storeAvailability: { status: "unknown" } });
  current.board.grids[3].energyCost = 0;
  const candidates = buildWarehouseStoreCandidates(normalizePlannerState({ state: current, catalog: inputCatalog }));
  assert.equal(candidates.some((candidate) => candidate.itemId === "safe"), false);
  assert.equal(candidates.some((candidate) => candidate.itemId === "producer"), false);
});

test("inferred observation projection items never become store candidates without evidence metadata", () => {
  const inputCatalog = catalog();
  inputCatalog.items.find((item) => item.id === "safe").inferred = true;
  delete inputCatalog.evidence;
  const current = state({ inventoryKnowledge: { status: "unknown", exchangeCapacity: null }, storeAvailability: { status: "unknown" } });
  const candidates = buildWarehouseStoreCandidates(normalizePlannerState({ state: current, catalog: inputCatalog }));
  assert.equal(candidates.some((candidate) => candidate.itemId === "safe"), false);
});

test("known full warehouse blocks exchange while unknown inventory still permits native preflight", () => {
  const unknown = normalizePlannerState({ state: state({ inventoryKnowledge: { status: "unknown", exchangeCapacity: null }, storeAvailability: { status: "unknown" } }), catalog: catalog() });
  assert.ok(buildWarehouseStoreCandidates(unknown).length > 0);
  const full = normalizePlannerState({ state: state({ inventoryKnowledge: { status: "loaded", totalSlots: 2, unlockedSlots: 2, occupiedSlots: 2, exchangeCapacity: 0 }, storeAvailability: { status: "unknown" } }), catalog: catalog() });
  assert.deepEqual(buildWarehouseStoreCandidates(full), []);
});

test("a verified store transition exchanges finite warehouse capacity for one board space", () => {
  const normalized = normalizePlannerState({ state: state({ inventoryKnowledge: { status: "loaded", totalSlots: 3, unlockedSlots: 2, occupiedSlots: 1, exchangeCapacity: 1 }, storeAvailability: { status: "unknown" } }), catalog: catalog() });
  const candidate = buildWarehouseStoreCandidates(normalized)[0];
  const stored = simulateDeterministicTransition(normalized, { ...candidate, storeAvailability: { status: "available", targetSlotId: "w2" } });
  assert.equal(stored.ok, true);
  assert.equal(stored.state.board.empty, 2);
  assert.equal(stored.state.board.occupied, 4);
  assert.equal(stored.state.warehouse.inventoryKnowledge.status, "unknown");
  assert.equal(stored.state.warehouse.inventoryKnowledge.exchangeCapacity, null);
  assert.deepEqual(stored.warehouseExchange, { beforeCapacity: 1, afterCapacity: 0, targetSlotId: "w2" });
  assert.equal(stored.opportunityCost, candidate.opportunityCost);
});

test("order optimization explains finite warehouse exchange candidates without claiming availability before preflight", () => {
  const plan = buildOptimizationPlan({ catalog: catalog(), state: state({ inventoryKnowledge: { status: "loaded", totalSlots: 3, unlockedSlots: 2, occupiedSlots: 1, exchangeCapacity: 1 }, storeAvailability: { status: "unknown" } }) });
  assert.equal(plan.warehouse.inventoryKnowledge.status, "loaded");
  assert.equal(plan.warehouse.exchangeCapacity, 1);
  assert.equal(plan.warehouseStoreCandidates[0].itemId, "safe");
  assert.equal(plan.warehouseStoreCandidates[0].storeAvailability.status, "native-preflight-required");
});

test("a preflighted warehouse exchange participates in deterministic path search and lexicographic ranking", () => {
  const inputCatalog = {
    items: [
      { id: "safe", chainId: "s", level: 1, baseUnits: 1 },
      { id: "a1", chainId: "a", level: 1, baseUnits: 1, mergeTarget: "a2" },
      { id: "a2", chainId: "a", level: 2, baseUnits: 2 },
      { id: "p", chainId: "p", level: 1, baseUnits: 1 },
    ],
    producers: [{ itemId: "p", energyCost: 1, drops: [{ itemId: "a1", probability: 1, baseUnits: 1 }] }], evidence: { objects: [] },
  };
  const current = {
    schemaVersion: 1, scene: "board", resources: { coins: 0, energy: 2 },
    board: { width: 3, height: 1, occupied: 3, empty: 0, requiredItemCounts: { a2: 1 }, grids: [
      { index: 0, itemId: "safe", normal: true, moveable: true },
      { index: 1, itemId: "p", normal: true, moveable: true, produceCount: 2, energyCost: 1 },
      { index: 2, itemId: "a1", normal: true, moveable: true },
    ] },
    orders: [{ slot: "o", rewardCoins: 5, ready: false, items: [{ itemId: "a2", complete: false }] }],
    warehouse: { inventoryKnowledge: { status: "unknown" }, storeAvailability: { status: "available", sourceIndex: 0, itemId: "safe", targetSlotId: "w1", boardSignature: "safe|p|a1" } },
  };
  const result = planDeterministicOrder(normalizePlannerState({ state: current, catalog: inputCatalog }), "o");
  assert.equal(result.status, "planned");
  assert.equal(result.nextAction.type, "store-to-warehouse");
  assert.equal(result.nextAction.storeAvailability.targetSlotId, "w1");
  assert.ok(result.score.opportunityLoss > 0);
});
