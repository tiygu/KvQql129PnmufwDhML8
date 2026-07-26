"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOptimizationPlan } = require("../src/order-optimizer");

test("梯度规划把合成等级换算为基础单位并扣除棋盘库存", () => {
  const catalog = {
    coverage: {},
    items: [
      { id: "a1", chainId: "a", level: 1, baseUnits: 1 },
      { id: "a2", chainId: "a", level: 2, baseUnits: 2 },
      { id: "a3", chainId: "a", level: 3, baseUnits: 4 },
      { id: "p", chainId: "p", level: 1, baseUnits: 1 },
    ],
    producers: [{ itemId: "p", level: 1, energyCost: 1, drops: [{ itemId: "a1", chainId: "a", level: 1, baseUnits: 1, probability: 1 }] }],
  };
  const state = {
    resources: [{ type: 3, amount: 10 }], energy: [{ amount: 10 }],
    tasks: [{ slot: "order", taskId: "1", awardValue: 30, items: [{ itemId: "a3", complete: false }], rewards: [{ type: 1, count: 30 }] }],
  };
  const boardScan = { grids: [{ index: 1, itemId: "p" }, { index: 2, itemId: "a1" }] };
  const result = buildOptimizationPlan({ catalog, state, boardScan });
  assert.equal(result.recommended.estimatedEnergy, 3);
  assert.equal(result.recommended.producerSteps[0].clicks, 3);
  assert.equal(result.recommended.efficiency, 10);
});

test("体力不足时标记当前不可一次完成但仍可滚动推进", () => {
  const catalog = {
    coverage: {},
    items: [{ id: "a1", chainId: "a", level: 1, baseUnits: 1 }, { id: "a3", chainId: "a", level: 3, baseUnits: 4 }, { id: "p", chainId: "p", level: 1, baseUnits: 1 }],
    producers: [{ itemId: "p", energyCost: 1, drops: [{ itemId: "a1", chainId: "a", baseUnits: 1, probability: 1 }] }],
  };
  const state = { schemaVersion: 1, resources: { energy: 2 }, board: { grids: [{ index: 1, itemId: "p" }] }, orders: [{ slot: "o", rewardCoins: 20, items: [{ itemId: "a3", complete: false }] }] };
  const result = buildOptimizationPlan({ catalog, state });
  assert.equal(result.plans[0].feasible, true);
  assert.equal(result.plans[0].affordable, false);
  assert.equal(result.recommended.slot, "o");
});

test("库存基础单位已足够时优先只合成就能完成的订单", () => {
  const catalog = { coverage: {}, items: [{ id: "a1", chainId: "a", level: 1, baseUnits: 1 }, { id: "a2", chainId: "a", level: 2, baseUnits: 2 }], producers: [] };
  const state = {
    schemaVersion: 1, resources: { energy: 10 },
    board: { grids: [{ index: 1, itemId: "a1" }, { index: 2, itemId: "a1" }] },
    orders: [{ slot: "merge", rewardCoins: 5, items: [{ itemId: "a2", complete: false }] }],
  };
  const result = buildOptimizationPlan({ catalog, state });
  assert.equal(result.recommended.slot, "merge");
  assert.equal(result.recommended.mergeOnly, true);
  assert.equal(result.recommended.estimatedEnergy, 0);
});

test("规划策略支持最低体力、最高效率和手动指定订单", () => {
  const catalog = {
    coverage: {},
    items: [
      { id: "a1", chainId: "a", level: 1, baseUnits: 1 }, { id: "a2", chainId: "a", level: 2, baseUnits: 2 },
      { id: "b1", chainId: "b", level: 1, baseUnits: 1 }, { id: "b3", chainId: "b", level: 3, baseUnits: 4 },
      { id: "pa", chainId: "pa", level: 1, baseUnits: 1 }, { id: "pb", chainId: "pb", level: 1, baseUnits: 1 },
    ],
    producers: [
      { itemId: "pa", energyCost: 1, drops: [{ itemId: "a1", chainId: "a", baseUnits: 1, probability: 1 }] },
      { itemId: "pb", energyCost: 1, drops: [{ itemId: "b1", chainId: "b", baseUnits: 1, probability: 1 }] },
    ],
  };
  const state = {
    schemaVersion: 1, resources: { energy: 100 },
    board: { grids: [{ index: 1, itemId: "pa" }, { index: 2, itemId: "pb" }] },
    orders: [
      { slot: "cheap", rewardCoins: 10, items: [{ itemId: "a2", complete: false }] },
      { slot: "efficient", rewardCoins: 100, items: [{ itemId: "b3", complete: false }] },
    ],
  };
  assert.equal(buildOptimizationPlan({ catalog, state, strategy: "min-energy" }).recommended.slot, "cheap");
  assert.equal(buildOptimizationPlan({ catalog, state, strategy: "efficiency" }).recommended.slot, "efficient");
  const specifiedState = { ...state, board: { ...state.board, capacity: 10, occupied: 2, empty: 8 } };
  const specified = buildOptimizationPlan({ catalog, state: specifiedState, strategy: "specified", prioritySlot: "cheap" });
  assert.equal(specified.recommended.slot, "cheap");
  assert.equal(specified.prioritySlot, "cheap");
});

