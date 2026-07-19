"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OrderCoinLoop } = require("../src/order-coin-loop");

test("订单金币循环在每个棋盘动作后重规划并在订单满足后提交", async () => {
  let reads = 0;
  let boardActions = 0;
  let submissions = 0;
  const loop = new OrderCoinLoop({
    collectState: async () => ({ resources: { coins: 10 }, board: { mergeCandidates: [] }, orders: [{ slot: "a", ready: reads++ >= 2 }] }),
    planOrders: async (state) => ({ plans: [{ slot: "a", ready: state.orders[0].ready, producerSteps: [{ gridIndex: 30 }] }], recommended: { slot: "a", ready: state.orders[0].ready, producerSteps: [{ gridIndex: 30 }] } }),
    runBoardAction: async () => { boardActions += 1; return { ok: true, actions: [{ type: "produce" }], stopReason: "max_actions_reached" }; },
    submitOrder: async () => { submissions += 1; return { ok: true, reason: "order-submitted-and-coins-received" }; },
  });
  const result = await loop.run({ execute: true, maxActions: 10 });
  assert.equal(result.ok, true);
  assert.equal(boardActions, 2);
  assert.equal(submissions, 1);
  assert.equal(result.actions.at(-1).type, "submit-order");
});

test("没有可先合成组合且体力到阈值时停在等待边界", async () => {
  let actions = 0;
  const loop = new OrderCoinLoop({
    minEnergy: 5,
    collectState: async () => ({ resources: { energy: 5 }, board: { empty: 10, mergeCandidates: [] }, orders: [{ slot: "a", ready: false }] }),
    planOrders: async () => ({ plans: [{ slot: "a", ready: false, producerSteps: [{ gridIndex: 1 }] }], recommended: { slot: "a", ready: false, producerSteps: [{ gridIndex: 1 }] } }),
    runBoardAction: async () => { actions += 1; return { ok: true, actions: [] }; },
    submitOrder: async () => ({ ok: true }),
  });
  const result = await loop.run({ execute: true });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "energy-depleted");
  assert.equal(actions, 0);
});

test("空位低于阈值时允许现有合成优先释放空间", async () => {
  let actions = 0;
  const loop = new OrderCoinLoop({
    minEmptySpaces: 3,
    collectState: async () => ({ resources: { energy: 10 }, board: { empty: 2, mergeCandidates: [{ from: 1, to: 2 }] }, orders: [{ slot: "a", ready: false }] }),
    planOrders: async () => ({ plans: [{ slot: "a", ready: false, producerSteps: [] }], recommended: { slot: "a", ready: false, producerSteps: [] } }),
    runBoardAction: async () => { actions += 1; return { ok: true, actions: [{ type: "merge" }], stopReason: "max_actions_reached" }; },
    submitOrder: async () => ({ ok: true }),
  });
  const result = await loop.run({ execute: true, maxActions: 1 });
  assert.equal(result.ok, true);
  assert.equal(actions, 1);
  assert.equal(result.actions[0].type, "merge");
});

test("体力归零后立即结束且不再合成或提交订单", async () => {
  let boardActions = 0, submissions = 0;
  const loop = new OrderCoinLoop({
    collectState: async () => ({ resources: { energy: 0 }, board: { empty: 2, mergeCandidates: [{ from: 1, to: 2 }] }, orders: [{ slot: "a", ready: true }] }),
    planOrders: async () => { throw new Error("体力归零后不应继续规划"); },
    runBoardAction: async () => { boardActions += 1; },
    submitOrder: async () => { submissions += 1; },
  });
  const result = await loop.run({ execute: true });
  assert.equal(result.reason, "energy-depleted");
  assert.equal(boardActions, 0);
  assert.equal(submissions, 0);
});

