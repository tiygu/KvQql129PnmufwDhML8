

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { AutomationRuntime } = require("../src/automation-runtime");
const { BoardAutomationRunner } = require("../src/board-runner");
const { OrderSubmitter } = require("../src/order-actions");
const { MapMissionCompleter } = require("../src/map-actions");
const { SceneNavigator } = require("../src/scene-navigation");
const { WarehouseActionExecutor } = require("../src/warehouse-actions");
const { ProductionModeExecutor } = require("../src/production-mode-actions");
const { SaleActionExecutor } = require("../src/sale-actions");
const { FakeRuntimeControlAdapter, LegacyRuntimeControlAdapter, CdpRuntimeControlAdapter } = require("../src/runtime-control-bridge");

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

function normalizedBaseline() {
  return {
    schemaVersion: 1,
    collectedAt: "2026-07-23T00:00:00.000Z",
    scene: "board",
    resources: { coins: 12, diamonds: 3, energy: 8 },
    energy: {
      amount: 8,
      limit: 20,
      recoverIntervalSeconds: 60,
      recoverTimestamp: 1234,
      recovering: true,
    },
    board: {
      available: true,
      visible: true,
      width: 2,
      height: 2,
      occupied: 1,
      empty: 3,
      signature: "item-1|||",
      grids: [{ index: 0, itemId: "item-1", empty: false, normal: true, moveable: true }],
      mergeCandidates: [],
      requiredItemCounts: { "item-1": 1 },
    },
    orders: [{
      slot: "order-1",
      taskId: 101,
      rewardCoins: 9,
      items: [{ itemId: "item-1", complete: false, status: 0 }],
      requiredItemIds: ["item-1"],
      missingItemIds: ["item-1"],
      ready: false,
    }],
    producers: [],
    warehouse: { inventoryKnowledge: { status: "unknown" } },
    mapProgress: {
      currentTask: null,
      currentSeason: null,
      seasonDisplay: null,
      allFinished: false,
      episodeFinished: false,
    },
    mapMission: null,
    overlays: [],
    selectedItem: null,
    source: { adapter: "semantic-runtime", engine: "cocos" },
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

// --- Semantic bridge order submission tests ---

function orderSubmissionRuntimeFixture() {
  const task = {
    taskId: 101,
    itemInfos: [
      { itemId: "item-1", isComplete: true, status: 1 },
      { itemId: "item-2", isComplete: true, status: 1 },
    ],
    rewards: [{ type: 1, count: 10 }],
    _inSubmit: false,
  };
  const buttonView = { submitTask() { this._submitted = true; }, _submitted: false };
  const taskItemMap = new Map([["order-1", buttonView]]);
  const taskView = {
    _taskItemDataMap: new Map([["order-1", { task }]]),
    childViews: [{ type: 6, taskItemMap }],
  };
  const grid = {
    index: 0,
    itemId: "item-1",
    item: { itemConfig: {} },
    isEmpty: false,
    isNormal: true,
    isMoveable: true,
    isLocking: false,
    isFrozen: false,
    center: { x: 100, y: 100 },
  };
  const gameBoard = {
    size: { width: 1, height: 1 },
    __private_95_grids: [grid],
  };
  const boardController = {
    _controllerClazzName: "UserBoardViewController",
    isViewVisible: true,
    view: {
      _boardView: {
        _gameBoardView: {
          _boardStore: { _state: { _gameBoard: gameBoard } },
          canBoardGridBeDragging: () => true,
          isBoardGridItemAnimating: () => false,
          _operatorCenter: { itemCanMergeWith: () => false },
          onTouch: () => {},
          onDragStart: () => {},
          onDragMove: () => {},
          onDragEnd: () => {},
        },
        _taskView: taskView,
      },
    },
  };
  const resourceMap = new Map([[1, 50], [2, 5], [3, 10]]);
  const runtime = {
    mControllers: [boardController],
    mManagers: [
      { _resourceMap: resourceMap },
      { _energyDataMap: new Map([[3, { _energyLimit: 20, _recoverInterval: 60, recoverTimestamp: 1234, inRecover: false }]]) },
      { clientTaskDataMap: new Map([["orders", new Map([["order-1", task]])]]) },
    ],
  };
  const scene = {
    name: "main",
    getChildByName: (name) => name === "Entry" ? { _components: [runtime] } : null,
    children: [],
  };
  const sandbox = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  sandbox.globalThis = sandbox;
  return { sandbox, runtime, boardController, taskView, task, buttonView, gameBoard, grid, resourceMap, scene };
}

function installOrderSubmissionBridge(fixture, contextGeneration = "7") {
  const { sandbox } = fixture;
  const { buildBridgeInstallExpression } = require("../src/runtime-control-bridge");
  const expression = buildBridgeInstallExpression(contextGeneration);
  return vm.runInContext(expression, sandbox);
}

test("injected bridge detects orderSubmission capability when task view and submit handler are present", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  const result = installOrderSubmissionBridge(fixture);

  assert.equal(result.handshake.capabilities.orderSubmission, true);
  assert.equal(result.handshake.capabilities.baseline, true);
});

test("injected bridge submit-order dispatches a ready order and returns accepted-changed", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-1",
    expectedRevision: 0,
    method: "submit-order",
    slot: "order-1",
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.outcome, "accepted-changed");
  assert.equal(ack.reason, "order-submit-dispatched");
  assert.equal(ack.changed, true);
  assert.equal(ack.delta.order.slot, "order-1");
  assert.equal(ack.delta.order.previousTaskId, 101);
  assert.equal(ack.delta.order.dispatched, true);
  assert.equal(ack.delta.preCoins, 50);
  assert.equal(fixture.buttonView._submitted, true);
});

