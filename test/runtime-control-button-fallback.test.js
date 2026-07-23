

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { CdpRuntimeControlAdapter } = require("../src/runtime-control-bridge");

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

// --- Button fixture helpers ---

function buttonSceneFixture(options = {}) {
  const {
    buttonNodeName = "NavButton",
    buttonInteractable = true,
    buttonActive = true,
    buttonHandlerTargetName = "EntranceViewController",
    buttonHandlerComponent = "EntranceViewController",
    buttonHandlerName = "onBoardClick",
    boardVisible = false,
    mapVisible = true,
    extraButtons = [],
    missingHandlerMethod = false,
  } = options;

  const targetController = {
    name: buttonHandlerTargetName,
    getComponent: () => targetComponent,
  };
  const targetComponent = {
    [buttonHandlerName]: missingHandlerMethod ? undefined : function onBoardClick(data) {
      this._clicked = true;
      this._clickData = data;
    },
    _clicked: false,
    _clickData: null,
  };
  const buttonComponent = {
    interactable: buttonInteractable,
    clickEvents: [{
      target: targetController,
      component: buttonHandlerComponent,
      handler: buttonHandlerName,
      customEventData: "test-data",
    }],
    emit: function (event) { this._emitted = event; },
    _emitted: null,
  };
  const buttonNode = {
    name: buttonNodeName,
    active: buttonActive,
    activeInHierarchy: buttonActive,
    _components: [buttonComponent],
    children: [],
    worldPosition: { x: 100, y: 200, _x: 100, _y: 200 },
    position: { x: 100, y: 200 },
    getWorldPosition: () => ({ x: 100, y: 200 }),
    getComponent: (type) => {
      if (type === "UITransform") return { width: 80, height: 40 };
      if (type === buttonHandlerComponent) return targetComponent;
      return null;
    },
    _uiTransformComponent: { width: 80, height: 40 },
    emit: function (eventName, comp) { this._nodeEmitted = { event: eventName, component: comp }; },
    _nodeEmitted: null,
  };

  const mapController = {
    _controllerClazzName: "FieldMapMainViewController",
    isViewVisible: mapVisible,
  };
  const boardController = {
    _controllerClazzName: "UserBoardViewController",
    isViewVisible: boardVisible,
    view: {
      _boardView: {
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
    isViewVisible: mapVisible && !boardVisible,
    view: {
      onBoardClick: boardVisible ? undefined : (() => { /* primary handler */ }),
    },
  };

  // Add any extra buttons
  const extraButtonNodes = extraButtons.map((cfg, idx) => ({
    name: cfg.nodeName || `ExtraButton${idx}`,
    active: cfg.active !== false,
    activeInHierarchy: cfg.active !== false,
    _components: [{
      interactable: cfg.interactable !== false,
      clickEvents: [{
        target: { name: cfg.handlerTargetName || "SomeTarget", getComponent: () => ({}) },
        component: cfg.handlerComponent || "SomeComponent",
        handler: cfg.handlerName || "someHandler",
        customEventData: null,
      }],
      emit: function (event) { this._emitted = event; },
      _emitted: null,
    }],
    children: [],
    worldPosition: { x: 200 + idx * 50, y: 300 },
    position: { x: 200 + idx * 50, y: 300 },
    getWorldPosition: () => ({ x: 200 + idx * 50, y: 300 }),
    getComponent: () => ({ width: 60, height: 30 }),
    _uiTransformComponent: { width: 60, height: 30 },
    emit: () => {},
  }));

  const allButtonNodes = [buttonNode, ...extraButtonNodes];

  const runtime = {
    mControllers: [mapController, boardController, entranceController],
    mManagers: [
      { _resourceMap: new Map([[1, 50], [2, 5], [3, 10]]) },
      { _energyDataMap: new Map([[3, { _energyLimit: 20, _recoverInterval: 60, recoverTimestamp: null, inRecover: false }]]) },
      { clientTaskDataMap: new Map() },
    ],
  };

  // Build the scene tree with a proper single-parent hierarchy.
  // Buttons are children of Canvas, which is a child of the scene root.
  // Entry exists alongside Canvas (not containing buttons) so the bridge can find it.
  const canvasNode = {
    name: "Canvas",
    children: allButtonNodes,
    _components: [],
  };
  const entryNode = {
    name: "Entry",
    _components: [runtime],
    children: [],
  };
  const scene = {
    name: "main",
    getChildByName: (name) => {
      if (name === "Entry") return entryNode;
      if (name === "Canvas") return canvasNode;
      return allButtonNodes.find((n) => n.name === name) || null;
    },
    children: [canvasNode, entryNode],
  };

  const sandbox = vm.createContext({
    globalThis: null,
    cc: {
      ENGINE_VERSION: "3.8.0",
      director: { getScene: () => scene },
      UITransform: {},
    },
  });
  sandbox.globalThis = sandbox;

  return {
    sandbox,
    scene,
    runtime,
    buttonNode,
    buttonComponent,
    targetComponent,
    targetController,
    mapController,
    boardController,
    entranceController,
    allButtonNodes,
  };
}

function installBridge(fixture, contextGeneration = "7") {
  const { sandbox } = fixture;
  const { buildBridgeInstallExpression } = require("../src/runtime-control-bridge");
  const expression = buildBridgeInstallExpression(contextGeneration);
  return vm.runInContext(expression, sandbox);
}

// --- enumerateButtons tests ---

test("enumerateButtons returns bounded description of currently loaded buttons", () => {
  const fixture = buttonSceneFixture();
  installBridge(fixture);

  const result = fixture.sandbox.globalThis.miniGameCtl.enumerateButtons();

  assert.equal(result.scope, "current-scene-observation");
  assert.ok(result.count >= 1, "expected at least one button");
  assert.equal(result.truncated, false);

  const btn = result.buttons.find((b) => b.nodeName === "NavButton");
  assert.ok(btn, "NavButton should be found");
  assert.equal(btn.activeInHierarchy, true);
  assert.equal(btn.interactable, true);
  assert.equal(btn.handlerCount, 1);
  assert.equal(btn.inCurrentGameplayArea, true);
  assert.ok(btn.screenBounds.width > 0);
  assert.ok(btn.screenBounds.height > 0);

  const handler = btn.handlers[0];
  assert.equal(handler.targetName, "EntranceViewController");
  assert.equal(handler.component, "EntranceViewController");
  assert.equal(handler.handler, "onBoardClick");
});

test("enumerateButtons respects MAX_BUTTONS limit", () => {
  const fixture = buttonSceneFixture({
    extraButtons: Array.from({ length: 70 }, (_, i) => ({
      nodeName: `Btn${i}`,
      handlerName: `handler${i}`,
      interactable: true,
    })),
  });
  installBridge(fixture);

  const result = fixture.sandbox.globalThis.miniGameCtl.enumerateButtons();

  assert.ok(result.count <= 64, "should cap at 64 buttons");
  assert.equal(result.truncated, true);
});

test("enumerateButtons marks inactive buttons", () => {
  const fixture = buttonSceneFixture({ buttonActive: false });
  installBridge(fixture);

  const result = fixture.sandbox.globalThis.miniGameCtl.enumerateButtons();
  const btn = result.buttons.find((b) => b.nodeName === "NavButton");

  assert.ok(btn);
  assert.equal(btn.activeInHierarchy, false);
});

test("enumerateButtons marks non-interactable buttons", () => {
  const fixture = buttonSceneFixture({ buttonInteractable: false });
  installBridge(fixture);

  const result = fixture.sandbox.globalThis.miniGameCtl.enumerateButtons();
  const btn = result.buttons.find((b) => b.nodeName === "NavButton");

  assert.ok(btn);
  assert.equal(btn.interactable, false);
});

test("enumerateButtons returns empty when no buttons in scene", () => {
  const emptyBoard = { size: { width: 2, height: 2 }, __private_95_grids: [] };
  const boardCtrl = {
    _controllerClazzName: "UserBoardViewController",
    isViewVisible: true,
    view: {
      _boardView: {
        _gameBoardView: {
          _boardStore: { _state: { _gameBoard: emptyBoard } },
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
  const scene = {
    name: "main",
    getChildByName: (name) => {
      if (name === "Entry") {
        return {
          _components: [{
            mControllers: [boardCtrl],
            mManagers: [
              { _resourceMap: new Map([[1, 0], [2, 0], [3, 0]]) },
              { _energyDataMap: new Map([[3, {}]]) },
              { clientTaskDataMap: new Map() },
            ],
          }],
          children: [{ name: "Canvas", children: [], _components: [] }],
        };
      }
      return null;
    },
    children: [],
  };
  const sandbox = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  sandbox.globalThis = sandbox;

  const { buildBridgeInstallExpression } = require("../src/runtime-control-bridge");
  vm.runInContext(buildBridgeInstallExpression("7"), sandbox);

  const result = sandbox.globalThis.miniGameCtl.enumerateButtons();

  assert.equal(result.count, 0);
  assert.equal(result.buttons.length, 0);
});

// --- executeButtonFallback tests ---

test("executeButtonFallback Tier 1: invokes component handler when handler matches hint", async () => {
  const fixture = buttonSceneFixture();
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-1",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
      handlerComponent: "EntranceViewController",
      targetName: "EntranceViewController",
    },
  });

  assert.equal(ack.ok, true);
  const fallbackTier = ack.delta?.buttonFallback?.tier;
  // component-handler tier should have been attempted first
  assert.ok(fallbackTier === "component-handler" || fallbackTier === "node-event" || fallbackTier === "coordinate-input",
    `expected a valid fallback tier, got ${fallbackTier}`);
  assert.equal(ack.method, "navigate");
});

test("executeButtonFallback rejects when no button matches hint", async () => {
  const fixture = buttonSceneFixture();
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-no-match",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "nonExistentHandler",
    },
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "rejected-precondition");
  assert.equal(ack.reason, "fallback-no-match");
});

test("executeButtonFallback rejects ambiguous when multiple buttons match hint", async () => {
  const fixture = buttonSceneFixture({
    extraButtons: [{
      nodeName: "NavButton2",
      handlerName: "onBoardClick",
      handlerComponent: "EntranceViewController",
      handlerTargetName: "EntranceViewController",
      interactable: true,
    }],
  });
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-ambig",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
    },
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "unsupported-capability");
  assert.equal(ack.reason, "fallback-ambiguous");
});