test("棋盘空间紧张且没有可合成项时将安全物品存入仓库", async () => {
  let storedIndex = null;
  const loop = new OrderCoinLoop({
    minEmptySpaces: 2,
    collectState: async () => ({
      resources: { energy: 10 }, warehouse: { unlockedSlots: 5, occupiedSlots: 1 },
      board: { empty: 2, mergeCandidates: [], requiredItemCounts: { need: 1 }, grids: [
        { index: 1, itemId: "need", empty: false, normal: true, moveable: true },
        { index: 2, itemId: "producer", empty: false, normal: true, moveable: true, produceCount: 5, energyCost: 1 },
        { index: 3, itemId: "safe", empty: false, normal: true, moveable: true },
      ] }, orders: [{ slot: "a", ready: false }],
    }),
    planOrders: async () => ({ plans: [{ slot: "a", ready: false, producerSteps: [{ gridIndex: 2 }] }], recommended: { slot: "a", ready: false, producerSteps: [{ gridIndex: 2 }] } }),
    runBoardAction: async () => ({ ok: true, actions: [] }), submitOrder: async () => ({ ok: true }),
    storeBoardItem: async (index) => { storedIndex = index; return { ok: true, reason: "item-moved-to-warehouse" }; },
  });
  const result = await loop.run({ execute: true, maxActions: 1 });
  assert.equal(storedIndex, 3);
  assert.equal(result.actions[0].type, "move-to-warehouse");
  assert.equal(result.actions[0].ok, true);
});

test("已锁定订单失去下一步动作时改选其他可执行订单", async () => {
  let planningRound = 0;
  const producers = [];
  const loop = new OrderCoinLoop({
    collectState: async () => ({
      resources: { energy: 10 },
      board: { empty: 10, mergeCandidates: [] },
      orders: [{ slot: "a", ready: false }, { slot: "b", ready: false }],
    }),
    planOrders: async () => {
      planningRound += 1;
      const a = planningRound === 1
        ? { slot: "a", feasible: true, producerSteps: [{ gridIndex: 1 }] }
        : { slot: "a", feasible: false, blockingReason: "inventory-unavailable", producerSteps: [] };
      const b = { slot: "b", feasible: true, producerSteps: [{ gridIndex: 2 }] };
      return { plans: [a, b], recommended: planningRound === 1 ? a : b };
    },
    runBoardAction: async ({ producer }) => {
      producers.push(producer);
      return { ok: true, actions: [{ type: "produce" }], stopReason: "max_actions_reached" };
    },
    submitOrder: async () => ({ ok: true }),
  });

  const result = await loop.run({ execute: true, maxActions: 2 });

  assert.equal(result.reason, "max-actions-reached");
  assert.deepEqual(producers, [1, 2]);
  assert.equal(result.targetSlot, "b");
});

test("a space-verified rolling plan may use the last buffer and executes only its first action", async () => {
  const calls = [];
  const target = {
    slot: "a", feasible: true, actionable: true, ready: false,
    nextAction: { type: "produce", producer: 7, outputItemId: "a1" },
    boardSpaceFeasibility: { feasible: true, peakOccupied: 9, capacity: 9, minimumEmpty: 0 },
    producerSteps: [{ gridIndex: 7 }],
  };
  const loop = new OrderCoinLoop({
    minEmptySpaces: 2,
    collectState: async () => ({ resources: { energy: 10 }, board: { empty: 1, mergeCandidates: [], grids: [] }, orders: [{ slot: "a", ready: false }] }),
    planOrders: async () => ({ plans: [target], recommended: target }),
    runBoardAction: async (request) => { calls.push(request); return { ok: true, actions: [{ type: "produce" }], stopReason: "max_actions_reached" }; },
    submitOrder: async () => ({ ok: true }),
  });
  const result = await loop.run({ execute: true, maxActions: 1 });
  assert.equal(result.reason, "max-actions-reached");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].producer, 7);
  assert.equal(calls[0].plannedAction.type, "produce");
});

