"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BOARD_SCAN_EXPRESSION, buildBoardMergeExpression } = require("../src/board-automation");
const {
  BOARD_CONTROL_STATE_EXPRESSION,
  buildAtomicProducerTouchExpression,
  buildAtomicMergeExpression,
  BoardAutomationRunner,
} = require("../src/board-runner");

test("棋盘扫描表达式只读取棋盘并预测可合成组合", () => {
  assert.match(BOARD_SCAN_EXPRESSION, /__private_95_grids/);
  assert.match(BOARD_SCAN_EXPRESSION, /predictDragResult/);
  assert.doesNotMatch(BOARD_SCAN_EXPRESSION, /mergeBoardGridWith\s*\(/);
});

test("产出物默认不进入普通合成候选", () => {
  assert.match(BOARD_SCAN_EXPRESSION, /produceCount/);
  assert.match(BOARD_SCAN_EXPRESSION, /EnergyCost/);
});

test("单次合成默认只预检，显式 execute 才调用拖拽流程", () => {
  const preview = buildBoardMergeExpression(21, 22, false);
  const execute = buildBoardMergeExpression(21, 22, true);
  assert.doesNotMatch(preview, /onDragStart/);
  assert.match(execute, /onDragStart\(source\.center\)/);
  assert.throws(() => buildBoardMergeExpression(1, 1, false), /must differ/);
});

test("原子动作表达式不包含自动化循环和长等待", () => {
  const touch = buildAtomicProducerTouchExpression(30);
  const merge = buildAtomicMergeExpression(21, 22);
  for (const expression of [touch, merge]) {
    assert.doesNotMatch(expression, /for\s*\(let step/);
    assert.doesNotMatch(expression, /setTimeout/);
  }
  assert.match(touch, /boardView\.onTouch\(grid\.center\)/);
  assert.match(merge, /boardView\.onDragEnd\(source\.center, target\.center\)/);
});

function state(overrides = {}) {
  return {
    ok: true,
    boardVisible: true,
    signature: "p||",
    empty: 2,
    grids: [{ index: 0, itemId: "p", empty: false }, { index: 1, itemId: "", empty: true }, { index: 2, itemId: "", empty: true }],
    readyOrders: [],
    mergeCandidates: [],
    producers: [{ index: 0, itemId: "p", produceCount: 10, energyCost: 1 }],
    ...overrides,
  };
}

class FakeClient {
  constructor(states) {
    this.states = [...states];
    this.calls = [];
  }

  async evaluate(expression, contextId, options) {
    this.calls.push({ expression, contextId, options });
    if (expression === BOARD_CONTROL_STATE_EXPRESSION) return this.states.shift();
    if (expression.includes('type: "producer-touch"')) return { ok: true, type: "producer-touch" };
    if (expression.includes('type: "merge"')) return { ok: true, type: "merge" };
    throw new Error("unexpected expression");
  }
}

test("Node侧循环把产出物的选中和产出拆成两个短Runtime.evaluate", async () => {
  const client = new FakeClient([
    state(),
    state(),
    state({ signature: "p|a|", empty: 1, grids: [{ index: 0, itemId: "p", empty: false }, { index: 1, itemId: "a", empty: false }, { index: 2, itemId: "", empty: true }] }),
  ]);
  const runner = new BoardAutomationRunner({ client, contextId: 7, delayMs: 300 });
  runner.waitForSettle = async () => {};
  const result = await runner.run({ producer: 0, maxActions: 1, execute: true });
  assert.equal(result.ok, true);
  assert.equal(result.actions[0].type, "produce");
  assert.equal(result.actions[0].touches, 2);
  assert.equal(client.calls.filter((call) => call.expression === BOARD_CONTROL_STATE_EXPRESSION).length, 3);
  assert.equal(client.calls.filter((call) => call.expression.includes('type: "producer-touch"')).length, 2);
});

test("订单已满足时Node侧编排器在执行动作前停止", async () => {
  const client = new FakeClient([state({ readyOrders: [{ slot: "order", items: [{ itemId: "a" }] }] })]);
  const runner = new BoardAutomationRunner({ client, contextId: 7, delayMs: 300 });
  const result = await runner.run({ producer: 0, maxActions: 10, execute: true });
  assert.equal(result.stopReason, "order_ready");
  assert.equal(result.actions.length, 0);
  assert.equal(client.calls.length, 1);
});

test("rolling planner executes the exact first merge and rereads state", async () => {
  const candidates = [{ from: 1, to: 2, itemId: "a" }, { from: 3, to: 4, itemId: "b" }];
  const beforeGrids = [{ index: 1, itemId: "a", empty: false }, { index: 2, itemId: "a", empty: false }, { index: 3, itemId: "b", empty: false }, { index: 4, itemId: "b", empty: false }];
  const afterGrids = [{ index: 1, itemId: "a", empty: false }, { index: 2, itemId: "a", empty: false }, { index: 3, itemId: "", empty: true }, { index: 4, itemId: "b2", empty: false }];
  const client = new FakeClient([
    state({ signature: "a|a|b|b", grids: beforeGrids, mergeCandidates: candidates, producers: [] }),
    state({ signature: "a|a||b2", grids: afterGrids, mergeCandidates: [], producers: [] }),
  ]);
  const runner = new BoardAutomationRunner({ client, contextId: 7, delayMs: 300 });
  runner.waitForSettle = async () => {};
  const result = await runner.run({ merge: { from: 3, to: 4 }, plannedAction: { type: "merge", from: 3, to: 4 }, maxActions: 1, execute: true });
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 1);
  const mergeCall = client.calls.find((call) => call.expression.includes('type: "merge"'));
  assert.match(mergeCall.expression, /grids\[3\]/);
  assert.match(mergeCall.expression, /grids\[4\]/);
  assert.equal(client.calls.filter((call) => call.expression === BOARD_CONTROL_STATE_EXPRESSION).length, 2);
});

test("原子动作超时后停止编排且不发送后续动作", async () => {
  const client = new FakeClient([state()]);
  client.evaluate = async function evaluate(expression, contextId, options) {
    this.calls.push({ expression, contextId, options });
    if (expression === BOARD_CONTROL_STATE_EXPRESSION) return this.states.shift();
    throw new Error("CDP timeout: Runtime.evaluate (10000ms)");
  };
  const runner = new BoardAutomationRunner({ client, contextId: 7, delayMs: 300 });
  runner.waitForSettle = async () => {};
  const result = await runner.run({ producer: 0, maxActions: 10, execute: true });
  assert.equal(result.reason, "atomic_action_error");
  assert.equal(result.uncertainAction.type, "producer-touch");
  assert.equal(client.calls.length, 2);
});

test("中止信号在下一原子动作前结束循环", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new FakeClient([state()]);
  const runner = new BoardAutomationRunner({ client, contextId: 7, delayMs: 300 });
  const result = await runner.run({ producer: 0, maxActions: 10, execute: true, signal: controller.signal });
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.actions.length, 0);
  assert.equal(client.calls.length, 1);
});
