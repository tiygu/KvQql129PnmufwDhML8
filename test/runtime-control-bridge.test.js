"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationRuntime } = require("../src/automation-runtime");
const { BoardAutomationRunner } = require("../src/board-runner");
const { OrderSubmitter } = require("../src/order-actions");
const { MapMissionCompleter } = require("../src/map-actions");
const { SceneNavigator } = require("../src/scene-navigation");
const { WarehouseActionExecutor } = require("../src/warehouse-actions");
const { ProductionModeExecutor } = require("../src/production-mode-actions");
const { SaleActionExecutor } = require("../src/sale-actions");
const { FakeRuntimeControlAdapter, LegacyRuntimeControlAdapter } = require("../src/runtime-control-bridge");

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

function assistedSaleScenario() {
  const gridItemIds = ["producer-1", "surplus-1", "item-1", "surplus-2", "surplus-3", "surplus-4"];
  const surplusIds = gridItemIds.filter((itemId) => itemId.startsWith("surplus-"));
  return {
    state: {
      ...boardState(),
      scene: "board",
      resources: { coins: 0, diamonds: 0, energy: 5 },
      board: {
        available: true,
        visible: true,
        width: 3,
        height: 2,
        capacity: 6,
        occupied: 6,
        empty: 0,
        signature: gridItemIds.join("|"),
        grids: gridItemIds.map((itemId, index) => ({
          index,
          itemId,
          normal: true,
          moveable: true,
          frozen: false,
          locked: false,
          ...(itemId === "producer-1" ? { produceCount: 5, energyCost: 1 } : {}),
        })),
        mergeCandidates: [],
        requiredItemCounts: { "item-2": 1 },
      },
      orders: [{
        slot: "order-1",
        rewardCoins: 10,
        ready: false,
        items: [{ itemId: "item-2", complete: false, status: 0 }],
        requiredItemIds: ["item-2"],
        missingItemIds: ["item-2"],
      }],
      mapMission: {
        canComplete: false,
        requirements: [{ resourceType: 1, required: 20, current: 0, deficit: 20 }],
      },
    },
    catalog: {
      rules: {},
      coverage: { completeChains: ["items", "producer", ...surplusIds], incompleteChains: [] },
      chains: [
        { id: "items", complete: true, minLevel: 1, maxLevel: 2, itemIds: ["item-1", "item-2"] },
        { id: "producer", complete: true, minLevel: 1, maxLevel: 1, itemIds: ["producer-1"] },
        ...surplusIds.map((itemId) => ({ id: itemId, complete: true, minLevel: 1, maxLevel: 1, itemIds: [itemId] })),
      ],
      items: [
        { id: "item-1", chainId: "items", level: 1, baseUnits: 1, mergeTarget: "item-2", saleValue: 4 },
        { id: "item-2", chainId: "items", level: 2, baseUnits: 2, mergeTarget: null, saleValue: 10 },
        { id: "producer-1", chainId: "producer", level: 1, baseUnits: 1, mergeTarget: null, saleValue: 5 },
        ...surplusIds.map((itemId) => ({ id: itemId, chainId: itemId, level: 1, baseUnits: 1, mergeTarget: null, saleValue: 1 })),
      ],
      producers: [{
        itemId: "producer-1",
        chainId: "producer",
        level: 1,
        energyCost: 1,
        sampleSize: 1,
        drops: [{ itemId: "item-1", count: 1, probability: 1 }],
      }],
    },
  };
}

