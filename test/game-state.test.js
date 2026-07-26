"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGameState } = require("../src/game-state");

test("统一GameState合并快照资源与棋盘实时订单", () => {
  const gameState = buildGameState({
    state: {
      sourceAdapter: "target-game",
      resources: [{ type: 1, amount: 208 }, { type: 2, amount: 70 }, { type: 3, amount: 19 }],
      energy: [{ amount: 19, limit: 100, recovering: true }],
      tasks: [{ slot: "a", taskId: "old", awardValue: 20, items: [{ itemId: "101", complete: false }], rewards: [] }],
      mapMission: { id: "m1", nextId: "m2", requirements: [{ resourceType: 1, required: 350 }] },
      mapProgress: { currentTask: "m2", currentSeason: 1, allFinished: false },
      gameplay: { mode: "board", warehouse: { loaded: true, occupiedSlots: 1 } },
    },
    boardState: {
      ok: true, boardVisible: true, width: 7, height: 9, occupied: 44, empty: 19, signature: "a|b",
      grids: [{ index: 0, itemId: 101, empty: false }],
      producers: [{ index: 30, itemId: 900, produceCount: 5 }],
      mergeCandidates: [{ from: 1, to: 2, itemId: "101" }],
      requiredItemCounts: { 101: 1 },
      orders: [{ slot: "a", taskId: "new", rewardCoins: 25, items: [{ itemId: "101", complete: true }] }],
    },
  });

  assert.equal(gameState.scene, "board");
  assert.deepEqual(gameState.resources, { coins: 208, diamonds: 70, energy: 19 });
  assert.equal(gameState.orders[0].taskId, "new");
  assert.equal(gameState.orders[0].ready, true);
  assert.equal(gameState.board.grids[0].itemId, "101");
  assert.equal(gameState.producers[0].itemId, "900");
  assert.equal(gameState.mapMission.requirements[0].deficit, 142);
  assert.equal(gameState.mapMission.canComplete, false);
  assert.equal(gameState.mapProgress.currentTask, "m2");
  assert.equal(gameState.mapMission.configurationStale, true);
});

test("棋盘运行时不可用时仍返回稳定的GameState结构", () => {
  const gameState = buildGameState({ state: { resources: [], tasks: [], gameplay: { mode: "map" } } });
  assert.equal(gameState.scene, "map");
  assert.equal(gameState.board.available, false);
  assert.deepEqual(gameState.board.grids, []);
  assert.deepEqual(gameState.orders, []);
  assert.deepEqual(gameState.overlays, []);
});