test("injected bridge submit-order rejects an incomplete order", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  fixture.task.itemInfos[0].isComplete = false;
  installOrderSubmissionBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-2",
    expectedRevision: 0,
    method: "submit-order",
    slot: "order-1",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "rejected-precondition");
  assert.equal(ack.reason, "order-not-ready");
});

test("injected bridge submit-order rejects an already-submitting order", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  fixture.task._inSubmit = true;
  installOrderSubmissionBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-3",
    expectedRevision: 0,
    method: "submit-order",
    slot: "order-1",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "rejected-precondition");
  assert.equal(ack.reason, "order-already-submitting");
});

test("injected bridge submit-order rejects a slot that does not exist", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-4",
    expectedRevision: 0,
    method: "submit-order",
    slot: "nonexistent",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "rejected-precondition");
  assert.equal(ack.reason, "order-slot-not-found");
});

test("injected bridge submit-order rejects when expected task identity changed", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-5",
    expectedRevision: 0,
    method: "submit-order",
    slot: "order-1",
    expectedTaskId: "999",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "rejected-precondition");
  assert.equal(ack.reason, "order-task-changed");
});

test("injected bridge submit-order handles expectedTaskId match", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-5b",
    expectedRevision: 0,
    method: "submit-order",
    slot: "order-1",
    expectedTaskId: "101",
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.outcome, "accepted-changed");
});

test("injected bridge submit-order is idempotent for duplicate operation IDs", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture);

  const first = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-dup",
    expectedRevision: 0,
    method: "submit-order",
    slot: "order-1",
  });

  // Reset submitted flag to verify the second call does NOT re-invoke submitTask
  fixture.buttonView._submitted = false;

  const second = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-dup",
    expectedRevision: 0,
    method: "submit-order",
    slot: "order-1",
  });

  assert.deepEqual(second, first);
  assert.equal(fixture.buttonView._submitted, false);
});

test("injected bridge submit-order rejects stale revision", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-6",
    expectedRevision: 5,
    method: "submit-order",
    slot: "order-1",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "stale-revision");
  assert.equal(ack.reason, "runtime-revision-stale");
});

test("injected bridge submit-order returns unsupported-capability when submit handler is absent at execution time", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  // Install with handler present so capability is detected
  installOrderSubmissionBridge(fixture);

  // Now remove the submit handler after install
  fixture.taskView.childViews = [];

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "op-7",
    expectedRevision: 0,
    method: "submit-order",
    slot: "order-1",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "unsupported-capability");
  assert.equal(ack.reason, "order-submit-handler-not-found");
});