test("Legacy Adapter owns state reads and delegates every existing action family", async () => {
  const calls = [];
  const restorations = [];
  const patch = (Type, method, label) => {
    const original = Type.prototype[method];
    Type.prototype[method] = async (...args) => {
      calls.push({ label, args });
      return { ok: true, reason: `${label}-delegated` };
    };
    restorations.push(() => { Type.prototype[method] = original; });
  };
  patch(BoardAutomationRunner, "run", "board");
  patch(OrderSubmitter, "submit", "order");
  patch(SceneNavigator, "go", "navigation");
  patch(MapMissionCompleter, "complete", "map-mission");
  patch(WarehouseActionExecutor, "preflight", "warehouse-preflight");
  patch(WarehouseActionExecutor, "move", "warehouse-store");
  patch(WarehouseActionExecutor, "loadInventory", "warehouse-load");
  patch(WarehouseActionExecutor, "retrieve", "warehouse-retrieve");
  patch(ProductionModeExecutor, "switch", "production-mode");
  patch(SaleActionExecutor, "execute", "sale");

  const adapter = new LegacyRuntimeControlAdapter({
    lab: {
      snapshot: async () => ({}),
      client: {
        evaluate: async () => ({
          ok: true,
          boardVisible: true,
          width: 1,
          height: 1,
          occupied: 0,
          empty: 1,
          signature: "",
          grids: [],
          mergeCandidates: [],
          orders: [],
          producers: [],
          requiredItemCounts: {},
        }),
      },
    },
    selection: { probe: { context: { id: 7 } } },
    collectState: async () => boardState(),
  });

  try {
    assert.equal((await adapter.readState()).schemaVersion, 1);
    await adapter.execute({ type: "run-board-action", producer: 0 });
    await adapter.execute({ type: "submit-order", slot: "order-1" });
    await adapter.execute({ type: "navigate", target: "board" });
    await adapter.execute({ type: "complete-map-mission" });
    await adapter.execute({ type: "preflight-warehouse-store", index: 1 });
    await adapter.execute({ type: "store-to-warehouse", index: 1 });
    await adapter.execute({ type: "load-warehouse-inventory" });
    await adapter.execute({ type: "retrieve-from-warehouse", action: { slotId: "slot-1" }, request: {} });
    await adapter.execute({ type: "switch-production-mode", index: 0, modeId: "mode-2", request: {} });
    await adapter.execute({ type: "sell-item", suggestion: { sourceIndex: 2, itemId: "item-1", expectedCoins: 4 } });

    assert.deepEqual(calls.map((call) => call.label), [
      "board",
      "order",
      "navigation",
      "map-mission",
      "warehouse-preflight",
      "warehouse-store",
      "warehouse-load",
      "warehouse-retrieve",
      "production-mode",
      "sale",
    ]);
  } finally {
    restorations.reverse().forEach((restore) => restore());
  }
});

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

test("standalone map-mission sessions execute through an injected Fake Adapter", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-control-map-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(catalogFixture()), "utf8");
  const runtimeControl = new FakeRuntimeControlAdapter({
    results: [{
      ok: true,
      executed: true,
      reason: "map-mission-completed",
      before: boardState(),
      after: boardState(),
    }],
  });
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    runtimeControl,
  });

  try {
    const result = await runtime.completeCurrentMapMission();

    assert.equal(result.reason, "map-mission-completed");
    assert.deepEqual(runtimeControl.commands, [{ type: "complete-map-mission" }]);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("assisted-sale sessions execute through an injected Fake Adapter", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-control-sale-"));
  fs.writeFileSync(path.join(dataDir, "item-catalog.json"), JSON.stringify(catalogFixture()), "utf8");
  const scenario = assistedSaleScenario();
  const runtimeControl = new FakeRuntimeControlAdapter({
    states: [scenario.state],
    results: [{
      ok: true,
      executed: true,
      reason: "sale-verified",
      before: scenario.state,
      after: { ...scenario.state, resources: { ...scenario.state.resources, coins: 4 } },
      verification: { failures: [] },
    }],
  });
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    runtimeControl,
  });
  runtime.saveSettings({ mode: "assisted" });
  runtime.getPlanningCatalog = () => scenario.catalog;

  try {
    const result = await runtime.executeSaleSuggestion({
      sourceIndex: 2,
      itemId: "item-1",
      expectedCoins: 4,
      confirmed: true,
    });

    assert.equal(result.reason, "sale-verified");
    assert.equal(runtimeControl.commands.length, 1);
    assert.equal(runtimeControl.commands[0].type, "sell-item");
    assert.equal(runtimeControl.commands[0].suggestion.itemId, "item-1");
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