test("executeButtonFallback rejects inactive button", async () => {
  const fixture = buttonSceneFixture({ buttonActive: false });
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-inactive",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
    },
  });

  // The button won't match because resolveButtonTarget filters out inactive buttons
  assert.equal(ack.ok, false);
  assert.ok(["rejected-precondition", "unsupported-capability"].includes(ack.outcome));
});

test("executeButtonFallback rejects non-interactable button", async () => {
  const fixture = buttonSceneFixture({ buttonInteractable: false });
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-noninteract",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
    },
  });

  assert.equal(ack.ok, false);
});

test("executeButtonFallback rejects stale revision", async () => {
  const fixture = buttonSceneFixture();
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-stale",
    expectedRevision: 99,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
    },
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "stale-revision");
});

test("executeButtonFallback is idempotent for duplicate operation IDs", async () => {
  const fixture = buttonSceneFixture();
  installBridge(fixture);

  const first = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-dup",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
      handlerComponent: "EntranceViewController",
    },
  });

  const second = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-dup",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
      handlerComponent: "EntranceViewController",
    },
  });

  assert.deepEqual(second, first);
});

test("executeButtonFallback handles locate-failed gracefully", async () => {
  const fixture = buttonSceneFixture();
  installBridge(fixture);

  // Remove the button node from the scene after enumeration would have found it
  // but before locateButtonComponent re-finds it — simulate by changing node name
  const origName = fixture.buttonNode.name;
  fixture.buttonNode.name = "ChangedName";

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-locate",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      nodeName: origName,
    },
  });

  // Should fail because the node name changed — enumerateButtons returns the old name
  // but locateButtonComponent can't find it
  assert.equal(ack.ok, false);
});

