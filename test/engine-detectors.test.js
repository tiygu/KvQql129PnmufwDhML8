"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectEngines, scoreContext } = require("../src/engine-detectors");

test("detects Cocos and scores a game context above a worker", () => {
  const game = {
    ok: true,
    context: { id: 2, name: "gameContext" },
    data: {
      environment: { hasGameGlobal: true, hasWx: true, hasCanvas: true },
      capabilities: { webgl: true },
      engines: { cocos: { present: true, version: "3.x" } },
    },
  };
  const worker = {
    ok: true,
    context: { id: 1, name: "serviceWorker" },
    data: {
      environment: { hasGameGlobal: false, hasWx: true, hasCanvas: false },
      capabilities: { webgl: false },
      engines: {},
    },
  };
  assert.equal(detectEngines(game.data)[0].id, "cocos");
  assert.ok(scoreContext(game) > scoreContext(worker));
});

test("failed probes receive the lowest score", () => {
  assert.equal(scoreContext({ ok: false }), -1000);
});
