

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AutomationRuntime } = require("../src/automation-runtime");
const {
  CdpRuntimeControlAdapter,
  RUNTIME_CONTROL_PROTOCOL_VERSION,
} = require("../src/runtime-control-bridge");

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

function healthyHandshake(overrides = {}) {
  return {
    protocolVersion: RUNTIME_CONTROL_PROTOCOL_VERSION,
    bridgeVersion: "1.0.0",
    gameFingerprint: "cocos:main:target-game",
    contextGeneration: "7",
    revision: 0,
    capabilities: {
      baseline: true,
      boardRead: true,
      resourceRead: true,
      energyRead: true,
      orderRead: true,
      merge: false,
      production: false,
      orderSubmission: false,
      navigation: false,
    },
    ...overrides,
  };
}

test("CDP Adapter installs once in the selected context and reuses a healthy bridge baseline", async () => {
  const evaluations = [];
  const baseline = normalizedBaseline();
  const reconciled = normalizedBaseline();
  reconciled.mapProgress.currentTask = 55;
  let legacyReads = 0;
  const client = {
    evaluate: async (expression, contextId) => {
      evaluations.push({ expression, contextId });
      return { handshake: healthyHandshake(), baseline };
    },
  };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp" }),
    readState: async () => {
      legacyReads += 1;
      return reconciled;
    },
    execute: async () => ({ ok: true, reason: "legacy-action" }),
  };
  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });

  const first = await adapter.ready();
  const second = await adapter.ready();
  const state = await adapter.readState();

  assert.equal(evaluations.length, 1);
  assert.equal(legacyReads, 1);
  assert.equal(evaluations[0].contextId, 7);
  assert.match(evaluations[0].expression, /miniGameCtl/);
  assert.equal(first.adapterId, "semantic-cdp");
  assert.deepEqual(second, first);
  assert.deepEqual(state.resources, baseline.resources);
  assert.deepEqual(state.board, baseline.board);
  assert.deepEqual(state.orders, baseline.orders);
  assert.equal(state.mapProgress.currentTask, 55);
  assert.deepEqual(adapter.status(), {
    adapterId: "semantic-cdp",
    ready: true,
    protocolVersion: RUNTIME_CONTROL_PROTOCOL_VERSION,
    bridgeVersion: "1.0.0",
    gameFingerprint: "cocos:main:target-game",
    contextGeneration: "7",
    revision: 0,
    capabilities: healthyHandshake().capabilities,
    fallback: { active: false, reason: null },
    eventBinding: { active: false, appliedRevision: -1 },
    buttonFallback: {
      usageCount: 0,
      resolutions: { "component-handler": 0, "node-event": 0, "coordinate-input": 0 },
    },
  });
});

test("CDP Adapter coalesces concurrent readiness calls for one context generation", async () => {
  const releases = [];
  let evaluations = 0;
  const client = {
    evaluate: async () => {
      evaluations += 1;
      return new Promise((resolve) => {
        releases.push(() => resolve({ handshake: healthyHandshake(), baseline: normalizedBaseline() }));
      });
    },
  };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp" }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };
  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });

  const first = adapter.ready();
  const second = adapter.ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluations, 1);
  releases.forEach((release) => release());

  assert.deepEqual(await first, await second);
  assert.equal(evaluations, 1);
});

test("CDP Adapter discards its handshake baseline before a Legacy mutation", async () => {
  const before = normalizedBaseline();
  const after = normalizedBaseline();
  after.resources.energy = 7;
  after.energy.amount = 7;
  let legacyReads = 0;
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp" }),
    readState: async () => {
      legacyReads += 1;
      return legacyReads === 1 ? before : after;
    },
    execute: async () => ({ ok: true, reason: "legacy-action" }),
  };
  const adapter = new CdpRuntimeControlAdapter({
    client: { evaluate: async () => ({ handshake: healthyHandshake(), baseline: before }) },
    contextId: 7,
    legacy,
  });

  await adapter.ready();
  await adapter.execute({ type: "run-board-action" });
  const state = await adapter.readState();

  assert.equal(state.resources.energy, 7);
  assert.equal(legacyReads, 2);
});

test("CDP Adapter reports Legacy readiness after a healthy bridge later degrades", async () => {
  let evaluations = 0;
  const legacyState = normalizedBaseline();
  const legacyReadiness = { adapterId: "legacy-cdp", contextId: 7 };
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async () => {
        evaluations += 1;
        if (evaluations === 1) return { handshake: healthyHandshake(), baseline: normalizedBaseline() };
        throw new Error("bridge baseline failed");
      },
    },
    contextId: 7,
    legacy: {
      ready: async () => legacyReadiness,
      readState: async () => legacyState,
      execute: async () => ({ ok: true }),
    },
  });

  await adapter.ready();
  await adapter.readState();
  assert.deepEqual(await adapter.readState(), legacyState);

  assert.deepEqual(await adapter.ready(), legacyReadiness);
  assert.equal(adapter.status().ready, false);
  assert.equal(adapter.status().fallback.active, true);
});