test("injected bridge readOrderSlot returns current order and coin state", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture);

  const slot = await fixture.sandbox.globalThis.miniGameCtl.readOrderSlot("order-1");

  assert.equal(slot.ok, true);
  assert.equal(slot.slot, "order-1");
  assert.equal(slot.occupied, true);
  assert.equal(slot.taskId, 101);
  assert.equal(slot.ready, true);
  assert.equal(slot.inSubmit, false);
  assert.equal(slot.coins, 50);
  assert.equal(slot.items.length, 2);
  assert.equal(slot.items[0].itemId, "item-1");
  assert.equal(slot.items[0].complete, true);
});

test("injected bridge readOrderSlot returns not-occupied for a missing slot", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture);

  const slot = await fixture.sandbox.globalThis.miniGameCtl.readOrderSlot("nonexistent");

  assert.equal(slot.ok, true);
  assert.equal(slot.occupied, false);
  assert.equal(slot.taskId, null);
  assert.equal(slot.ready, false);
});

// --- CdpRuntimeControlAdapter order submission tests ---

test("CDP Adapter submits a ready order through the semantic bridge and returns invariant-complete success", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture, "7");

  // Simulate: submitTask also updates state (like the real game server response)
  const origSubmit = fixture.buttonView.submitTask;
  fixture.buttonView.submitTask = function () {
    origSubmit.call(this);
    // Simulate order replacement and coin reward
    fixture.taskView._taskItemDataMap.delete("order-1");
    const newTask = {
      taskId: 202,
      itemInfos: [{ itemId: "item-3", isComplete: false, status: 0 }],
      rewards: [{ type: 1, count: 15 }],
    };
    fixture.taskView._taskItemDataMap.set("order-1", { task: newTask });
    fixture.resourceMap.set(1, 60);
  };

  let legacyCalled = false;
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression, _contextId) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => {
        legacyCalled = true;
        return normalizedBaseline();
      },
      execute: async () => {
        legacyCalled = true;
        return { ok: true, reason: "legacy-action" };
      },
    },
  });

  await adapter.ready();
  // reset — legacy.readState is called during install for baseline reconciliation
  legacyCalled = false;
  const result = await adapter.execute(
    { type: "submit-order", slot: "order-1", before: { orders: [{ slot: "order-1", taskId: 101 }] } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "order-submitted-and-coins-received");
  assert.equal(result.actions[0].type, "submit-order");
  assert.equal(result.actions[0].orderReplaced, true);
  assert.equal(result.actions[0].coinsChanged, true);
  assert.equal(result.actions[0].previousTaskId, 101);
  assert.equal(result.actions[0].coinsBefore, 50);
  assert.equal(result.actions[0].coinsAfter, 60);
  assert.equal(legacyCalled, false);
});

test("CDP Adapter reports order-replaced-but-coins-not-observed when coins unchanged", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture, "7");

  // Simulate: submitTask replaces order but does NOT reward coins
  const origSubmit = fixture.buttonView.submitTask;
  fixture.buttonView.submitTask = function () {
    origSubmit.call(this);
    fixture.taskView._taskItemDataMap.delete("order-1");
    const newTask = {
      taskId: 202,
      itemInfos: [{ itemId: "item-3", isComplete: false, status: 0 }],
    };
    fixture.taskView._taskItemDataMap.set("order-1", { task: newTask });
    // Coins unchanged at 50
  };

  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  const result = await adapter.execute(
    { type: "submit-order", slot: "order-1", before: { orders: [{ slot: "order-1", taskId: 101 }] } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "order-replaced-but-coins-not-observed");
  assert.equal(result.actions[0].orderReplaced, true);
  assert.equal(result.actions[0].coinsChanged, false);
  assert.equal(result.actions[0].coinsAfter, 50);
});

test("CDP Adapter pauses with uncertainty when order slot is not yet replaced after dispatch", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture, "7");

  // After submit: order slot still occupied with same task (not yet replaced)
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  const result = await adapter.execute(
    { type: "submit-order", slot: "order-1", before: { orders: [{ slot: "order-1", taskId: 101 }] } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.executed, true);
  assert.equal(result.pauseRequested, true);
  assert.equal(result.reason, "order-submission-awaiting-replacement");
  assert.equal(result.uncertainAction.type, "submit-order");
  assert.equal(result.uncertainAction.slot, "order-1");
});

