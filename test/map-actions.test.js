"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OPEN_MAP_MISSION_EXPRESSION, COMPLETE_MAP_MISSION_EXPRESSION, MapMissionCompleter } = require("../src/map-actions");

test("地图动作分别只调用一次原有打开和升级处理器", () => {
  assert.equal((OPEN_MAP_MISSION_EXPRESSION.match(/main\.lookAtMissionBubbleAndOpen\(\)/g) || []).length, 1);
  assert.equal((COMPLETE_MAP_MISSION_EXPRESSION.match(/panel\.upgrade\(\)/g) || []).length, 1);
  assert.match(COMPLETE_MAP_MISSION_EXPRESSION, /_canUpgrade/);
  assert.match(COMPLETE_MAP_MISSION_EXPRESSION, /_buttonClicked/);
});

test("地图面板未打开时按打开、复查、升级顺序执行并验证金币与任务", async () => {
  const expressions = [];
  let uiReads = 0;
  let stateReads = 0;
  const states = [
    { resources: { coins: 400 }, mapMission: { id: "m1", canComplete: true } },
    { resources: { coins: 76 }, mapMission: { id: "m2", canComplete: false } },
  ];
  const completer = new MapMissionCompleter({
    client: { evaluate: async (expression) => {
      expressions.push(expression);
      if (expression.includes("type: \"open-map-mission\"")) return { ok: true };
      if (expression.includes("type: \"complete-map-mission\"")) return { ok: true };
      return uiReads++ ? { ok: true, panelVisible: true } : { ok: true, panelVisible: false };
    } },
    contextId: 7,
    collectState: async () => states[stateReads++],
    settleMs: 1,
  });
  const result = await completer.complete({ execute: true });
  assert.equal(result.ok, true);
  assert.equal(result.missionAfter.id, "m2");
  assert.equal(expressions.length, 4);
});

test("地图面板保留旧任务配置时以 mapProgress 的当前任务作为进度验收", async () => {
  let stateReads = 0;
  const states = [
    { resources: { coins: 361 }, mapProgress: { currentTask: "m1" }, mapMission: { id: "m1", canComplete: true, requirements: [{ required: 324 }] } },
    { resources: { coins: 37 }, mapProgress: { currentTask: "m2" }, mapMission: { id: "m1", canComplete: false, configurationStale: true, requirements: [{ required: 324 }] } },
  ];
  const completer = new MapMissionCompleter({
    client: { evaluate: async (expression) => expression.includes("complete-map-mission")
      ? { ok: true, taskId: "m1" }
      : { ok: true, panelVisible: true, taskId: "m1", canUpgrade: true } },
    contextId: 7,
    collectState: async () => states[Math.min(stateReads++, states.length - 1)],
    settleMs: 1,
  });
  const result = await completer.complete({ execute: true });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "map-mission-completed");
  assert.equal(result.progressBefore, "m1");
  assert.equal(result.progressAfter, "m2");
});