test("CDP Adapter negotiates a bounded normalized baseline from the injected runtime bridge", async () => {
  const item = {
    taskNeed: false,
    itemConfig: { Level: 1, MergeTarget: null, EnergyCost: 0, Price: 2 },
  };
  const grid = {
    index: 0,
    itemId: "item-1",
    item,
    isEmpty: false,
    isNormal: true,
    isMoveable: true,
    isLocking: false,
    isFrozen: false,
  };
  const producerGrid = {
    index: 1,
    itemId: "producer-1",
    item: {
      produceCount: 5,
      itemConfig: { Level: 1, MergeTarget: null, EnergyCost: 1, Price: 0, CreateData: ["item-1"] },
    },
    isEmpty: false,
    isNormal: true,
    isMoveable: true,
    isLocking: false,
    isFrozen: false,
  };
  const gameBoard = {
    size: { width: 2, height: 2 },
    __private_95_grids: [grid, producerGrid],
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
          _dragHandler: { predictDragResult: () => null },
        },
      },
    },
  };
  const task = {
    taskId: 101,
    itemInfos: [{ itemId: "item-1", isComplete: false, status: 0 }],
    rewards: [{ type: 1, count: 9 }],
  };
  const runtime = {
    mControllers: [boardController],
    mManagers: [
      { _resourceMap: new Map([[1, 12], [2, 3], [3, 8]]) },
      { _energyDataMap: new Map([[3, { _energyLimit: 20, _recoverInterval: 60, recoverTimestamp: 1234, inRecover: true }]]) },
      { clientTaskDataMap: new Map([["orders", new Map([["order-1", task]])]]) },
      { _multipleModeMap: new Map([["producer-1", "double"]]), _isOpenedFourfoldMode: true },
    ],
  };
  const scene = {
    name: "main",
    getChildByName: (name) => name === "Entry" ? { _components: [runtime] } : null,
    children: [],
  };
  const context = vm.createContext({
    globalThis: null,
    cc: {
      ENGINE_VERSION: "3.8.0",
      director: { getScene: () => scene },
    },
  });
  context.globalThis = context;
  let evaluateCount = 0;
  const client = {
    evaluate: async (expression, contextId) => {
      evaluateCount += 1;
      assert.equal(contextId, 7);
      return vm.runInContext(expression, context);
    },
  };
  const legacy = {
    ready: async () => ({ adapterId: "legacy-cdp" }),
    readState: async () => normalizedBaseline(),
    execute: async () => ({ ok: true }),
  };
  const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });

  const readiness = await adapter.ready();
  const baseline = await adapter.readState();

  assert.equal(
    readiness.gameFingerprint,
    "target-game:cocos:3.8.0:controllers=UserBoardViewController;managers=energy,modes,resources,tasks",
  );
  assert.equal(baseline.resources.energy, 8);
  assert.equal(baseline.energy.limit, 20);
  assert.equal(baseline.board.signature, "item-1|producer-1");
  assert.equal(baseline.orders[0].slot, "order-1");
  assert.equal(baseline.orders[0].rewardCoins, 9);
  assert.equal(baseline.producers[0].currentProductionModeId, "double");
  assert.deepEqual(
    baseline.producers[0].availableProductionModes.map((mode) => mode.modeId),
    ["single", "double", "quad"],
  );
  assert.equal(JSON.stringify(baseline).includes("mControllers"), false);
  assert.equal(evaluateCount, 1);
});

test("CDP Adapter falls back when required baseline resolvers are absent", async () => {
  const runtime = { mControllers: [], mManagers: [] };
  const scene = {
    name: "main",
    getChildByName: (name) => name === "Entry" ? { _components: [runtime] } : null,
    children: [],
  };
  const context = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  context.globalThis = context;
  const legacyState = normalizedBaseline();
  let legacyReads = 0;
  const adapter = new CdpRuntimeControlAdapter({
    client: { evaluate: async (expression) => vm.runInContext(expression, context) },
    contextId: 7,
    legacy: {
      ready: async () => ({ adapterId: "legacy-cdp", contextId: 7 }),
      readState: async () => {
        legacyReads += 1;
        return legacyState;
      },
      execute: async () => ({ ok: true }),
    },
  });

  const readiness = await adapter.ready();
  const state = await adapter.readState();

  assert.equal(readiness.adapterId, "legacy-cdp");
  assert.deepEqual(state, legacyState);
  assert.equal(legacyReads, 1);
  assert.equal(adapter.status().fallback.active, true);
});

