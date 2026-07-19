"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OPEN_WAREHOUSE_EXPRESSION, buildWarehouseStorePreflightExpression, buildMoveToWarehouseExpression, WarehouseActionExecutor } = require("../src/warehouse-actions");

test("warehouse open, preflight, and store expressions keep native actions atomic", () => {
  assert.equal((OPEN_WAREHOUSE_EXPRESSION.match(/bottom\.onWarehouseButtonHandle\(\)/g) || []).length, 1);
  const preflight = buildWarehouseStorePreflightExpression(12);
  const store = buildMoveToWarehouseExpression(12, "w3");
  assert.equal((preflight.match(/verifySaveItemToWarehouse/g) || []).length, 1);
  assert.doesNotMatch(preflight, /tryAddItemToWarehouse|onWarehouseButtonHandle/);
  assert.equal((store.match(/gameBoardView\.tryAddItemToWarehouse\(grid,entrance\.center\)/g) || []).length, 1);
  assert.match(store, /taskNeed/);
  assert.match(store, /produceCount/);
  assert.match(store, /verifySaveItemToWarehouse/);
  assert.match(store, /warehouse-preflight-changed/);
  const boundStore = buildMoveToWarehouseExpression(12, "w3", "safe", "safe||");
  assert.match(boundStore, /warehouse-preflight-source-changed/);
  assert.match(boundStore, /expectedItem="safe"/);
  assert.match(boundStore, /expectedSignature="safe\|\|"/);
});

test("warehouse native preflight obtains a concrete target slot without executing a game action", async () => {
  const expression = buildWarehouseStorePreflightExpression(4);
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (value) => {
      assert.equal(value, expression);
      return { ok: true, itemId: "safe", index: 4, warehouseGridId: "w3" };
    } },
    contextId: 7,
    collectState: async () => ({ scene: "board", board: { visible: true, signature: "safe|", grids: [{ index: 4, itemId: "safe", empty: false, normal: true, moveable: true }] } }),
  });
  const result = await executor.preflight(4);
  assert.equal(result.ok, true);
  assert.deepEqual(result.storeAvailability, { status: "available", sourceIndex: 4, itemId: "safe", targetSlotId: "w3", boardSignature: "safe|" });
});

test("store verifies source clearing, signature, resources, orders, and invalidates inventory knowledge", async () => {
  let reads = 0;
  const invalidations = [];
  const states = [
    { scene: "board", resources: { coins: 1, energy: 2 }, orders: [], board: { visible: true, occupied: 1, empty: 1, signature: "x|", grids: [{ index: 0, itemId: "x", empty: false, normal: true, moveable: true, taskNeed: false }] } },
    { scene: "board", resources: { coins: 1, energy: 2 }, orders: [], board: { visible: true, occupied: 0, empty: 2, signature: "|", grids: [{ index: 0, itemId: "", empty: true }] } },
  ];
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (expression) => expression.includes("tryAddItemToWarehouse")
      ? ({ ok: true, type: "move-to-warehouse", index: 0, itemId: "x", warehouseGridId: "1" })
      : ({ ok: true, index: 0, itemId: "x", warehouseGridId: "1" }) },
    contextId: 7, collectState: async () => states[Math.min(reads++, states.length - 1)], settleMs: 1,
    onInventoryKnowledgeInvalidated: (reason) => invalidations.push(reason),
  });
  const result = await executor.move(0, { execute: true });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "item-moved-to-warehouse");
  assert.deepEqual(result.sideEffects, []);
  assert.equal(result.warehouseInventoryKnowledge.status, "unknown");
  assert.deepEqual(invalidations, ["warehouse-store-succeeded"]);
});