test("warehouse store is proposed only after native preflight returns a concrete slot", async () => {
  const calls = [];
  const candidate = { type: "store-to-warehouse", sourceIndex: 3, itemId: "safe", opportunityCost: 4, storeAvailability: { status: "native-preflight-required" } };
  const loop = new OrderCoinLoop({
    minEmptySpaces: 2,
    collectState: async () => ({ resources: { energy: 10 }, warehouse: { inventoryKnowledge: { status: "unknown" } }, board: { empty: 1, mergeCandidates: [], grids: [{ index: 3, itemId: "safe", empty: false, normal: true, moveable: true }] }, orders: [{ slot: "a", ready: false }] }),
    planOrders: async (current) => {
      const target = { slot: "a", feasible: true, producerSteps: [{ gridIndex: 7 }], ...(current.warehouse?.storeAvailability?.status === "available" ? { nextAction: { ...candidate, storeAvailability: current.warehouse.storeAvailability } } : {}) };
      return { plans: [target], recommended: target, warehouseStoreCandidates: [candidate] };
    },
    preflightStore: async (index) => { calls.push(`preflight:${index}`); return { ok: true, storeAvailability: { status: "available", sourceIndex: index, itemId: "safe", targetSlotId: "w2" } }; },
    runBoardAction: async () => ({ ok: true, actions: [] }), submitOrder: async () => ({ ok: true }),
    storeBoardItem: async () => { throw new Error("preview must not execute"); },
  });
  const result = await loop.run({ execute: false, maxActions: 1 });
  assert.deepEqual(calls, ["preflight:3"]);
  assert.deepEqual(result.nextAction, { ...candidate, storeAvailability: { status: "available", sourceIndex: 3, itemId: "safe", targetSlotId: "w2" } });
});

test("warehouse store replans from the fresh state captured by native preflight", async () => {
  const candidate = { type: "store-to-warehouse", sourceIndex: 3, itemId: "safe", opportunityCost: 4, storeAvailability: { status: "native-preflight-required" } };
  const initialState = { revision: "initial", resources: { energy: 10 }, board: { empty: 0, mergeCandidates: [], grids: [] }, orders: [{ slot: "a", ready: false }] };
  const freshState = { revision: "preflight", resources: { energy: 9 }, board: { empty: 0, mergeCandidates: [], signature: "fresh", grids: [] }, orders: [{ slot: "a", ready: false }] };
  const seenRevisions = [];
  const loop = new OrderCoinLoop({
    collectState: async () => initialState,
    planOrders: async (current) => {
      seenRevisions.push(current.revision);
      const available = current.revision === "preflight" && current.warehouse?.storeAvailability?.status === "available";
      const target = { slot: "a", feasible: available, ...(available ? { nextAction: { ...candidate, storeAvailability: current.warehouse.storeAvailability } } : {}) };
      return { plans: [target], recommended: available ? target : null, boundaryReason: available ? null : "board-space-deadlock", warehouseStoreCandidates: [candidate] };
    },
    preflightStore: async () => ({ ok: true, before: freshState, storeAvailability: { status: "available", sourceIndex: 3, itemId: "safe", targetSlotId: "w2", boardSignature: "fresh" } }),
    storeBoardItem: async () => { throw new Error("preview must not execute"); }, runBoardAction: async () => ({}), submitOrder: async () => ({}),
  });
  const result = await loop.run({ execute: false, maxActions: 1 });
  assert.equal(result.reason, "planned");
  assert.deepEqual(seenRevisions, ["initial", "preflight"]);
});

