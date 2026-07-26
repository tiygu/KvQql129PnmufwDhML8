"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AutomationOrchestrator } = require("../src/automation-orchestrator");

function gameState(overrides = {}) {
  return {
    resources: { energy: 20 },
    board: { signature: "before", mergeCandidates: [] },
    orders: [{ slot: "a", ready: false }, { slot: "b", ready: false }],
    ...overrides,
  };
}

test("订单目标锁定后不会因为另一订单效率升高而跳单", async () => {
  let round = 0;
  const plans = [
    { plans: [{ slot: "a", producerSteps: [{ gridIndex: 30, producerItemId: "p" }] }, { slot: "b", producerSteps: [] }], recommended: { slot: "a", producerSteps: [{ gridIndex: 30, producerItemId: "p" }] } },
    { plans: [{ slot: "a", producerSteps: [{ gridIndex: 30, producerItemId: "p" }] }, { slot: "b", producerSteps: [{ gridIndex: 31, producerItemId: "q" }] }], recommended: { slot: "b", producerSteps: [{ gridIndex: 31, producerItemId: "q" }] } },
  ];
  const orchestrator = new AutomationOrchestrator({ collectState: async () => gameState(), planOrders: async () => plans[round++] });
  const first = await orchestrator.step();
  const second = await orchestrator.step();
  assert.equal(first.target.slot, "a");
  assert.equal(second.target.slot, "a");
  assert.equal(second.action.producer, 30);
});

test("目标订单消失后释放锁并采用新推荐订单", async () => {
  let round = 0;
  const plans = [
    { plans: [{ slot: "a", producerSteps: [] }], recommended: { slot: "a", producerSteps: [] } },
    { plans: [{ slot: "b", producerSteps: [{ gridIndex: 31, producerItemId: "q" }] }], recommended: { slot: "b", producerSteps: [{ gridIndex: 31, producerItemId: "q" }] } },
  ];
  const orchestrator = new AutomationOrchestrator({ collectState: async () => gameState(), planOrders: async () => plans[round++] });
  await orchestrator.step();
  const result = await orchestrator.step();
  assert.equal(orchestrator.targetOrderSlot, "b");
  assert.equal(result.action.producer, 31);
});

test("每次动作后重新采集状态并验证变化", async () => {
  let collects = 0;
  const orchestrator = new AutomationOrchestrator({
    collectState: async () => gameState({ board: { signature: collects++ ? "after" : "before", mergeCandidates: collects === 1 ? [{ from: 1, to: 2, itemId: "x" }] : [] } }),
    planOrders: async () => ({ plans: [{ slot: "a", producerSteps: [] }], recommended: { slot: "a", producerSteps: [] } }),
    executeAction: async (action) => ({ ok: true, action }),
  });
  const result = await orchestrator.step({ execute: true });
  assert.equal(collects, 2);
  assert.equal(result.action.type, "merge");
  assert.equal(result.ok, true);
});

test("目标订单已满足时停在提交边界且不执行棋盘动作", async () => {
  let executed = 0;
  const orchestrator = new AutomationOrchestrator({
    collectState: async () => gameState({ orders: [{ slot: "a", ready: true }] }),
    planOrders: async () => ({ plans: [{ slot: "a", ready: true, producerSteps: [] }], recommended: { slot: "a", ready: true, producerSteps: [] } }),
    executeAction: async () => { executed += 1; return { ok: true }; },
  });
  const result = await orchestrator.step({ execute: true });
  assert.equal(result.status, "order-ready");
  assert.equal(result.executed, false);
  assert.equal(executed, 0);
});

test("已锁定订单变为不可执行时释放并改选推荐订单", async () => {
  let round = 0;
  const plans = [
    {
      plans: [{ slot: "a", feasible: true, producerSteps: [{ gridIndex: 30, producerItemId: "p" }] }],
      recommended: { slot: "a", feasible: true, producerSteps: [{ gridIndex: 30, producerItemId: "p" }] },
    },
    {
      plans: [
        { slot: "a", feasible: false, blockingReason: "inventory-unavailable", producerSteps: [] },
        { slot: "b", feasible: true, producerSteps: [{ gridIndex: 31, producerItemId: "q" }] },
      ],
      recommended: { slot: "b", feasible: true, producerSteps: [{ gridIndex: 31, producerItemId: "q" }] },
    },
  ];
  const orchestrator = new AutomationOrchestrator({
    collectState: async () => gameState(),
    planOrders: async () => plans[round++],
  });

  await orchestrator.step();
  const result = await orchestrator.step();

  assert.equal(result.target.slot, "b");
  assert.equal(result.action.producer, 31);
  assert.equal(orchestrator.targetOrderSlot, "b");
});

test("没有可执行订单时传递规划器的可解释边界", async () => {
  const orchestrator = new AutomationOrchestrator({
    collectState: async () => gameState(),
    planOrders: async () => ({
      plans: [{ slot: "a", feasible: false, blockingReason: "inventory-unavailable", producerSteps: [] }],
      recommended: null,
      boundaryReason: "inventory-unavailable",
    }),
  });

  const result = await orchestrator.step();

  assert.equal(result.reason, "inventory-unavailable");
  assert.equal(result.action, null);
});

test("推荐项本身没有动作时搜索其他可执行订单", async () => {
  const stale = { slot: "a", feasible: true, actionable: false, producerSteps: [] };
  const executable = { slot: "b", feasible: true, actionable: true, producerSteps: [{ gridIndex: 31, producerItemId: "q" }] };
  const orchestrator = new AutomationOrchestrator({
    collectState: async () => gameState(),
    planOrders: async () => ({ plans: [stale, executable], recommended: stale }),
  });

  const result = await orchestrator.step();

  assert.equal(result.target.slot, "b");
  assert.equal(result.action.producer, 31);
});
