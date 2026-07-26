"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAtomicSubmitOrderExpression, OrderSubmitter } = require("../src/order-actions");

test("订单提交表达式先验证订单完成状态并只调用一次原有提交处理器", () => {
  const expression = buildAtomicSubmitOrderExpression("YMD_3_1");
  assert.match(expression, /items\.every/);
  assert.match(expression, /task\._inSubmit/);
  assert.equal((expression.match(/buttonView\.submitTask\(\)/g) || []).length, 1);
  assert.doesNotMatch(expression, /for\s*\(let step/);
});

test("提交订单后同时验证订单替换和金币到账", async () => {
  let reads = 0;
  const states = [
    { resources: { coins: 100 }, orders: [{ slot: "s", taskId: "old", ready: true }] },
    { resources: { coins: 125 }, orders: [{ slot: "s", taskId: "new", ready: false }] },
  ];
  const evaluations = [];
  const submitter = new OrderSubmitter({
    client: { evaluate: async (expression) => { evaluations.push(expression); return { ok: true }; } },
    contextId: 7,
    collectState: async () => states[reads++],
    settleMs: 1,
  });
  const result = await submitter.submit("s", { execute: true });
  assert.equal(result.ok, true);
  assert.equal(result.coinsAfter, 125);
  assert.equal(evaluations.length, 1);
});

test("未完成订单在Node侧预检阶段被拦截", async () => {
  let evaluated = 0;
  const submitter = new OrderSubmitter({
    client: { evaluate: async () => { evaluated += 1; } },
    contextId: 7,
    collectState: async () => ({ resources: { coins: 100 }, orders: [{ slot: "s", taskId: "old", ready: false }] }),
  });
  const result = await submitter.submit("s", { execute: true });
  assert.equal(result.reason, "order_not_ready");
  assert.equal(evaluated, 0);
});
