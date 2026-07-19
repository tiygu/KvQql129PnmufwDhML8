"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePlannerState, buildWarehouseRetrieveCandidates } = require("../src/space-planner");
const { buildOptimizationPlan } = require("../src/order-optimizer");
const { WAREHOUSE_INVENTORY_EXPRESSION, buildWarehouseRetrieveExpression, WarehouseActionExecutor } = require("../src/warehouse-actions");

const catalog = {
  items: [
    { id: "a1", chainId: "a", level: 1, baseUnits: 1, mergeTarget: "a2" },
    { id: "a2", chainId: "a", level: 2, baseUnits: 2 },
    { id: "p", chainId: "p", level: 1, baseUnits: 1 },
  ],
  producers: [], evidence: { objects: [] },
};

function state({ empty = 2, warehouse } = {}) {
  return {
    schemaVersion: 1, scene: "board", resources: { coins: 1, diamonds: 0, energy: 5 },
    board: { width: 3, height: 1, occupied: 3 - empty, empty, signature: empty === 1 ? "a1|p|" : "p||", requiredItemCounts: { a2: 1 }, mergeCandidates: [], grids: [
      ...(empty === 1 ? [{ index: 0, itemId: "a1", normal: true, moveable: true }] : []),
      { index: 1, itemId: "p", normal: true, moveable: true },
    ] },
    orders: [{ slot: "o", rewardCoins: 5, ready: false, items: [{ itemId: "a2", complete: false }] }],
    warehouse: warehouse || { inventoryKnowledge: { status: "unknown" }, storeAvailability: { status: "unknown" } },
  };
}

function loadedWarehouse(pathStatus = "trusted") {
  return { inventoryKnowledge: {
    status: "loaded", totalSlots: 3, unlockedSlots: 3, occupiedSlots: 2, exchangeCapacity: 1,
    revision: "rev-1", slots: [{ slotId: "w1", itemId: "a1", occupied: true }, { slotId: "w2", itemId: "a1", occupied: true }], items: [{ itemId: "a1", count: 2 }],
    retrievalPath: { status: pathStatus, type: "native-click" },
  }, storeAvailability: { status: "unknown" } };
}

test("warehouse inventory carries concrete slots, item counts, revision, and trusted retrieval path", () => {
  const normalized = normalizePlannerState({ state: state({ warehouse: loadedWarehouse() }), catalog });
  assert.equal(normalized.warehouse.inventoryKnowledge.revision, "rev-1");
  assert.deepEqual(normalized.warehouse.inventoryKnowledge.items, [{ itemId: "a1", count: 2 }]);
  assert.equal(normalized.warehouse.inventoryKnowledge.slots[0].slotId, "w1");
  assert.equal(normalized.warehouse.inventoryKnowledge.retrievalPath.status, "trusted");
});

test("planner separates board, trusted warehouse, and unavailable supply", () => {
  const current = state({ warehouse: loadedWarehouse() });
  current.board.grids.push({ index: 2, itemId: "a1", normal: true, moveable: false, frozen: true });
  const plan = buildOptimizationPlan({ catalog, state: current });
  const demand = plan.plans[0].demands[0];
  assert.equal(demand.boardSupplyUnits, 0);
  assert.equal(demand.warehouseSupplyUnits, 2);
  assert.equal(demand.unavailableSupplyUnits, 1);
  assert.equal(plan.plans[0].nextAction.type, "retrieve-from-warehouse");
  assert.equal(plan.plans[0].nextAction.warehouseSlotId, "w1");
  assert.equal(plan.inventory.warehouseSupply.counts.a1, 2);

  const untrusted = buildOptimizationPlan({ catalog, state: state({ warehouse: loadedWarehouse("unknown") }) });
  assert.equal(untrusted.inventory.warehouseSupply.total, 0);
  assert.equal(untrusted.inventory.unavailableSupply.counts.a1, 2);
  assert.equal(untrusted.plans[0].demands[0].unavailableSupplyUnits, 2);
  assert.equal(untrusted.warehouseRetrieveCandidates.length, 0);
});

