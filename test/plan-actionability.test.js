"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isPlanActionable } = require("../src/plan-actionability");

test("订单计划必须包含提交、合成或生产动作才可执行", () => {
  assert.equal(isPlanActionable({ producerSteps: [] }), false);
  assert.equal(isPlanActionable({ ready: true, producerSteps: [] }), true);
  assert.equal(isPlanActionable({ producerSteps: [{ gridIndex: 1 }] }), true);
  assert.equal(isPlanActionable({ producerSteps: [] }, { hasMergeCandidate: true }), true);
});
