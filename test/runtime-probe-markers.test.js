"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { RUNTIME_PROBE_EXPRESSION } = require("../src/runtime-probe");

function node(name, children = []) {
  return {
    name,
    children,
    getChildByName(childName) { return this.children.find((child) => child.name === childName) || null; },
  };
}

test("运行时探针识别目标游戏的稳定场景锚点", () => {
  const scene = node("main", [
    node("Entry", [node("AudioManager")]),
    node("Canvas", [node("ui", [
      node("root", [node("map_panel", [node("scale_root", [node("map", [node("map_root", [
        node("AreaThumb_Area_Farms"),
      ])])])])]),
      node("content", [node("board_view", [node("board", [node("task_view")])])]),
    ])]),
  ]);
  const cc = { ENGINE_VERSION: "3.8.7", director: { getScene: () => scene }, game: { canvas: {} } };
  const result = vm.runInNewContext(RUNTIME_PROBE_EXPRESSION, {
    cc,
    GameGlobal: { cc },
    MainScene: {},
    wx: {},
    WebAssembly,
    setTimeout,
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(result.hints.sceneMarkers)),
    { entryAudio: true, mapPanel: true, farmArea: true, taskBoard: true },
  );
});