test("CDP Adapter rejects an incomplete order through the semantic bridge", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  fixture.task.itemInfos[0].isComplete = false;
  installOrderSubmissionBridge(fixture, "7");

  let legacyCalled = false;
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => { legacyCalled = true; return { ok: true }; },
    },
  });

  await adapter.ready();
  legacyCalled = false; // reset — legacy.readState is called during install
  const result = await adapter.execute(
    { type: "submit-order", slot: "order-1", before: { orders: [{ slot: "order-1", taskId: 101 }] } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "order-not-ready");
  assert.equal(legacyCalled, false);
});

test("CDP Adapter rejects an already-submitting order through the semantic bridge", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  fixture.task._inSubmit = true;
  installOrderSubmissionBridge(fixture, "7");

  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  const result = await adapter.execute(
    { type: "submit-order", slot: "order-1", before: { orders: [{ slot: "order-1", taskId: 101 }] } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "order-already-submitting");
});

test("CDP Adapter requests replan on stale revision for order submission", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture, "7");

  let legacyReads = 0;
  const baseline = normalizedBaseline();
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => {
        legacyReads += 1;
        return baseline;
      },
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  const result = await adapter.execute(
    { type: "submit-order", slot: "order-1", expectedRevision: 99, before: { orders: [{ slot: "order-1", taskId: 101 }] } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.replanRequested, true);
  assert.equal(result.reason, "runtime-revision-stale");
});

test("CDP Adapter falls back to legacy when orderSubmission capability is absent", async () => {
  // Use a bridge without order submission capability
  const fixture = orderSubmissionRuntimeFixture();
  fixture.taskView.childViews = []; // removes submit handler
  installOrderSubmissionBridge(fixture, "7");

  let legacyCalled = false;
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => {
        legacyCalled = true;
        return { ok: true, executed: true, reason: "order-submitted-legacy" };
      },
    },
  });

  await adapter.ready();
  // Force capabilities to be read from handshake (orderSubmission: false)
  await adapter.execute(
    { type: "submit-order", slot: "order-1" },
  );

  assert.equal(legacyCalled, true);
});

// --- Semantic bridge navigation tests ---

function navigationRuntimeFixture(scene = "map") {
  const boardVisible = scene === "board";
  const mapController = {
    _controllerClazzName: "FieldMapMainViewController",
    isViewVisible: !boardVisible,
  };
  const boardController = {
    _controllerClazzName: "UserBoardViewController",
    isViewVisible: boardVisible,
    view: {
      _boardView: {
        onMapButtonClick() { this._mapClicked = true; },
        _gameBoardView: {
          _boardStore: { _state: { _gameBoard: { size: { width: 2, height: 2 }, __private_95_grids: [] } } },
          canBoardGridBeDragging: () => false,
          isBoardGridItemAnimating: () => false,
          _operatorCenter: { itemCanMergeWith: () => false },
          onTouch: () => {},
          onDragStart: () => {},
          onDragMove: () => {},
          onDragEnd: () => {},
        },
      },
    },
  };
  const entranceController = {
    _controllerClazzName: "EntranceViewController",
    isViewVisible: !boardVisible,
    view: {
      onBoardClick() { this._boardClicked = true; },
    },
  };
  const missionController = {
    _controllerClazzName: "AreaMissionInfoViewController",
    isViewVisible: false,
    hideByCloseBtn() { this.isViewVisible = false; this._closed = true; },
  };
  const runtime = {
    mControllers: [mapController, boardController, entranceController, missionController],
    mManagers: [
      { _resourceMap: new Map([[1, 50], [2, 5], [3, 10]]) },
      { _energyDataMap: new Map([[3, { _energyLimit: 20, _recoverInterval: 60, recoverTimestamp: null, inRecover: false }]]) },
      { clientTaskDataMap: new Map() },
    ],
  };
  const gameScene = {
    name: "main",
    getChildByName: (name) => name === "Entry" ? { _components: [runtime] } : null,
    children: [],
  };
  const sandbox = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => gameScene } },
  });
  sandbox.globalThis = sandbox;
  return { sandbox, runtime, mapController, boardController, entranceController, missionController, gameScene };
}