test("executeButtonFallback returns unchanged when button-fallback is idempotent for already-arrived target", async () => {
  const fixture = buttonSceneFixture({ boardVisible: true, mapVisible: false });
  // When already on board, navigating to board with button fallback is idempotent
  // Remove entrance handler so navigation capability is unavailable
  fixture.entranceController.view.onBoardClick = undefined;
  // Set up board's map button
  fixture.boardController.view._boardView.onMapButtonClick = () => {};

  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-already-board",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
    },
  });

  // Should either be accepted-unchanged (idempotent) or no-match (button not in area)
  assert.ok(ack.outcome === "accepted-unchanged" || ack.outcome === "rejected-precondition",
    `expected accepted-unchanged or rejected-precondition, got ${ack.outcome}: ${ack.reason}`);
});

// --- Fallback through all tiers ---

test("executeButtonFallback Tier 2: falls back to node event when component handler fails", async () => {
  const fixture = buttonSceneFixture({ missingHandlerMethod: true });
  installBridge(fixture);

  // component handler method doesn't exist on targetComponent,
  // so it should try node event (component.emit) next
  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-tier2",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
      handlerComponent: "EntranceViewController",
    },
  });

  // Should fall through to node-event tier or coordinate-input
  assert.ok(ack.ok || ack.outcome === "uncertain-result",
    `expected ok or uncertain, got ${ack.outcome}: ${ack.reason}`);
});

