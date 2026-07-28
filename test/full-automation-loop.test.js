"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FullAutomationLoop } = require("../src/full-automation-loop");
const { OrderCoinLoop } = require("../src/order-coin-loop");
const { buildOptimizationPlan } = require("../src/order-optimizer");

test("默认在金币足够时停在地图升级确认边界", async () => {
  let calls = 0;
  const loop = new FullAutomationLoop({
    collectState: async () => ({ scene: "map", mapMission: { id: "m1", canComplete: true } }),
    navigate: async () => { calls += 1; }, runOrderCycle: async () => { calls += 1; }, completeMapMission: async () => { calls += 1; },
  });
  const result = await loop.run({ execute: true });
  assert.equal(result.reason, "map-upgrade-awaiting-confirmation");
  assert.equal(calls, 0);
});

test("显式开启地图升级后完成地图任务再进入棋盘订单循环", async () => {
  let read = 0;
  const states = [
    { scene: "map", mapMission: { id: "m1", canComplete: true } },
    { scene: "map", mapMission: { id: "m2", canComplete: false } },
    { scene: "board", mapMission: { id: "m2", canComplete: false } },
  ];
  const calls = [];
  const loop = new FullAutomationLoop({
    collectState: async () => states[Math.min(read++, states.length - 1)],
    autoMapUpgrade: true,
    completeMapMission: async () => { calls.push("complete"); return { ok: true, reason: "map-mission-completed" }; },
    navigate: async (target) => { calls.push(`navigate:${target}`); return { ok: true, reason: "navigation-verified" }; },
    runOrderCycle: async () => ({ ok: true, reason: "max-actions-reached", actions: [{ type: "produce", ok: true }] }),
  });
  const result = await loop.run({ execute: true, maxActions: 3 });
  assert.deepEqual(calls, ["complete", "navigate:board"]);
  assert.equal(result.actions[2].type, "produce");
});

test("没有可执行订单时以等待状态正常停机而不标记失败", async () => {
  const loop = new FullAutomationLoop({
    collectState: async () => ({ scene: "board", mapMission: { canComplete: false } }),
    navigate: async () => ({ ok: true }), completeMapMission: async () => ({ ok: true }),
    runOrderCycle: async () => ({ ok: true, reason: "waiting-no-feasible-order", actions: [] }),
  });
  const result = await loop.run({ execute: true });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "waiting-no-feasible-order");
});

test("完整循环把已采集状态传给订单循环而不立即重复读取", async () => {
  const state = { scene: "board", mapMission: { canComplete: false }, marker: "fresh-state" };
  let collections = 0;
  let received = null;
  const loop = new FullAutomationLoop({
    collectState: async () => { collections += 1; return state; },
    navigate: async () => ({ ok: true }),
    completeMapMission: async () => ({ ok: true }),
    runOrderCycle: async (options) => { received = options.initialState; return { ok: true, reason: "waiting-no-feasible-order", actions: [] }; },
  });

  const result = await loop.run({ execute: true });

  assert.equal(result.reason, "waiting-no-feasible-order");
  assert.equal(collections, 1);
  assert.equal(received, state);
});

test("完整循环把已生成计划传给订单循环而不立即重复规划", async () => {
  const state = { scene: "board", mapMission: { canComplete: false }, marker: "fresh-state" };
  const plan = { recommended: { slot: "a" }, plans: [{ slot: "a" }] };
  let received = null;
  const loop = new FullAutomationLoop({
    collectState: async () => state,
    navigate: async () => ({ ok: true }),
    completeMapMission: async () => ({ ok: true }),
    runOrderCycle: async (options) => {
      received = options.initialPlan;
      return { ok: true, reason: "waiting-no-feasible-order", actions: [] };
    },
  });

  const result = await loop.run({ execute: true, initialState: state, initialPlan: plan });

  assert.equal(result.reason, "waiting-no-feasible-order");
  assert.equal(received, plan);
});