function installNavigationBridge(fixture, contextGeneration = "7") {
  const { sandbox } = fixture;
  const { buildBridgeInstallExpression } = require("../src/runtime-control-bridge");
  const expression = buildBridgeInstallExpression(contextGeneration);
  return vm.runInContext(expression, sandbox);
}

test("injected bridge detects navigation capability when both directions are available", async () => {
  const fixture = navigationRuntimeFixture("map");
  const result = installNavigationBridge(fixture);

  assert.equal(result.handshake.capabilities.navigation, true);
  assert.equal(result.handshake.capabilities.baseline, true);
});

test("injected bridge detects navigation capability unavailable when map button is missing", async () => {
  const fixture = navigationRuntimeFixture("map");
  // Remove the map button handler
  fixture.boardController.view._boardView.onMapButtonClick = undefined;
  const result = installNavigationBridge(fixture);

  assert.equal(result.handshake.capabilities.navigation, false);
});

test("injected bridge detects navigation capability unavailable when entrance is missing", async () => {
  const fixture = navigationRuntimeFixture("map");
  // Remove the entrance onBoardClick handler
  fixture.entranceController.view.onBoardClick = undefined;
  const result = installNavigationBridge(fixture);

  assert.equal(result.handshake.capabilities.navigation, false);
});

test("injected bridge navigate to board returns accepted-changed when entrance is visible", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture);

  // Verify starting state
  const before = fixture.sandbox.globalThis.miniGameCtl.readGameplayArea();
  assert.equal(before.scene, "map");
  assert.equal(before.boardVisible, false);
  assert.equal(before.entranceVisible, true);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-1",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.method, "navigate");
  // The bridge dispatches synchronously; arrival depends on scene transition timing
  assert.equal(fixture.entranceController.view._boardClicked, true);
});

test("injected bridge navigate to map returns accepted-changed when board is visible", async () => {
  const fixture = navigationRuntimeFixture("board");
  installNavigationBridge(fixture);

  const before = fixture.sandbox.globalThis.miniGameCtl.readGameplayArea();
  assert.equal(before.scene, "board");
  assert.equal(before.boardVisible, true);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-2",
    expectedRevision: 0,
    method: "navigate",
    target: "map",
  });

  assert.equal(ack.ok, true);
  assert.equal(fixture.boardController.view._boardView._mapClicked, true);
});

test("injected bridge navigate returns accepted-unchanged when already at target", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-already",
    expectedRevision: 0,
    method: "navigate",
    target: "map",
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.outcome, "accepted-unchanged");
  assert.equal(ack.reason, "navigation-already-there");
  assert.equal(ack.changed, false);
});

test("injected bridge navigate to board closes map mission overlay before navigation", async () => {
  const fixture = navigationRuntimeFixture("map");
  fixture.missionController.isViewVisible = true; // overlay is open
  installNavigationBridge(fixture);

  const before = fixture.sandbox.globalThis.miniGameCtl.readGameplayArea();
  assert.equal(before.missionVisible, true);

  await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-overlay",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
  });

  assert.equal(fixture.missionController._closed, true);
  assert.equal(fixture.missionController.isViewVisible, false);
  assert.equal(fixture.entranceController.view._boardClicked, true);
});

test("injected bridge navigate to board rejects when entrance is not visible", async () => {
  const fixture = navigationRuntimeFixture("map");
  fixture.entranceController.isViewVisible = false;
  installNavigationBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-no-ent",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "rejected-precondition");
  assert.equal(ack.reason, "navigation-entrance-not-visible");
});

test("injected bridge navigate to board rejects when entrance handler missing at execution time", async () => {
  const fixture = navigationRuntimeFixture("map");
  // Install with handler present so navigation capability is detected
  installNavigationBridge(fixture);
  // Then remove the handler after install — same pattern as order submission test
  fixture.entranceController.view.onBoardClick = undefined;

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-no-handler",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "unsupported-capability");
  assert.equal(ack.reason, "navigation-board-entrance-missing");
});

test("injected bridge navigate to map rejects when board is not visible", async () => {
  const fixture = navigationRuntimeFixture("map");
  // Board not visible when on map; try to navigate to map from map is already-there,
  // but the entrance to map from board path requires board visible.
  // Create a scenario where we're somehow between scenes
  fixture.boardController.isViewVisible = false;
  fixture.mapController.isViewVisible = false; // neither visible
  installNavigationBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-no-board",
    expectedRevision: 0,
    method: "navigate",
    target: "map",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "rejected-precondition");
  assert.equal(ack.reason, "navigation-board-not-visible");
});

