"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OPEN_BOARD_EXPRESSION, OPEN_MAP_EXPRESSION, CLOSE_MAP_MISSION_EXPRESSION, SceneNavigator } = require("../src/scene-navigation");

test("场景导航表达式各自只调用一次游戏原有处理器", () => {
  assert.equal((OPEN_BOARD_EXPRESSION.match(/entrance\.view\.onBoardClick\(\)/g) || []).length, 1);
  assert.equal((OPEN_MAP_EXPRESSION.match(/boardView\.onMapButtonClick\(\)/g) || []).length, 1);
  assert.equal((CLOSE_MAP_MISSION_EXPRESSION.match(/panel\.hideByCloseBtn\(\)/g) || []).length, 1);
});

test("地图任务弹窗存在时先关闭弹窗再进入棋盘", async () => {
  const calls = [];
  let stateRead = 0;
  const states = [
    { ok: true, mapVisible: true, boardVisible: false, entranceVisible: true, mapMissionVisible: true },
    { ok: true, mapVisible: true, boardVisible: false, entranceVisible: true, mapMissionVisible: false },
    { ok: true, mapVisible: false, boardVisible: true, entranceVisible: false, mapMissionVisible: false },
  ];
  const navigator = new SceneNavigator({
    client: { evaluate: async (expression) => {
      if (expression.includes("mapVisible:")) return states[stateRead++];
      calls.push(expression);
      return { ok: true };
    } },
    contextId: 7,
    settleMs: 1,
  });
  const result = await navigator.go("board", { execute: true });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /hideByCloseBtn/);
  assert.match(calls[1], /onBoardClick/);
});

test("进入棋盘的慢转场会持续验证而不会在第一次未观察到时结束", async () => {
  const calls = [];
  let stateRead = 0;
  const states = [
    { ok: true, mapVisible: true, boardVisible: false, entranceVisible: true, mapMissionVisible: false },
    { ok: true, mapVisible: true, boardVisible: false, entranceVisible: true, mapMissionVisible: false },
    { ok: true, mapVisible: true, boardVisible: false, entranceVisible: true, mapMissionVisible: false },
    { ok: true, mapVisible: false, boardVisible: true, entranceVisible: false, mapMissionVisible: false },
  ];
  const navigator = new SceneNavigator({
    client: { evaluate: async (expression) => {
      if (expression.includes("mapVisible:")) return states[Math.min(stateRead++, states.length - 1)];
      calls.push(expression);
      return { ok: true };
    } },
    contextId: 7,
    settleMs: 1,
  });

  const result = await navigator.go("board", { execute: true });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "navigation-verified");
  assert.equal(stateRead, 4);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /onBoardClick/);
});