test("导航失败会保留转场前后状态和原生动作供日志诊断", async () => {
  const before = { mapVisible: true, boardVisible: false };
  const after = { mapVisible: true, boardVisible: false };
  const nativeActions = [{ ok: true, type: "open-board" }];
  const loop = new FullAutomationLoop({
    collectState: async () => ({ scene: "map", mapMission: { canComplete: false } }),
    navigate: async () => ({ ok: false, reason: "navigation-not-observed", before, after, actions: nativeActions, verificationAttempts: 5 }),
    completeMapMission: async () => ({ ok: true }),
    runOrderCycle: async () => ({ ok: true, reason: "waiting-no-feasible-order", actions: [] }),
  });

  const result = await loop.run({ execute: true });

  assert.equal(result.ok, false);
  assert.equal(result.actions[0].reason, "navigation-not-observed");
  assert.deepEqual(result.actions[0].before, before);
  assert.deepEqual(result.actions[0].after, after);
  assert.deepEqual(result.actions[0].navigationActions, nativeActions);
  assert.equal(result.actions[0].verificationAttempts, 5);
});

test("棋盘订单循环获得剩余动作预算并在一次全量采集内连续执行", async () => {
  let collections = 0;
  let receivedLimit = null;
  const loop = new FullAutomationLoop({
    collectState: async () => { collections += 1; return { scene: "board", mapMission: { canComplete: false } }; },
    navigate: async () => ({ ok: true }),
    completeMapMission: async () => ({ ok: true }),
    runOrderCycle: async ({ maxActions }) => {
      receivedLimit = maxActions;
      return { ok: true, reason: "max-actions-reached", actions: Array.from({ length: maxActions }, (_, index) => ({ type: "merge", step: index + 1, ok: true })) };
    },
  });

  const result = await loop.run({ execute: true, maxActions: 3 });

  assert.equal(receivedLimit, 3);
  assert.equal(collections, 1);
  assert.equal(result.actions.length, 3);
});

test("连续编排100个原子动作始终串行且不产生重叠循环", async () => {
  let active = 0, maxActive = 0, executed = 0;
  const loop = new FullAutomationLoop({
    collectState: async () => ({ scene: "board", mapMission: { canComplete: false } }),
    navigate: async () => ({ ok: true }), completeMapMission: async () => ({ ok: true }),
    runOrderCycle: async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      executed += 1; active -= 1;
      return { ok: true, reason: "max-actions-reached", actions: [{ type: "merge", ok: true, step: executed }] };
    },
  });
  const result = await loop.run({ execute: true, maxActions: 100 });
  assert.equal(result.reason, "max-actions-reached");
  assert.equal(result.actions.length, 100);
  assert.equal(executed, 100);
  assert.equal(maxActive, 1);
});

test("自动模式不再受100步限制并在首个订单完成后停止", async () => {
  let executed = 0;
  const loop = new FullAutomationLoop({
    collectState: async () => ({ scene: "board", mapMission: { canComplete: false } }),
    navigate: async () => ({ ok: true }), completeMapMission: async () => ({ ok: true }),
    runOrderCycle: async () => {
      executed += 1;
      if (executed === 125) return { ok: true, reason: "order-submitted-and-coins-received", actions: [{ type: "submit-order", slot: "a", ok: true }] };
      return { ok: true, reason: "max-actions-reached", actions: [{ type: "merge", ok: true }] };
    },
  });
  const result = await loop.run({ execute: true });
  assert.equal(result.reason, "order-completed");
  assert.equal(result.completedOrder, "a");
  assert.equal(result.actions.length, 125);
});

test("完整自动化循环把冻结供给报告为库存不可用边界", async () => {
  const catalog = {
    coverage: {},
    items: [{ id: "a2", chainId: "a", level: 2, baseUnits: 2 }],
    producers: [],
  };
  const state = {
    schemaVersion: 1,
    scene: "board",
    resources: { energy: 10 },
    board: {
      empty: 10,
      grids: [{ index: 1, itemId: "a2", normal: true, moveable: true, frozen: true }],
      mergeCandidates: [],
    },
    orders: [{ slot: "frozen", rewardCoins: 10, ready: false, items: [{ itemId: "a2", complete: false }] }],
    mapMission: { canComplete: false },
  };
  const orderLoop = new OrderCoinLoop({
    collectState: async () => state,
    planOrders: async (current) => buildOptimizationPlan({ catalog, state: current }),
    runBoardAction: async () => { throw new Error("冻结供给不应触发棋盘动作"); },
    submitOrder: async () => { throw new Error("未完成订单不应提交"); },
  });
  const loop = new FullAutomationLoop({
    collectState: async () => state,
    navigate: async () => ({ ok: true }),
    completeMapMission: async () => ({ ok: true }),
    runOrderCycle: (options) => orderLoop.run(options),
  });

  const result = await loop.run({ execute: true });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "waiting-inventory-unavailable");
  assert.equal(result.orderCycle.plan.inventory.executable.total, 0);
});