test("injected bridge navigate rejects stale revision", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-stale",
    expectedRevision: 99,
    method: "navigate",
    target: "board",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "stale-revision");
  assert.equal(ack.reason, "runtime-revision-stale");
});

test("injected bridge navigate is idempotent for duplicate operation IDs", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture);

  const first = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-dup",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
  });

  // Reset clicked flag
  fixture.entranceController.view._boardClicked = false;

  const second = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-dup",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
  });

  assert.deepEqual(second, first);
  assert.equal(fixture.entranceController.view._boardClicked, false);
});

test("injected bridge readGameplayArea returns current scene state with revision", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture);

  const area = fixture.sandbox.globalThis.miniGameCtl.readGameplayArea();

  assert.equal(area.scene, "map");
  assert.equal(area.boardVisible, false);
  assert.equal(area.mapVisible, true);
  assert.equal(area.entranceVisible, true);
  assert.equal(area.missionVisible, false);
  assert.equal(area.revision, 0);
});

test("injected bridge navigation invalidates merge caches", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture);

  // Drain any existing events
  fixture.sandbox.globalThis.miniGameCtl.drainEventQueue(0);

  await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-cache",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
  });

  // Check that a cache-invalidated event was published
  const events = fixture.sandbox.globalThis.miniGameCtl.drainEventQueue(0);
  const cacheEvents = events.filter((e) => e.eventType === "cache-invalidated");
  assert.ok(cacheEvents.length >= 1, "expected at least one cache-invalidated event after navigation");
});

// --- CdpRuntimeControlAdapter navigation tests ---

test("CDP Adapter navigates to board through the semantic bridge and returns verified success", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture, "7");

  // Simulate: onBoardClick also transitions scene state to board-visible
  const origBoardClick = fixture.entranceController.view.onBoardClick;
  fixture.entranceController.view.onBoardClick = function () {
    origBoardClick.call(this);
    fixture.boardController.isViewVisible = true;
    fixture.mapController.isViewVisible = false;
    fixture.entranceController.isViewVisible = false;
  };

  let legacyCalled = false;
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => {
        legacyCalled = true;
        return normalizedBaseline();
      },
      execute: async () => {
        legacyCalled = true;
        return { ok: true, reason: "legacy-navigation" };
      },
    },
  });

  await adapter.ready();
  legacyCalled = false; // reset after install
  const result = await adapter.execute({ type: "navigate", target: "board" });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "navigation-verified");
  assert.equal(result.actions[0].type, "navigate");
  assert.equal(result.actions[0].target, "board");
  assert.equal(result.actions[0].verified, true);
  assert.equal(legacyCalled, false);
});

test("CDP Adapter navigates to map through the semantic bridge and returns verified success", async () => {
  const fixture = navigationRuntimeFixture("board");
  installNavigationBridge(fixture, "7");

  // Simulate: onMapButtonClick transitions to map scene
  const origMapClick = fixture.boardController.view._boardView.onMapButtonClick;
  fixture.boardController.view._boardView.onMapButtonClick = function () {
    origMapClick.call(this);
    fixture.boardController.isViewVisible = false;
    fixture.mapController.isViewVisible = true;
    fixture.entranceController.isViewVisible = true;
  };

  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  const result = await adapter.execute({ type: "navigate", target: "map" });

  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "navigation-verified");
  assert.equal(result.actions[0].target, "map");
});

test("CDP Adapter returns already-there when navigation target is the active area", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture, "7");

  let legacyCalled = false;
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => { legacyCalled = true; return { ok: true }; },
    },
  });

  await adapter.ready();
  legacyCalled = false;
  const result = await adapter.execute({ type: "navigate", target: "map" });

  assert.equal(result.ok, true);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "navigation-already-there");
  assert.equal(result.navigation.alreadyThere, true);
  assert.equal(legacyCalled, false);
  assert.equal(adapter.status().diagnostics.confirmationPaths.delta, 1);
  assert.equal(adapter.status().diagnostics.confirmationLatencyMs.count, 1);
});