test("warehouse exchange can recover an otherwise blocked Board Space Feasibility path", async () => {
  const candidate = { type: "store-to-warehouse", sourceIndex: 3, itemId: "safe", opportunityCost: 4, storeAvailability: { status: "native-preflight-required" } };
  const loop = new OrderCoinLoop({
    collectState: async () => ({ resources: { energy: 10 }, board: { empty: 0, mergeCandidates: [], grids: [] }, orders: [{ slot: "a", ready: false }] }),
    planOrders: async (current) => {
      const available = current.warehouse?.storeAvailability?.status === "available";
      const target = { slot: "a", feasible: available, blockingReason: available ? null : "board-space-deadlock", ...(available ? { nextAction: { ...candidate, storeAvailability: current.warehouse.storeAvailability } } : {}) };
      return { plans: [target], recommended: available ? target : null, boundaryReason: available ? null : "board-space-deadlock", warehouseStoreCandidates: [candidate] };
    },
    preflightStore: async () => ({ ok: true, storeAvailability: { status: "available", sourceIndex: 3, itemId: "safe", targetSlotId: "w2" } }),
    storeBoardItem: async () => { throw new Error("preview must not execute"); }, runBoardAction: async () => ({}), submitOrder: async () => ({}),
  });
  const result = await loop.run({ execute: false, maxActions: 1 });
  assert.equal(result.reason, "planned");
  assert.equal(result.nextAction.type, "store-to-warehouse");
  assert.equal(result.nextAction.storeAvailability.targetSlotId, "w2");
});

test("failed warehouse execution stops instead of relying on remaining stale predictions", async () => {
  const preflights = [], stores = [];
  const candidates = [3, 4].map((sourceIndex) => ({ type: "store-to-warehouse", sourceIndex, itemId: `safe-${sourceIndex}`, opportunityCost: sourceIndex, storeAvailability: { status: "native-preflight-required" } }));
  const loop = new OrderCoinLoop({
    collectState: async () => ({ resources: { energy: 10 }, board: { empty: 0, mergeCandidates: [], grids: [] }, orders: [{ slot: "a", ready: false }] }),
    planOrders: async (current) => {
      const available = current.warehouse?.storeAvailability?.status === "available";
      const selected = candidates.find((candidate) => candidate.sourceIndex === current.warehouse?.storeAvailability?.sourceIndex) || candidates[0];
      const target = { slot: "a", feasible: available, ...(available ? { nextAction: { ...selected, storeAvailability: current.warehouse.storeAvailability } } : {}) };
      return { plans: [target], recommended: available ? target : null, boundaryReason: available ? null : "board-space-deadlock", warehouseStoreCandidates: candidates };
    },
    preflightStore: async (index) => { preflights.push(index); return { ok: true, storeAvailability: { status: "available", sourceIndex: index, itemId: `safe-${index}`, targetSlotId: `w${index}` } }; },
    storeBoardItem: async (index) => { stores.push(index); return { ok: false, reason: "warehouse-store-not-observed" }; },
    runBoardAction: async () => ({}), submitOrder: async () => ({}),
  });
  const result = await loop.run({ execute: true, maxActions: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "warehouse-store-not-observed");
  assert.deepEqual(preflights, [3]);
  assert.deepEqual(stores, [3]);
});

test("an explicit empty evidence-gated candidate list never falls back to raw board items", async () => {
  let preflights = 0;
  const target = { slot: "a", feasible: true, producerSteps: [{ gridIndex: 7 }] };
  const loop = new OrderCoinLoop({
    minEmptySpaces: 2,
    collectState: async () => ({ resources: { energy: 10 }, board: { empty: 1, mergeCandidates: [], grids: [{ index: 3, itemId: "provisional", normal: true, moveable: true }] }, orders: [{ slot: "a", ready: false }] }),
    planOrders: async () => ({ plans: [target], recommended: target, warehouseStoreCandidates: [] }),
    preflightStore: async () => { preflights += 1; return { ok: true }; }, storeBoardItem: async () => ({ ok: true }),
    runBoardAction: async () => ({}), submitOrder: async () => ({}),
  });
  const result = await loop.run({ execute: false, maxActions: 1 });
  assert.equal(result.reason, "waiting-board-space");
  assert.equal(preflights, 0);
});