for (const scenario of [
  {
    name: "incompatible protocol",
    response: { handshake: healthyHandshake({ protocolVersion: 99 }), baseline: normalizedBaseline() },
    reason: "RUNTIME_CONTROL_PROTOCOL_INCOMPATIBLE",
  },
  {
    name: "malformed handshake scalar types",
    response: {
      handshake: healthyHandshake({ protocolVersion: "1", revision: "0" }),
      baseline: normalizedBaseline(),
    },
    reason: "RUNTIME_CONTROL_HANDSHAKE_INVALID",
  },
  {
    name: "wrong execution context",
    response: { handshake: healthyHandshake({ contextGeneration: "8" }), baseline: normalizedBaseline() },
    reason: "RUNTIME_CONTROL_CONTEXT_MISMATCH",
  },
  {
    name: "incomplete independent capabilities",
    response: {
      handshake: healthyHandshake({
        capabilities: { ...healthyHandshake().capabilities, orderRead: false },
      }),
      baseline: normalizedBaseline(),
    },
    reason: "RUNTIME_CONTROL_HANDSHAKE_INVALID",
  },
  {
    name: "invalid baseline",
    response: { handshake: healthyHandshake(), baseline: { schemaVersion: 1, resources: {} } },
    reason: "RUNTIME_CONTROL_BASELINE_INVALID",
  },
  {
    name: "shape-valid but incomplete baseline",
    response: {
      handshake: healthyHandshake(),
      baseline: { ...normalizedBaseline(), resources: [] },
    },
    reason: "RUNTIME_CONTROL_BASELINE_INVALID",
  },
]) {
  test(`CDP Adapter keeps the Legacy Adapter usable after ${scenario.name}`, async () => {
    const calls = { evaluate: 0, legacyReady: 0, legacyRead: 0, legacyExecute: 0 };
    const legacyState = normalizedBaseline();
    const legacy = {
      ready: async () => {
        calls.legacyReady += 1;
        return { adapterId: "legacy-cdp", contextId: 7, capabilities: ["state", "actions"] };
      },
      readState: async () => {
        calls.legacyRead += 1;
        return legacyState;
      },
      execute: async () => {
        calls.legacyExecute += 1;
        return { ok: true, reason: "legacy-action" };
      },
    };
    const client = {
      evaluate: async () => {
        calls.evaluate += 1;
        return scenario.response;
      },
    };
    const adapter = new CdpRuntimeControlAdapter({ client, contextId: 7, legacy });

    const readiness = await adapter.ready();
    const state = await adapter.readState();
    const action = await adapter.execute({ type: "run-board-action" });

    assert.equal(readiness.adapterId, "legacy-cdp");
    assert.deepEqual(state, legacyState);
    assert.deepEqual(action, { ok: true, reason: "legacy-action" });
    assert.deepEqual(calls, { evaluate: 1, legacyReady: 1, legacyRead: 1, legacyExecute: 1 });
    assert.deepEqual(adapter.status().fallback, { active: true, reason: scenario.reason });
  });
}

test("Automation Runtime selects the CDP Adapter and exposes bridge status on the dashboard", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-control-status-"));
  const baseline = normalizedBaseline();
  baseline.board.grids = [];
  baseline.orders = [];
  const backend = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  let evaluations = 0;
  backend.lab = {
    snapshot: async () => ({}),
    client: {
      evaluate: async () => {
        evaluations += 1;
        if (evaluations === 1) return { handshake: healthyHandshake(), baseline };
        return {
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
        };
      },
    },
  };
  backend.selection = {
    probe: { context: { id: 7 } },
    adapter: { id: "target-game" },
  };
  backend.connectionService.status = async () => ({
    listening: true,
    starting: false,
    managed: false,
    cdpPort: 62000,
  });

  try {
    const adapter = backend.ensureRuntimeControl();
    await adapter.ready();
    backend.running = true;
    backend.lastState = baseline;
    backend.lastPlan = { status: "cached", recommended: null, plans: [] };

    const dashboard = await backend.dashboard();

    assert.ok(adapter instanceof CdpRuntimeControlAdapter);
    assert.equal(dashboard.runtimeControl.ready, true);
    assert.equal(dashboard.runtimeControl.contextGeneration, "7");
    assert.equal(dashboard.runtimeControl.capabilities.baseline, true);
    assert.deepEqual(dashboard.runtimeControl.fallback, { active: false, reason: null });
  } finally {
    backend.running = false;
    await backend.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