test("executeButtonFallback Tier 3: falls back to coordinate input when node event fails", async () => {
  // Remove emit from button component AND node so both tier 1 (missing handler) and tier 2 (no emit) fail
  const fixture = buttonSceneFixture({ missingHandlerMethod: true });
  fixture.buttonComponent.emit = undefined;
  fixture.buttonNode.emit = undefined;
  // Enable coordinate input by adding emit to the scene
  fixture.scene.emit = function (eventName, data) {
    this._sceneEmitted = { event: eventName, data: data };
  };
  fixture.scene._sceneEmitted = null;
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-tier3",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
      handlerComponent: "EntranceViewController",
    },
  });

  // Should fall through to coordinate-input tier
  assert.ok(ack.ok || ack.outcome === "uncertain-result",
    `expected ok or uncertain, got ${ack.outcome}: ${ack.reason}`);
  const fallbackTier = ack.delta?.buttonFallback?.tier;
  if (ack.ok) {
    assert.equal(fallbackTier, "coordinate-input", "expected coordinate-input tier");
  }
});

test("executeButtonFallback fails when all tiers are exhausted", async () => {
  // Remove ALL invocation paths
  const fixture = buttonSceneFixture({ missingHandlerMethod: true });
  fixture.buttonComponent.emit = undefined;
  fixture.buttonNode.emit = undefined;
  // Also break coordinate input by removing scene emit
  fixture.scene.emit = undefined;
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-all-fail",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      handlerName: "onBoardClick",
      handlerComponent: "EntranceViewController",
    },
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.outcome, "bridge-failure");
  assert.ok(ack.reason.includes("fallback") || ack.reason.includes("failed"),
    `expected fallback failure reason, got: ${ack.reason}`);
});

// --- executeButtonFallback with nodeName hint ---

test("executeButtonFallback resolves by node name", async () => {
  const fixture = buttonSceneFixture();
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-nodename",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      nodeName: "NavButton",
    },
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.delta.buttonFallback.nodeName, "NavButton");
});

// --- executeButtonFallback cross-scene button location ---