test("failed store verification invalidates stale knowledge and reports unexpected side effects", async () => {
  let reads = 0;
  const invalidations = [];
  const states = [
    { scene: "board", resources: { coins: 1, energy: 2 }, orders: [], board: { visible: true, occupied: 1, empty: 1, signature: "x|", grids: [{ index: 0, itemId: "x", empty: false, normal: true, moveable: true }] } },
    { scene: "board", resources: { coins: 2, energy: 2 }, orders: [], board: { visible: true, occupied: 0, empty: 2, signature: "|", grids: [{ index: 0, itemId: "", empty: true }] } },
  ];
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (expression) => expression.includes("tryAddItemToWarehouse") ? { ok: true, warehouseGridId: "w1" } : { ok: true, itemId: "x", index: 0, warehouseGridId: "w1" } },
    contextId: 7, collectState: async () => states[Math.min(reads++, 1)], settleMs: 1,
    onInventoryKnowledgeInvalidated: (reason) => invalidations.push(reason),
  });
  const result = await executor.move(0, { execute: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "warehouse-store-unexpected-side-effect");
  assert.deepEqual(result.sideEffects, [{ field: "resources.coins", before: 1, after: 2 }]);
  assert.deepEqual(invalidations, ["warehouse-store-failed"]);
});

test("store verification rejects mutation of every non-source grid", async () => {
  let reads = 0;
  const states = [
    { scene: "board", resources: { coins: 1, energy: 2 }, orders: [], board: { visible: true, occupied: 2, empty: 1, signature: "x|y|", grids: [{ index: 0, itemId: "x", empty: false, normal: true, moveable: true }, { index: 1, itemId: "y", empty: false }] } },
    { scene: "board", resources: { coins: 1, energy: 2 }, orders: [], board: { visible: true, occupied: 1, empty: 2, signature: "||z", grids: [{ index: 0, itemId: "", empty: true }, { index: 1, itemId: "z", empty: false }] } },
  ];
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (expression) => expression.includes("tryAddItemToWarehouse") ? { ok: true, warehouseGridId: "w1" } : { ok: true, itemId: "x", index: 0, warehouseGridId: "w1" } },
    contextId: 7, collectState: async () => states[Math.min(reads++, 1)], settleMs: 1,
  });
  const result = await executor.move(0, { execute: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "warehouse-store-unexpected-side-effect");
  assert.deepEqual(result.sideEffects, [{ field: "board.grid[1]", before: { itemId: "y", empty: false }, after: { itemId: "z", empty: false } }]);
});

test("store verification rejects action-relevant changes on an otherwise identical non-source grid", async () => {
  let reads = 0;
  const stable = { index: 1, itemId: "producer", empty: false, normal: true, moveable: true, frozen: false, locking: false, taskNeed: false, protected: false, produceCount: 2, level: 1, mergeTarget: null };
  const states = [
    { scene: "board", resources: { coins: 1, energy: 2 }, orders: [], board: { visible: true, occupied: 2, empty: 1, signature: "x|producer", grids: [{ index: 0, itemId: "x", empty: false, normal: true, moveable: true }, stable] } },
    { scene: "board", resources: { coins: 1, energy: 2 }, orders: [], board: { visible: true, occupied: 1, empty: 2, signature: "|producer", grids: [{ index: 0, itemId: "", empty: true }, { ...stable, produceCount: 1, frozen: true }] } },
  ];
  const executor = new WarehouseActionExecutor({
    client: { evaluate: async (expression) => expression.includes("tryAddItemToWarehouse") ? { ok: true, warehouseGridId: "w1" } : { ok: true, itemId: "x", index: 0, warehouseGridId: "w1" } },
    contextId: 7, collectState: async () => states[Math.min(reads++, 1)], settleMs: 1,
  });
  const result = await executor.move(0, { execute: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "warehouse-store-unexpected-side-effect");
  assert.equal(result.sideEffects[0].field, "board.grid[1]");
  assert.equal(result.sideEffects[0].before.produceCount, 2);
  assert.equal(result.sideEffects[0].after.produceCount, 1);
  assert.equal(result.sideEffects[0].after.frozen, true);
});

test("order-reserved items and producers are rejected before native preflight", async () => {
  const make = (grid) => new WarehouseActionExecutor({ client: { evaluate: async () => { throw new Error("should not execute"); } }, contextId: 7, collectState: async () => ({ scene: "board", board: { visible: true, grids: [grid] } }) });
  assert.equal((await make({ index: 1, itemId: "a", empty: false, taskNeed: true }).preflight(1)).reason, "warehouse-source-reserved-for-order");
  assert.equal((await make({ index: 1, itemId: "p", empty: false, taskNeed: false, produceCount: 3, energyCost: 1 }).preflight(1)).reason, "warehouse-source-is-producer");
});
