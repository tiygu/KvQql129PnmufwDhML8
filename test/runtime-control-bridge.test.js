"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationRuntime } = require("../src/automation-runtime");
const { FakeRuntimeControlAdapter } = require("../src/runtime-control-bridge");

function catalogFixture() {
  return {
    rules: {},
    coverage: { completeChains: ["items", "producer"], incompleteChains: [] },
    chains: [
      { id: "items", complete: true, minLevel: 1, maxLevel: 1, itemIds: ["item-1"] },
      { id: "producer", complete: true, minLevel: 1, maxLevel: 1, itemIds: ["producer-1"] },
    ],
    items: [
      { id: "item-1", chainId: "items", level: 1, baseUnits: 1, mergeTarget: null },
      { id: "producer-1", chainId: "producer", level: 1, baseUnits: 1, mergeTarget: null },
    ],
    producers: [{
      itemId: "producer-1",
      chainId: "producer",
      level: 1,
      energyCost: 1,
      sampleSize: 1,
      drops: [{ itemId: "item-1", count: 1, probability: 1 }],
    }],
  };
}

function boardState({ ready = false, energy = 5 } = {}) {
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    scene: "board",
    resources: { coins: 0, diamonds: 0, energy },
    energy: { amount: energy, limit: 10, recoverIntervalSeconds: 60, recoverTimestamp: null, recovering: false },
    board: {
      available: true,
      visible: true,
      width: 3,
      height: 3,
      occupied: ready ? 2 : 1,
      empty: ready ? 7 : 8,
      signature: ready ? "producer-1|item-1" : "producer-1",
      grids: [
        { index: 0, itemId: "producer-1", normal: true, moveable: true, frozen: false, locked: false, produceCount: 5, energyCost: 1 },
        ...(ready ? [{ index: 1, itemId: "item-1", normal: true, moveable: true, frozen: false, locked: false }] : []),
      ],
      mergeCandidates: [],
      requiredItemCounts: ready ? {} : { "item-1": 1 },
    },
    orders: [{
      slot: "order-1",
      rewardCoins: 10,
      ready,
      items: [{ itemId: "item-1", complete: ready, status: ready ? 1 : 0 }],
      requiredItemIds: ["item-1"],
      missingItemIds: ready ? [] : ["item-1"],
    }],
    producers: [{ index: 0, itemId: "producer-1", produceCount: 5, energyCost: 1 }],
    warehouse: { inventoryKnowledge: { status: "unknown" } },
    mapMission: { canComplete: false },
  };
}

test("Fake Adapter drives a complete read, plan, execute, record, and replan scenario", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-control-fake-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(catalogFixture()), "utf8");
  const runtimeControl = new FakeRuntimeControlAdapter({
    states: [boardState(), boardState({ ready: true, energy: 4 })],
    results: [
      { ok: true, reason: "max_actions_reached", stopReason: "max_actions_reached", actions: [{ type: "produce", producer: 0, verified: true }] },
      { ok: true, reason: "order-submitted-and-coins-received", coinsBefore: 0, coinsAfter: 10 },
    ],
  });
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    runtimeControl,
  });

  try {
    const result = await runtime.start({ mode: "automatic", maxActions: 2 });
    const recorded = runtime.database.listRecentActions(10)
      .filter((action) => Number(action.session_id) === Number(runtime.database.listSessions(1)[0].id))
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));

    assert.equal(result.reason, "order-completed");
    assert.deepEqual(runtimeControl.commands.map((command) => command.type), ["run-board-action", "submit-order"]);
    assert.equal(runtimeControl.readCount, 2);
    assert.deepEqual(recorded.map((action) => action.action_type), ["produce", "submit-order"]);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Fake Adapter aborts a pending action through the bridge interface", async () => {
  let release;
  const runtimeControl = new FakeRuntimeControlAdapter({
    results: [() => new Promise((resolve) => { release = resolve; })],
  });
  const controller = new AbortController();
  const executing = runtimeControl.execute({ type: "run-board-action" }, { signal: controller.signal })
    .then(() => "resolved", (error) => error.name);

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const outcome = await Promise.race([
    executing,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);
  release?.({ ok: true, reason: "late-result" });

  assert.equal(outcome, "AbortError");
});

test("Fake Adapter supplies stable action failures without throwing", async () => {
  const runtimeControl = new FakeRuntimeControlAdapter({
    results: [{ ok: false, reason: "game-precondition-rejected", details: { itemId: "item-1" } }],
  });

  const result = await runtimeControl.execute({ type: "submit-order", slot: "order-1" });

  assert.deepEqual(result, {
    ok: false,
    reason: "game-precondition-rejected",
    details: { itemId: "item-1" },
  });
});

test("Automation Runtime pause keeps Fake Adapter actions behind the action boundary", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-control-pause-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(catalogFixture()), "utf8");
  const runtimeControl = new FakeRuntimeControlAdapter({
    states: [boardState(), boardState({ ready: true, energy: 4 })],
    results: [
      { ok: true, stopReason: "max_actions_reached", actions: [{ type: "produce", producer: 0, verified: true }] },
      { ok: true, reason: "order-submitted-and-coins-received", coinsBefore: 0, coinsAfter: 10 },
    ],
  });
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    runtimeControl,
  });

  try {
    const running = runtime.start({ mode: "automatic", maxActions: 2 });
    while (runtime.actionBoundaryPending) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.pause().paused, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runtimeControl.commands.length, 0);

    assert.equal(runtime.resume().paused, false);
    assert.equal((await running).reason, "order-completed");
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