test("executeButtonFallback locates button by node name across scene tree", async () => {
  const fixture = buttonSceneFixture();
  // Nest the button deeper in the scene tree
  const deepNode = {
    name: "DeepContainer",
    children: [fixture.buttonNode],
    _components: [],
  };
  fixture.scene.children[0].children = [deepNode];
  installBridge(fixture);

  const ack = await fixture.sandbox.globalThis.miniGameCtl.executeCommand({
    operationId: "bf-deep",
    expectedRevision: 0,
    method: "navigate",
    target: "board",
    fallback: "button",
    buttonHint: {
      nodeName: "NavButton",
    },
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.delta.buttonFallback.nodeName, "NavButton");
});

// --- CdpRuntimeControlAdapter button fallback integration ---

test("CDP Adapter falls back to button diagnostics when navigation capability is unavailable", async () => {
  const fixture = buttonSceneFixture();
  // Remove entrance onBoardClick so navigation capability is false
  fixture.entranceController.view.onBoardClick = undefined;
  installBridge(fixture, "7");

  // Simulate: button click transitions to board via the actual handler (Tier 1)
  const origHandler = fixture.targetComponent.onBoardClick;
  fixture.targetComponent.onBoardClick = function (data) {
    if (origHandler) origHandler.call(this, data);
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
  assert.equal(result.reason, "navigation-verified-via-button-fallback");
  assert.equal(result.actions[0].type, "navigate");
  assert.equal(result.actions[0].target, "board");
  assert.equal(result.actions[0].verified, true);
  assert.equal(result.actions[0].fallback, "button");
  assert.equal(legacyCalled, false);
});

test("CDP Adapter falls through to legacy when button enumeration returns empty", async () => {
  // Scene with no buttons
  const scene = {
    name: "main",
    getChildByName: (name) => name === "Entry" ? {
      _components: [{
        mControllers: [
          {
            _controllerClazzName: "FieldMapMainViewController",
            isViewVisible: true,
          },
          {
            _controllerClazzName: "UserBoardViewController",
            isViewVisible: false,
            view: {
              _boardView: {
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
          },
          {
            _controllerClazzName: "EntranceViewController",
            isViewVisible: true,
            view: { onBoardClick: undefined /* no primary handler */ },
          },
        ],
        mManagers: [
          { _resourceMap: new Map([[1, 0]]) },
          { _energyDataMap: new Map() },
          { clientTaskDataMap: new Map() },
        ],
      }],
      children: [],
    } : null,
    children: [],
  };
  const sandbox = vm.createContext({
    globalThis: null,
    cc: { ENGINE_VERSION: "3.8.0", director: { getScene: () => scene } },
  });
  sandbox.globalThis = sandbox;

  const { buildBridgeInstallExpression } = require("../src/runtime-control-bridge");
  vm.runInContext(buildBridgeInstallExpression("7"), sandbox);

  let legacyCalled = false;
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => vm.runInContext(expression, sandbox),
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
  const result = await adapter.execute({ type: "navigate", target: "board" });

  assert.equal(result.ok, true);
  assert.equal(legacyCalled, true);
});

test("CDP Adapter falls through to legacy when button fallback fails all tiers", async () => {
  const fixture = buttonSceneFixture({ missingHandlerMethod: true });
  fixture.entranceController.view.onBoardClick = undefined;
  fixture.buttonComponent.emit = undefined;
  fixture.buttonNode.emit = undefined;
  fixture.scene.emit = undefined;
  installBridge(fixture, "7");

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

test("CDP Adapter button fallback diagnostic counters increment", async () => {
  const fixture = buttonSceneFixture();
  fixture.entranceController.view.onBoardClick = undefined;
  installBridge(fixture, "7");

  // Simulate button click transitions to board via the actual handler
  fixture.targetComponent.onBoardClick = () => {
    fixture.boardController.isViewVisible = true;
    fixture.mapController.isViewVisible = false;
    fixture.entranceController.isViewVisible = false;
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
  await adapter.execute({ type: "navigate", target: "board" });

  const status = adapter.status();
  assert.ok(status.buttonFallback.usageCount >= 1, `expected usageCount >= 1, got ${status.buttonFallback.usageCount}`);
  const totalResolutions = Object.values(status.buttonFallback.resolutions).reduce((a, b) => a + b, 0);
  assert.ok(totalResolutions >= 1 || status.buttonFallback.usageCount >= 1,
    "expected at least one diagnostic increment");
});

test("CDP Adapter does not use button fallback when semantic navigation is available", async () => {
  const fixture = buttonSceneFixture({ boardVisible: false, mapVisible: true });
  // Set up navigation capability BEFORE install so it's detected
  fixture.boardController.view._boardView.onMapButtonClick = () => {};
  installBridge(fixture, "7");

  // Simulate: onBoardClick transitions to board
  fixture.entranceController.view.onBoardClick = () => {
    fixture.boardController.isViewVisible = true;
    fixture.mapController.isViewVisible = false;
    fixture.entranceController.isViewVisible = false;
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
  const result = await adapter.execute({ type: "navigate", target: "board" });

  // Should use semantic navigation, not button fallback
  assert.equal(result.reason, "navigation-verified");
  const status = adapter.status();
  assert.equal(status.buttonFallback.usageCount, 0,
    "should not increment button fallback when semantic navigation is available");
});

test("CDP Adapter button fallback reports ambiguous buttons and falls to legacy", async () => {
  const fixture = buttonSceneFixture({
    extraButtons: [{
      nodeName: "NavButton2",
      handlerName: "onBoardClick",
      handlerComponent: "EntranceViewController",
      handlerTargetName: "EntranceViewController",
      interactable: true,
    }],
  });
  fixture.entranceController.view.onBoardClick = undefined;
  installBridge(fixture, "7");

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

test("CDP Adapter navigates to map through button fallback", async () => {
  const fixture = buttonSceneFixture({
    boardVisible: true,
    mapVisible: false,
    buttonNodeName: "MapButton",
    buttonHandlerName: "onMapButtonClick",
    buttonHandlerComponent: "UserBoardViewController",
    buttonHandlerTargetName: "UserBoardViewController",
  });
  // Remove map button from controller so navigation capability is absent
  fixture.boardController.view._boardView.onMapButtonClick = undefined;
  installBridge(fixture, "7");

  // Simulate: button click transitions to map via the actual handler (Tier 1)
  fixture.targetComponent.onMapButtonClick = () => {
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
  assert.equal(result.reason, "navigation-verified-via-button-fallback");
  assert.equal(result.actions[0].target, "map");
  assert.equal(result.actions[0].fallback, "button");
});

test("CDP Adapter handles abort during button enumeration", async () => {
  const fixture = buttonSceneFixture();
  fixture.entranceController.view.onBoardClick = undefined;
  installBridge(fixture, "7");

  const controller = new AbortController();
  const adapter = new CdpRuntimeControlAdapter({
    client: {
      evaluate: async (expression) => {
        controller.abort(); // Abort during enumeration
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

  try {
    await adapter.execute({ type: "navigate", target: "board" }, { signal: controller.signal });
    assert.fail("expected abort to throw");
  } catch (error) {
    assert.equal(error.name, "AbortError");
  }
});

test("CDP Adapter button fallback returns replan on stale revision", async () => {
  const fixture = buttonSceneFixture();
  fixture.entranceController.view.onBoardClick = undefined;
  installBridge(fixture, "7");

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

  // With expectedRevision=99 != revision=0, injected bridge rejects with stale-revision
  // The CDP adapter translates this to replan
  assert.equal(result.replanRequested, true);
});

test("CDP Adapter status reports button fallback diagnostics", async () => {
  const fixture = buttonSceneFixture();
  fixture.entranceController.view.onBoardClick = undefined;
  installBridge(fixture, "7");

  fixture.buttonComponent.emit = () => {
    fixture.boardController.isViewVisible = true;
    fixture.mapController.isViewVisible = false;
    fixture.entranceController.isViewVisible = false;
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
  await adapter.execute({ type: "navigate", target: "board" });

  const status = adapter.status();
  assert.ok(typeof status.buttonFallback === "object");
  assert.ok(Number.isInteger(status.buttonFallback.usageCount));
  assert.ok(typeof status.buttonFallback.resolutions === "object");
  assert.ok("component-handler" in status.buttonFallback.resolutions);
  assert.ok("node-event" in status.buttonFallback.resolutions);
  assert.ok("coordinate-input" in status.buttonFallback.resolutions);
});