test("冻结物品只计入可观察库存并改选有下一步动作的订单", () => {
  const catalog = {
    coverage: {},
    items: [
      { id: "a1", chainId: "a", level: 1, baseUnits: 1 },
      { id: "a2", chainId: "a", level: 2, baseUnits: 2 },
      { id: "b1", chainId: "b", level: 1, baseUnits: 1 },
      { id: "pb", chainId: "producer-b", level: 1, baseUnits: 1 },
    ],
    producers: [{ itemId: "pb", energyCost: 1, drops: [{ itemId: "b1", chainId: "b", baseUnits: 1, probability: 1 }] }],
  };
  const state = {
    schemaVersion: 1,
    resources: { energy: 10 },
    board: { grids: [
      { index: 1, itemId: "a2", normal: true, moveable: true, frozen: true },
      { index: 2, itemId: "pb", normal: true, moveable: true },
    ], mergeCandidates: [] },
    orders: [
      { slot: "frozen", rewardCoins: 100, items: [{ itemId: "a2", complete: false }] },
      { slot: "executable", rewardCoins: 10, items: [{ itemId: "b1", complete: false }] },
    ],
  };

  const result = buildOptimizationPlan({ catalog, state });

  assert.equal(result.recommended.slot, "executable");
  assert.deepEqual(result.inventory.observable.counts, { a2: 1, pb: 1 });
  assert.deepEqual(result.inventory.executable.counts, { pb: 1 });
  assert.equal(result.inventory.unavailable.items[0].itemId, "a2");
  assert.deepEqual(result.inventory.unavailable.items[0].reasons, ["frozen"]);
  assert.equal(result.plans.find((plan) => plan.slot === "frozen").blockingReason, "inventory-unavailable");
});

test("只有冻结供给时返回可解释的库存边界而不产生零动作计划", () => {
  const catalog = {
    coverage: {},
    items: [{ id: "a2", chainId: "a", level: 2, baseUnits: 2 }],
    producers: [],
  };
  const state = {
    schemaVersion: 1,
    resources: { energy: 10 },
    board: { grids: [{ index: 1, itemId: "a2", normal: true, moveable: true, frozen: true }], mergeCandidates: [] },
    orders: [{ slot: "frozen", rewardCoins: 10, items: [{ itemId: "a2", complete: false }] }],
  };

  const result = buildOptimizationPlan({ catalog, state });

  assert.equal(result.recommended, null);
  assert.equal(result.boundaryReason, "inventory-unavailable");
  assert.equal(result.plans[0].feasible, false);
  assert.equal(result.plans[0].producerSteps.length, 0);
});

test("锁定、不可移动和非正常格物品都不计入可执行库存", () => {
  const catalog = {
    coverage: {},
    items: [
      { id: "locked", chainId: "a", level: 1, baseUnits: 1 },
      { id: "fixed", chainId: "b", level: 1, baseUnits: 1 },
      { id: "abnormal", chainId: "c", level: 1, baseUnits: 1 },
    ],
    producers: [],
  };
  const state = {
    schemaVersion: 1,
    resources: { energy: 10 },
    board: { grids: [
      { index: 1, itemId: "locked", normal: true, moveable: true, locked: true },
      { index: 2, itemId: "fixed", normal: true, moveable: false },
      { index: 3, itemId: "abnormal", normal: false, moveable: true },
    ], mergeCandidates: [] },
    orders: [],
  };

  const result = buildOptimizationPlan({ catalog, state });

  assert.equal(result.inventory.observable.total, 3);
  assert.equal(result.inventory.executable.total, 0);
  assert.deepEqual(result.inventory.unavailable.items.map((item) => item.reasons), [
    ["locked"], ["not-moveable"], ["not-normal"],
  ]);
});
