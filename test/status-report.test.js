"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStatusReport } = require("../src/status-report");

test("实时状态报告计算可提交订单与地图金币缺口", () => {
  const report = buildStatusReport({
    resources: [{ type: 1, amount: 56 }, { type: 3, amount: 202 }],
    energy: [{ type: 3, amount: 202, limit: 100 }],
    tasks: [
      { slot: "a", taskId: "1", awardValue: 10, items: [{ itemId: "x", complete: true }], rewards: [{ type: 1, count: 10 }] },
      { slot: "b", taskId: "2", awardValue: 20, items: [{ itemId: "y", complete: false }], rewards: [{ type: 1, count: 20 }] },
    ],
    mapMission: { id: "m1", nextId: "m2", requirements: [{ resourceType: 1, required: 324 }] },
    gameplay: { mode: "board", warehouse: { loaded: true, totalSlots: 68, unlockedSlots: 7, occupiedSlots: 1 } },
  });
  assert.equal(report.orderSummary.ready, 1);
  assert.deepEqual(report.boardOrders[1].missingItemIds, ["y"]);
  assert.equal(report.mapMission.requirements[0].deficit, 268);
  assert.equal(report.mapMission.canComplete, false);
});

test("地图进度已推进时显示权威任务并阻止使用旧配置", () => {
  const report = buildStatusReport({
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    scene: "board",
    resources: { coins: 429, diamonds: 70, energy: 80 },
    energy: { limit: 100 },
    orders: [],
    mapProgress: { currentTask: "11001031" },
    mapMission: {
      id: "11001030",
      nextId: "11001031",
      requirements: [{ resourceType: 1, current: 429, required: 324, enough: true }],
    },
  });
  assert.equal(report.mapMission.id, "11001031");
  assert.equal(report.mapMission.configuredTaskId, "11001030");
  assert.equal(report.mapMission.configurationStale, true);
  assert.equal(report.mapMission.canComplete, false);
});
