"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TargetGameAdapter } = require("../src/adapters/custom/target-game");

function probe(overrides = {}) {
  return {
    data: {
      engines: { cocos: { present: true, version: "3.8.7", scene: "main" } },
      hints: {
        engineLikeGlobals: ["MainScene"],
        sceneMarkers: { entryAudio: true, mapPanel: true, farmArea: true, taskBoard: true },
      },
      ...overrides,
    },
  };
}

test("目标游戏的场景标记优先于通用 Cocos 适配器", () => {
  const adapter = new TargetGameAdapter();
  assert.ok(adapter.match(probe()) > 50);
});

test("只有 Cocos 或单个通用节点时不误选目标游戏适配器", () => {
  const adapter = new TargetGameAdapter();
  assert.equal(adapter.match(probe({ hints: { sceneMarkers: { mapPanel: true } } })), 0);
  assert.equal(adapter.match({ data: { engines: { cocos: { present: false } } } }), 0);
});

test("目标游戏快照固定使用传入的 execution context", async () => {
  const adapter = new TargetGameAdapter();
  let call;
  const client = { evaluate: async (expression, contextId) => {
    call = { expression, contextId };
    return { adapter: "target-game" };
  } };
  const result = await adapter.snapshot(client, { id: 7 });
  assert.equal(call.contextId, 7);
  assert.match(call.expression, /AreaThumb_Area_Farms/);
  assert.match(call.expression, /mManagers/);
  assert.match(call.expression, /mControllers/);
  assert.match(call.expression, /domainManagers/);
  assert.match(call.expression, /clientTaskDataMap/);
  assert.match(call.expression, /focusedControllers/);
  assert.match(call.expression, /WarehouseViewController/);
  assert.match(call.expression, /gameplayState/);
  assert.match(call.expression, /selectedItemUi/);
  assert.equal(result.adapter, "target-game");
});