test("CDP Adapter requests replan on stale revision for navigation", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture, "7");

  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  const result = await adapter.execute(
    { type: "navigate", target: "board", expectedRevision: 99 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.replanRequested, true);
  assert.equal(result.reason, "runtime-revision-stale");
});

test("CDP Adapter verifies navigation with targeted gameplay-area reads across multiple attempts", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture, "7");

  // Simulate a slow scene transition: board becomes visible after a few reads
  let reads = 0;
  const origBoardClick = fixture.entranceController.view.onBoardClick;
  fixture.entranceController.view.onBoardClick = function () {
    origBoardClick.call(this);
    // Scene transition takes a few reads to complete
  };

  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => {
        if (expression.includes("readGameplayArea")) {
          reads += 1;
          // Transition completes after 3 reads
          if (reads >= 3) {
            fixture.boardController.isViewVisible = true;
            fixture.mapController.isViewVisible = false;
            fixture.entranceController.isViewVisible = false;
          }
        }
        return vm.runInContext(expression, fixture.sandbox);
      },
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  const result = await adapter.execute({ type: "navigate", target: "board" });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "navigation-verified");
  assert.ok(reads >= 3, `expected at least 3 gameplay reads but got ${reads}`);
});

test("CDP Adapter reports navigation-not-observed when target not reached after verification attempts", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture, "7");

  // onBoardClick does NOT change scene — navigation never completes
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  const result = await adapter.execute({ type: "navigate", target: "board" });

  assert.equal(result.ok, false);
  assert.equal(result.executed, true);
  assert.equal(result.reason, "navigation-not-observed");
});

test("CDP Adapter falls back to legacy when navigation capability is absent", async () => {
  const fixture = navigationRuntimeFixture("map");
  // Remove map button so navigation capability is false
  fixture.boardController.view._boardView.onMapButtonClick = undefined;
  installNavigationBridge(fixture, "7");

  let legacyCalled = false;
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, fixture.sandbox),
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => {
        legacyCalled = true;
        return { ok: true, executed: true, reason: "legacy-navigation" };
      },
    },
  });

  await adapter.ready();
  await adapter.execute({ type: "navigate", target: "board" });

  assert.equal(legacyCalled, true);
});

test("injected bridge navigate rejects invalid target", async () => {
  const fixture = navigationRuntimeFixture("map");
  installNavigationBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "nav-bad",
    expectedRevision: 0,
    method: "navigate",
    target: "warehouse",
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "rejected-precondition");
  assert.equal(ack.reason, "navigation-target-invalid");
});

test("CDP Adapter duplicate operation IDs are blocked by the injected bridge", async () => {
  const fixture = orderSubmissionRuntimeFixture();
  installOrderSubmissionBridge(fixture, "7");

  // Simulate submitTask updates state (order replaced, coins changed)
  const origSubmit = fixture.buttonView.submitTask;
  fixture.buttonView.submitTask = function () {
    origSubmit.call(this);
    fixture.taskView._taskItemDataMap.delete("order-1");
    const newTask = {
      taskId: 202,
      itemInfos: [{ itemId: "item-3", isComplete: false, status: 0 }],
    };
    fixture.taskView._taskItemDataMap.set("order-1", { task: newTask });
    fixture.resourceMap.set(1, 60);
  };

  const evaluations = [];
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => {
        evaluations.push(expression);
        return vm.runInContext(expression, fixture.sandbox);
      },
    },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp" }),
      readState: async () => normalizedBaseline(),
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();

  // First call — should go through
  const first = await adapter.execute(
    { type: "submit-order", slot: "order-1", operationId: "dup-op-order", before: { orders: [{ slot: "order-1", taskId: 101 }] } },
  );
  assert.equal(first.ok, true);

  // Second call with same operationId — bridge returns cached ack
  // The targeted read will still succeed (order was already replaced on first call)
  const second = await adapter.execute(
    { type: "submit-order", slot: "order-1", operationId: "dup-op-order", before: { orders: [{ slot: "order-1", taskId: 101 }] } },
  );
  assert.equal(second.ok, true);
  // Verify both results are the same (idempotent)
  assert.equal(second.reason, first.reason);
});