test("retrieval candidates consume only a complete remaining deficit and never replace sufficient board supply", () => {
  const insufficient = loadedWarehouse();
  insufficient.inventoryKnowledge.occupiedSlots = 1;
  insufficient.inventoryKnowledge.slots = insufficient.inventoryKnowledge.slots.slice(0, 1);
  insufficient.inventoryKnowledge.items = [{ itemId: "a1", count: 1 }];
  const insufficientPlan = buildOptimizationPlan({ catalog, state: state({ warehouse: insufficient }) });
  assert.equal(insufficientPlan.warehouseRetrieveCandidates.length, 0);
  assert.equal(insufficientPlan.plans[0].feasible, false);

  const supplied = state({ empty: 1, warehouse: loadedWarehouse() });
  supplied.board.grids.push({ index: 2, itemId: "a1", normal: true, moveable: true });
  supplied.board.width = 4;
  supplied.board.occupied = 3;
  supplied.board.empty = 1;
  const suppliedPlan = buildOptimizationPlan({ catalog, state: supplied });
  assert.equal(suppliedPlan.warehouseRetrieveCandidates.length, 0);
  assert.notEqual(suppliedPlan.plans[0].nextAction?.type, "retrieve-from-warehouse");
});

test("unknown warehouse inventory is loaded only for a concrete blocked demand", () => {
  const blocked = buildOptimizationPlan({ catalog, state: state() });
  assert.equal(blocked.warehouseInventoryLoadRequired, true);
  assert.deepEqual(blocked.warehouseLoadRequest.itemIds, ["a2"]);

  const readyState = state();
  readyState.orders[0].items[0].complete = true;
  readyState.orders[0].ready = true;
  const ready = buildOptimizationPlan({ catalog, state: readyState });
  assert.equal(ready.warehouseInventoryLoadRequired, false);
});

test("retrieval preserves a buffer unless the last slot is immediately mergeable", () => {
  const twoEmpty = normalizePlannerState({ state: state({ empty: 2, warehouse: loadedWarehouse() }), catalog });
  assert.equal(buildWarehouseRetrieveCandidates(twoEmpty, "o")[0].bufferPolicy, "preserve-one-buffer");
  const verifiedCatalog = JSON.parse(JSON.stringify(catalog));
  verifiedCatalog.evidence.objects = [
    { objectType: "item-identity", objectId: "a1", status: "active", disposition: "enabled" },
    { objectType: "merge-relation", objectId: "a1", status: "active", disposition: "enabled" },
  ];
  const oneEmpty = normalizePlannerState({ state: state({ empty: 1, warehouse: loadedWarehouse() }), catalog: verifiedCatalog });
  assert.equal(buildWarehouseRetrieveCandidates(oneEmpty, "o")[0].bufferPolicy, "verified-immediate-merge");
  const unverified = normalizePlannerState({ state: state({ empty: 1, warehouse: loadedWarehouse() }), catalog });
  assert.deepEqual(buildWarehouseRetrieveCandidates(unverified, "o"), []);
  const notMergeableState = state({ empty: 1, warehouse: loadedWarehouse() });
  notMergeableState.board.grids[0].itemId = "a2";
  const notMergeable = normalizePlannerState({ state: notMergeableState, catalog: verifiedCatalog });
  assert.deepEqual(buildWarehouseRetrieveCandidates(notMergeable, "o"), []);
});

test("warehouse inventory and retrieval expressions use the visible native click path", () => {
  assert.match(WAREHOUSE_INVENTORY_EXPRESSION, /_gridTypeMap/);
  assert.match(WAREHOUSE_INVENTORY_EXPRESSION, /revision/);
  const expression = buildWarehouseRetrieveExpression("w1", "a1", "rev-1");
  assert.match(expression, /warehouse-revision-changed/);
  assert.match(expression, /warehouse-slot-item-changed/);
  assert.match(expression, /\.emit\("click"\)/);
  assert.doesNotMatch(expression, /tryAddItemToWarehouse/);
});

