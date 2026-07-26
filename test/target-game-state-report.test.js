"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeSnapshot } = require("../scripts/summarize-target-snapshot.cjs");

test("目标游戏原始快照可归一化为资源、能量和任务报告", () => {
  const map = (entries) => ({ kind: "Map", entries });
  const array = (items) => ({ kind: "Array", items });
  const snapshot = {
    adapter: "target-game",
    engine: { version: "3.8.7", scene: "main" },
    counts: { total: 10, active: 8, inactive: 2 },
    domainManagers: {
      resources: { data: { _resourceMap: map([["3", 20]]) } },
      energy: { data: { _energyDataMap: map([["3", { fields: { _energyLimit: 100, _recoverInterval: 120 } }]]) } },
      tasks: { data: { clientTaskDataMap: map([["1", map([["slot", { fields: {
        taskId: "1",
        itemInfos: array([{ primitiveFields: { itemId: "x", isComplete: true, status: 1 } }]),
        rewards: array([{ primitiveFields: { type: 1, id: "1", count: 5 } }]),
      } }]])]]) } },
    },
    mapBehaviors: [],
  };
  const result = summarizeSnapshot(snapshot);
  assert.deepEqual(result.resources, [{ type: 3, amount: 20 }]);
  assert.equal(result.energy[0].limit, 100);
  assert.equal(result.tasks[0].items[0].complete, true);
  assert.equal(result.taskSummary.ready, 1);
});