test("inventory loader opens the warehouse only after execution is requested and returns a revisioned planning state", async () => {
  const board = state();
  const visible = { ...board, scene: "warehouse", warehouse: { visible: true, inventoryKnowledge: { status: "unknown" } } };
  const evaluations = [];
  let reads = 0;
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (expression) => {
      evaluations.push(expression);
      if (expression === WAREHOUSE_INVENTORY_EXPRESSION) return { ok: true, totalSlots: 3, unlockedSlots: 2, occupiedSlots: 1, revision: "rev-1", slots: [{ slotId: "w1", itemId: "a1", occupied: true }] };
      return { ok: true, type: "open-warehouse" };
    } },
    contextId: 7, collectState: async () => reads++ < 3 ? board : visible, settleMs: 1,
  });
  const preview = await executor.loadInventory({ execute: false });
  assert.equal(preview.nextAction.type, "load-warehouse-inventory");
  assert.equal(evaluations.length, 0);
  const loaded = await executor.loadInventory({ execute: true });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.inventoryKnowledge.revision, "rev-1");
  assert.equal(loaded.state.board.signature, board.board.signature);
  assert.equal(evaluations.length, 2);
});

test("retrieval verifies actual landing and resynchronizes board and inventory", async () => {
  let reads = 1;
  const states = [
    state({ empty: 2, warehouse: loadedWarehouse() }),
    { ...state({ empty: 1, warehouse: loadedWarehouse() }), board: { ...state({ empty: 1 }).board, occupied: 2, empty: 1, signature: "p|a1|", grids: [{ index: 1, itemId: "p", produceCount: 0 }, { index: 2, itemId: "a1", empty: false }] } },
  ];
  const inventories = [
    { ok: true, totalSlots: 3, unlockedSlots: 3, occupiedSlots: 1, revision: "rev-1", slots: [{ slotId: "w1", itemId: "a1", occupied: true }] },
    { ok: true, totalSlots: 3, unlockedSlots: 3, occupiedSlots: 0, revision: "rev-2", slots: [{ slotId: "w1", itemId: "", occupied: false }] },
  ];
  let inventoryRead = 1;
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (expression) => expression.includes("native-warehouse-retrieve") ? { ok: true, slotId: "w1", itemId: "a1" } : inventories[Math.min(inventoryRead++, 1)] },
    contextId: 7, collectState: async () => states[Math.min(reads++, 1)], settleMs: 1,
  });
  const result = await executor.retrieve({ warehouseSlotId: "w1", itemId: "a1", inventoryRevision: "rev-1" }, { execute: true, inventory: inventories[0], before: states[0] });
  assert.equal(result.ok, true);
  assert.equal(result.actualBoardIndex, 2);
  assert.equal(result.after.board.empty, 1);
  assert.equal(result.inventoryKnowledge.revision, "rev-2");
  assert.equal(result.resynchronized.board.signature, "p|a1|");
});

test("failed retrieval verification stops with fresh board and warehouse snapshots", async () => {
  const before = state({ empty: 2, warehouse: loadedWarehouse() });
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (expression) => expression.includes("native-warehouse-retrieve")
      ? { ok: true, slotId: "w1", itemId: "a1" }
      : { ok: true, totalSlots: 3, unlockedSlots: 3, occupiedSlots: 1, revision: "rev-1", slots: [{ slotId: "w1", itemId: "a1", occupied: true }] } },
    contextId: 7, collectState: async () => before, settleMs: 1,
  });
  const result = await executor.retrieve({ warehouseSlotId: "w1", itemId: "a1", inventoryRevision: "rev-1" }, { execute: true, inventory: loadedWarehouse().inventoryKnowledge, before });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "warehouse-retrieval-not-observed");
  assert.equal(result.resynchronized.board.signature, before.board.signature);
  assert.equal(result.resynchronized.warehouse.revision, "rev-1");
});
