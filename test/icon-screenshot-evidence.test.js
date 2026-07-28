"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { PNG } = require("pngjs");
const jpeg = require("jpeg-js");
const { AutomationDatabase } = require("../src/automation-database");
const { AutomationRuntime } = require("../src/automation-runtime");
const { cropScreenshot, compareIcons, chooseStableFrame } = require("../src/icon-screenshot-evidence");
const { IconEvidenceService, resolveCocosSpriteFrame, resolveScreenshotTarget, captureCdpScreenshot } = require("../src/icon-evidence");

function image(width, height, pixel) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) png.data.set(pixel(x, y), (y * width + x) * 4);
  return PNG.sync.write(png);
}

function nearestScale(buffer, factor) {
  const source = PNG.sync.read(buffer);
  return image(source.width * factor, source.height * factor, (x, y) => [...source.data.subarray((Math.floor(y / factor) * source.width + Math.floor(x / factor)) * 4, (Math.floor(y / factor) * source.width + Math.floor(x / factor)) * 4 + 4)]);
}

test("screenshot crops use runtime viewport scale and bind the observed item", () => {
  const screenshot = image(200, 100, (x, y) => x >= 20 && x < 60 && y >= 10 && y < 30 ? [240, 20, 20, 255] : [0, 0, 0, 255]);
  const result = cropScreenshot(screenshot, {
    observedItemId: "item-7",
    bounds: { x: 10, y: 5, width: 20, height: 10 },
    viewport: { width: 100, height: 50 },
  });
  const cropped = PNG.sync.read(result.png);
  assert.equal(result.observedItemId, "item-7");
  assert.deepEqual(result.pixelCrop, { x: 20, y: 10, width: 40, height: 20 });
  assert.equal(cropped.width, 40);
  assert.equal(cropped.height, 20);
  assert.deepEqual([...cropped.data.subarray(0, 4)], [240, 20, 20, 255]);
});

test("screenshot provider uses atomic runtime bounds and CDP capture", async () => {
  const expressions = [];
  const calls = [];
  const client = {
    evaluate: async (source, contextId) => { expressions.push(source); assert.equal(contextId, 9); if (expressions.length === 1) return null; if (expressions.length === 2) return { observedItemId: "i1", runtimeSource: "board-cell" }; return { bounds: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 100, height: 50 }, devicePixelRatio: 2 }; },
    send: async (method, params) => { calls.push([method, params]); return method === "Page.captureScreenshot" ? { data: Buffer.from("png").toString("base64") } : {}; },
  };
  const target = await resolveScreenshotTarget({ client, contextId: 9, itemId: "i1" });
  assert.equal(target.devicePixelRatio, 2);
  assert.match(expressions[1], /i1/);
  assert.match(expressions[1], /_itemLayer/);
  assert.match(expressions[1], /childViews/);
  assert.match(expressions[1], /_boardGrid/);
  assert.match(expressions[2], /getBoundingBoxToWorld/);
  const token = /slots\["([^"]+)"\]/.exec(expressions[1])?.[1];
  assert.ok(token && expressions[2].includes(token));
  assert.equal(expressions.every((expression) => !/while\s*\(/.test(expression)), true);
  assert.equal((await captureCdpScreenshot({ client })).toString(), "png");
  assert.deepEqual(calls.map(([method]) => method), ["Page.enable", "Page.captureScreenshot"]);
});

test("screenshot provider finds an item icon nested in the order view tree", async () => {
  const iconNode = {
    name: "icon",
    activeInHierarchy: true,
    getBoundingBoxToWorld: () => ({ x: 20, y: 30, width: 40, height: 50 }),
  };
  const orderItemNode = {
    name: "task_single_item",
    activeInHierarchy: true,
    getComponentsInChildren: () => [{ node: iconNode, spriteFrame: { name: "icon_meat_3" } }],
  };
  const orderItemView = { itemId: "10100109", mNode: orderItemNode, childViews: [] };
  const controllerView = { childViews: [{ childViews: [{ childViews: [{ childViews: [orderItemView] }] }] }] };
  const entry = { _components: [{ mControllers: [{ _controllerClazzName: "UserBoardViewController", view: controllerView }] }] };
  const root = {
    getChildByName: (name) => name === "Entry" ? entry : null,
    getComponentsInChildren: () => [],
  };
  function Sprite() {}
  const sandbox = {
    cc: { Sprite, director: { getScene: () => root }, view: { getVisibleSize: () => ({ width: 100, height: 100 }) } },
    innerWidth: 100,
    innerHeight: 100,
    devicePixelRatio: 1,
  };
  sandbox.globalThis = sandbox;
  const client = { evaluate: async (source) => vm.runInNewContext(source, sandbox) };

  const target = await resolveScreenshotTarget({ client, contextId: 9, itemId: "10100109" });

  assert.equal(target.runtimeSource, "controller-item-view");
  assert.equal(target.visible, true);
  assert.equal(JSON.stringify(target.bounds), JSON.stringify({ x: 20, y: 20, width: 40, height: 50 }));
});

test("exact provider resolves the SpriteFrame from an offscreen order item view", async () => {
  const texture = {
    _uuid: "texture-1",
    _nativeUrl: "https://assets.invalid/merge-icons.png",
    _width: 1024,
    _height: 1024,
    _textureSource: { _nativeData: { width: 476, height: 824 } },
  };
  const frame = {
    _name: "icon_meat_3",
    _uuid: "frame-1",
    _texture: texture,
    _rect: { x: 237, y: 337, width: 116, height: 84 },
    _originalSize: { width: 120, height: 120 },
    _offset: { x: 0, y: 1 },
  };
  const itemNode = { getComponentsInChildren: () => [{ node: { name: "icon" }, spriteFrame: frame }] };
  const itemView = { itemId: "10100109", mNode: itemNode, childViews: [] };
  const controllerView = { childViews: [{ childViews: [{ childViews: [{ childViews: [itemView] }] }] }] };
  const entry = { _components: [{ mControllers: [{ _controllerClazzName: "UserBoardViewController", view: controllerView }] }] };
  function Sprite() {}
  const sandbox = {
    cc: {
      Sprite,
      director: { getScene: () => ({ getChildByName: () => entry, getComponentsInChildren: () => [] }) },
    },
    document: {
      createElement: () => ({
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => "data:image/png;base64,cG5n",
      }),
    },
  };
  sandbox.globalThis = sandbox;
  const client = { evaluate: async (source) => vm.runInNewContext(source, sandbox) };

  const metadata = await resolveCocosSpriteFrame({ client, contextId: 9, itemId: "10100109" });

  assert.equal(metadata.runtimeIdentifier, "icon_meat_3");
  assert.equal(metadata.resourceUrl, "data:image/png;base64,cG5n");
  assert.equal(JSON.stringify(metadata.rect), JSON.stringify({ x: 237, y: 337, width: 116, height: 84 }));
});

test("exact provider resolves a loaded SpriteFrame by catalog resource without a rendered item view", async () => {
  const texture = {
    _uuid: "texture-suitcase",
    _width: 1024,
    _height: 1024,
    _textureSource: { _nativeData: { width: 1024, height: 1024 } },
  };
  const frame = {
    _name: "icon_clothes_15",
    _uuid: "frame-clothes-15",
    _texture: texture,
    _rect: { x: 640, y: 320, width: 96, height: 96 },
    _originalSize: { width: 96, height: 96 },
    _offset: { x: 0, y: 0 },
  };
  function Sprite() {}
  const sandbox = {
    cc: {
      Sprite,
      director: { getScene: () => ({ getChildByName: () => null, children: [], getComponentsInChildren: () => [] }) },
      assetManager: { assets: { _map: { "frame-clothes-15": frame } } },
    },
    document: {
      createElement: () => ({
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => "data:image/png;base64,Y2xvdGhlcw==",
      }),
    },
  };
  sandbox.globalThis = sandbox;
  const client = { evaluate: async (source) => vm.runInNewContext(source, sandbox) };

  const metadata = await resolveCocosSpriteFrame({
    client,
    contextId: 9,
    itemId: "10100075",
    itemIdentity: { itemId: "10100075", iconResourceIdentifier: "suitcase/icon_clothes_15" },
  });

  assert.equal(metadata.runtimeIdentifier, "icon_clothes_15");
  assert.equal(metadata.resourceUrl, "data:image/png;base64,Y2xvdGhlcw==");
  assert.equal(JSON.stringify(metadata.rect), JSON.stringify({ x: 640, y: 320, width: 96, height: 96 }));
});

test("catalog resource SpriteFrame outranks a stale offscreen item view", async () => {
  const staleTexture = { _uuid: "stale-texture", _textureSource: { _nativeData: { width: 128, height: 128 } } };
  const staleFrame = {
    _name: "icon",
    _uuid: "stale-frame",
    _texture: staleTexture,
    _rect: { x: 0, y: 0, width: 58, height: 58 },
    _originalSize: { width: 58, height: 58 },
    _offset: { x: 0, y: 0 },
  };
  const genericAssetFrame = {
    _name: "icon",
    _uuid: "generic-icon-frame",
    _texture: staleTexture,
    _rect: { x: 224, y: 2, width: 54, height: 58 },
    _originalSize: { width: 54, height: 58 },
    _offset: { x: 0, y: 0 },
  };
  const exactTexture = { _uuid: "clothes-texture", _textureSource: { _nativeData: { width: 512, height: 512 } } };
  const exactFrame = {
    name: "",
    _name: "icon_clothes_3",
    _uuid: "clothes-frame-3",
    _texture: exactTexture,
    _rect: { x: 128, y: 64, width: 72, height: 76 },
    _originalSize: { width: 72, height: 76 },
    _offset: { x: 0, y: 0 },
  };
  const itemView = {
    itemId: "10100063",
    mNode: { getComponentsInChildren: () => [{ node: { name: "icon" }, spriteFrame: staleFrame }] },
    childViews: [],
  };
  const controllerView = { childViews: [itemView] };
  const entry = { _components: [{ mControllers: [{ _controllerClazzName: "UserBoardViewController", view: controllerView }] }] };
  function Sprite() {}
  const sandbox = {
    cc: {
      Sprite,
      director: { getScene: () => ({ getChildByName: () => entry, getComponentsInChildren: () => [] }) },
      assetManager: { assets: { _map: { "generic-icon-frame": genericAssetFrame, "clothes-frame-3": exactFrame } } },
    },
    document: {
      createElement: () => ({ getContext: () => ({ drawImage: () => {} }), toDataURL: () => "data:image/png;base64,ZXhhY3Q=" }),
    },
  };
  sandbox.globalThis = sandbox;
  const client = { evaluate: async (source) => vm.runInNewContext(source, sandbox) };

  const metadata = await resolveCocosSpriteFrame({
    client,
    contextId: 9,
    itemId: "10100063",
    itemIdentity: { itemId: "10100063", iconResourceIdentifier: "suitcase/icon_clothes_3" },
  });

  assert.equal(metadata.runtimeIdentifier, "icon_clothes_3");
  assert.equal(metadata.textureUuid, "clothes-texture");
  assert.equal(JSON.stringify(metadata.rect), JSON.stringify({ x: 128, y: 64, width: 72, height: 76 }));
});

test("multi-frame selection prefers the repeated stable frame over a transient overlay", () => {
  const stable = image(12, 12, (x, y) => x > 2 && x < 9 && y > 2 && y < 9 ? [20, 180, 80, 255] : [30, 30, 30, 255]);
  const overlay = image(12, 12, (x, y) => x === 0 || y === 0 || x === 11 || y === 11 ? [255, 220, 0, 255] : [20, 180, 80, 255]);
  const chosen = chooseStableFrame([stable, overlay, stable]);
  assert.equal(chosen.index, 0);
  assert.deepEqual(chosen.acceptedFrameIndexes, [0, 2]);
  assert.deepEqual(chosen.rejectedFrameIndexes, [1]);
  assert.equal(chosen.reason, "exact-majority");
});

test("similarity evidence explains scaling, JPEG compression, background changes, and different icons", () => {
  const base = image(24, 24, (x, y) => {
    if (x > 5 && x < 18 && y > 4 && y < 19) return x < 12 ? [230, 50, 40, 255] : [40, 120, 230, 255];
    return [25, 30, 35, 255];
  });
  const scaled = nearestScale(base, 2);
  const decoded = PNG.sync.read(base);
  const compressed = jpeg.encode({ data: decoded.data, width: decoded.width, height: decoded.height }, 72).data;
  const changedBackground = image(24, 24, (x, y) => x > 5 && x < 18 && y > 4 && y < 19 ? (x < 12 ? [230, 50, 40, 255] : [40, 120, 230, 255]) : [215, 210, 195, 255]);
  const different = image(24, 24, (x, y) => (x + y) % 2 ? [245, 230, 30, 255] : [80, 20, 130, 255]);
  const scaledEvidence = compareIcons(base, scaled);
  const compressedEvidence = compareIcons(base, compressed, "image/png", "image/jpeg");
  const backgroundEvidence = compareIcons(base, changedBackground);
  const differentEvidence = compareIcons(base, different);
  assert.equal(scaledEvidence.exactMatch, false);
  assert.ok(scaledEvidence.composite > 0.95);
  assert.ok(compressedEvidence.composite > 0.72);
  assert.ok(backgroundEvidence.composite > 0.55);
  assert.ok(differentEvidence.composite < 0.55, JSON.stringify({ backgroundEvidence, differentEvidence }));
  for (const evidence of [scaledEvidence, compressedEvidence, backgroundEvidence, differentEvidence]) {
    assert.deepEqual(Object.keys(evidence.metrics).sort(), ["colorHistogram", "perceptualHash", "structure", "transparentContour"]);
  }
});

test("uniform screenshot backgrounds become transparent contour evidence", () => {
  const screenshot = (background) => image(30, 30, (x, y) => x >= 8 && x < 22 && y >= 7 && y < 23 ? [220, 45, 70, 255] : background);
  const target = { observedItemId: "i1", bounds: { x: 0, y: 0, width: 30, height: 30 }, viewport: { width: 30, height: 30 } };
  const dark = cropScreenshot(screenshot([20, 25, 30, 255]), target);
  const light = cropScreenshot(screenshot([220, 215, 200, 255]), target);
  assert.equal(dark.backgroundRemoval.applied, true);
  assert.equal(light.backgroundRemoval.applied, true);
  const evidence = compareIcons(dark.png, light.png);
  assert.ok(evidence.metrics.transparentContour > 0.95);
  assert.ok(evidence.composite > 0.8);
});

test("clipped control-console chrome never becomes an automatic display icon", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-clipped-chrome-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  database.observeCatalogObject({
    objectType: "item-identity",
    objectId: "10100210",
    payload: { itemId: "10100210", level: 2 },
    sourceType: "runtime",
  });
  const chromeFragment = image(64, 64, (x, y) => {
    if (x >= 12 && x < 64 && y >= 10 && y < 14 && (x + y) % 3 !== 0) return [70, 70, 70, 255];
    if (x >= 12 && x < 18 && y >= 42 && y < 51) return [255, 135, 30, 255];
    if (x >= 25 && x < 64 && y >= 43 && y < 47 && (x + y) % 4 !== 0) return [245, 105, 20, 255];
    return [254, 251, 248, 255];
  });
  const target = {
    observedItemId: "10100210",
    visible: true,
    runtimeSource: "board-item-view",
    captureEligibility: "eligible",
    bounds: { x: 0, y: 0, width: 64, height: 64 },
    viewport: { width: 64, height: 64 },
    devicePixelRatio: 1,
  };
  const service = new IconEvidenceService({
    database,
    cacheDir: path.join(root, "cache"),
    screenshotFrameDelayMs: 0,
    resolveSpriteFrame: async () => {
      throw new Error("SpriteFrame resource not found for item 10100210");
    },
    resolveScreenshotBounds: async () => target,
    captureScreenshot: async () => chromeFragment,
  });
  try {
    service.request("10100210");
    await service.waitForIdle();
    assert.equal(service.getTask(1).status, "complete");
    assert.equal(database.getSelectedIconCandidate("10100210"), null);
    const [candidate] = database.listIconCandidates("10100210");
    assert.equal(candidate.crop.backgroundRemoval.applied, true);
    assert.equal(candidate.crop.backgroundRemoval.foreground.touchesEdge, true);
    assert.equal(candidate.similarity.qualityGate.status, "rejected");
    assert.ok(candidate.similarity.qualityGate.reasons.includes("foreground-clipped"));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup cleanup invalidates legacy automatic screenshots without foreground completeness evidence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-legacy-foreground-"));
  const file = path.join(dataDir, "legacy-screenshot.png");
  fs.writeFileSync(file, image(2, 2, () => [255, 120, 20, 255]));
  let runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  try {
    runtime.database.observeCatalogObject({
      objectType: "item-identity",
      objectId: "legacy-clipped-screenshot",
      payload: { itemId: "legacy-clipped-screenshot" },
      sourceType: "runtime",
    });
    runtime.database.saveIconCandidate({
      itemId: "legacy-clipped-screenshot",
      cacheKey: "legacy-clipped-screenshot",
      sourceType: "screenshot-runtime",
      crop: { backgroundRemoval: { applied: true } },
      similarity: { qualityGate: { status: "eligible", reasons: [], stability: 1 } },
      asset: {
        hash: "c".repeat(64),
        mimeType: "image/png",
        width: 2,
        height: 2,
        byteSize: fs.statSync(file).size,
        filePath: file,
      },
    });
    assert.ok(runtime.database.getSelectedIconCandidate("legacy-clipped-screenshot"));
    await runtime.close();

    runtime = new AutomationRuntime({
      rootDir: path.resolve(__dirname, ".."),
      dataDir,
      manageConnectionRoute: false,
    });
    assert.equal(runtime.database.getSelectedIconCandidate("legacy-clipped-screenshot"), null);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("manual icon selection outranks later automatic candidates and revoke retains history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-choice-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  const file = path.join(root, "icon.png");
  fs.writeFileSync(file, image(1, 1, () => [255, 0, 0, 255]));
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1" }, sourceType: "runtime" });
  const save = (hash, cacheKey) => database.saveIconCandidate({ itemId: "i1", cacheKey, sourceType: "screenshot-runtime", crop: {}, similarity: { composite: 0.8 }, asset: { hash, mimeType: "image/png", width: 1, height: 1, byteSize: 1, filePath: file } });
  try {
    const first = save("1".repeat(64), "first");
    const second = save("2".repeat(64), "second");
    database.selectIconCandidate("i1", first.id, { actor: "operator", note: "preferred", expectedDisplayIconRevision: database.getCatalogObject("item-identity", "i1").displayIcon.revision });
    save("3".repeat(64), "third");
    assert.equal(database.getSelectedIconCandidate("i1").id, first.id);
    database.revokeIconSelection("i1", { actor: "operator", note: "recheck", expectedDisplayIconRevision: database.getCatalogObject("item-identity", "i1").displayIcon.revision });
    assert.equal(database.getSelectedIconCandidate("i1"), null);
    const object = database.getCatalogObject("item-identity", "i1");
    assert.deepEqual(object.iconSelectionHistory.map((entry) => entry.action), [
      "automatic-select",
      "manual-select",
      "manual-revoke",
    ]);
    assert.equal(object.iconCandidates.length, 3);
    assert.equal(second.selected, false);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup quality cleanup invalidates stale automatic screenshots but preserves manual overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-cleanup-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  const file = path.join(root, "icon.png");
  fs.writeFileSync(file, image(2, 2, () => [255, 0, 0, 255]));
  const asset = (hash) => ({ hash, mimeType: "image/png", width: 2, height: 2, byteSize: fs.statSync(file).size, filePath: file });
  try {
    for (const itemId of ["automatic", "manual"]) database.observeCatalogObject({ objectType: "item-identity", objectId: itemId, payload: { itemId }, sourceType: "runtime" });
    database.saveIconCandidate({ itemId: "automatic", cacheKey: "bad-auto", sourceType: "screenshot-runtime", crop: { backgroundRemoval: { applied: false } }, similarity: {}, asset: asset("a".repeat(64)) });
    const manualCandidate = database.saveIconCandidate({ itemId: "manual", cacheKey: "bad-manual", sourceType: "screenshot-runtime", crop: { backgroundRemoval: { applied: false } }, similarity: {}, asset: asset("b".repeat(64)) });
    database.selectIconCandidate("manual", manualCandidate.id, { actor: "operator", note: "verified by eye", expectedDisplayIconRevision: database.getCatalogObject("item-identity", "manual").displayIcon.revision });

    const invalidated = database.invalidateAutomaticIconSelections((candidate) => candidate.sourceType !== "screenshot-runtime"
      || (candidate.crop?.backgroundRemoval?.applied === true && candidate.similarity?.qualityGate?.status === "eligible"));

    assert.deepEqual(invalidated.map((entry) => entry.itemId), ["automatic"]);
    assert.equal(database.getSelectedIconCandidate("automatic"), null);
    assert.equal(database.getSelectedIconCandidate("manual").selectionOrigin, "manual");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact mapping failure falls back to stable runtime screenshot evidence without activating catalog knowledge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-fallback-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1" }, sourceType: "runtime" });
  database.observeCatalogObject({ objectType: "merge-relation", objectId: "i1", payload: { itemId: "i1", mergeTarget: "i2" }, sourceType: "visual-similarity" });
  database.observeCatalogObject({ objectType: "production-profile", objectId: "p1:default", payload: { producerItemId: "p1", energyCost: 1, planningDistribution: { outcomes: [{ itemId: "i1", probability: 1 }] } }, sourceType: "visual-similarity" });
  const stable = image(40, 40, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30 ? [20, 180, 80, 255] : [30, 30, 30, 255]);
  const overlay = image(40, 40, (x, y) => x < 8 || y < 8 ? [255, 230, 0, 255] : (x >= 10 && x < 30 && y >= 10 && y < 30 ? [20, 180, 80, 255] : [30, 30, 30, 255]));
  const frames = [stable, overlay, stable];
  let captures = 0;
  const service = new IconEvidenceService({
    database, cacheDir: path.join(root, "cache"), concurrency: 1, screenshotFrameDelayMs: 0,
    resolveSpriteFrame: async () => { throw new Error("no SpriteFrame mapping"); },
    resolveScreenshotBounds: async ({ itemId }) => ({ observedItemId: itemId, visible: true, bounds: { x: 0, y: 0, width: 40, height: 40 }, viewport: { width: 40, height: 40 }, devicePixelRatio: 1, runtimeSource: "board-cell" }),
    captureScreenshot: async () => frames[captures++],
  });
  try {
    service.request("i1");
    await service.waitForIdle();
    const task = service.getTask(1);
    assert.equal(task.status, "complete");
    assert.equal(task.result.provider, "screenshot-runtime");
    const candidate = database.getSelectedIconCandidate("i1");
    assert.equal(candidate.sourceType, "screenshot-runtime");
    assert.equal(candidate.crop.observedItemId, "i1");
    assert.equal(candidate.crop.runtimeSource, "board-cell");
    assert.deepEqual(candidate.similarity.frameSelection.acceptedFrameIndexes, [0, 2]);
    assert.equal(database.getCatalogObject("merge-relation", "i1").status, "observed");
    assert.equal(database.getCatalogObject("production-profile", "p1:default").status, "observed");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("transformed board screenshots remain audit candidates but are never automatically selected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-fallback-rejected-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1" }, sourceType: "runtime" });
  const frame = image(40, 40, (x, y) => (x + y) % 2 ? [245, 245, 245, 255] : [15, 15, 15, 255]);
  const service = new IconEvidenceService({
    database, cacheDir: path.join(root, "cache"), concurrency: 1, screenshotFrameDelayMs: 0,
    resolveSpriteFrame: async () => { throw new Error("no SpriteFrame mapping"); },
    resolveScreenshotBounds: async ({ itemId }) => ({
      observedItemId: itemId,
      visible: true,
      bounds: { x: 0, y: 0, width: 40, height: 40 },
      viewport: { width: 40, height: 40 },
      devicePixelRatio: 1,
      runtimeSource: "board-item-view",
      captureEligibility: "transformed-board-item",
    }),
    captureScreenshot: async () => frame,
  });
  try {
    service.request("i1");
    await service.waitForIdle();
    assert.equal(service.getTask(1).status, "complete");
    assert.equal(database.getSelectedIconCandidate("i1"), null);
    const [candidate] = database.listIconCandidates("i1");
    assert.equal(candidate.sourceType, "screenshot-runtime");
    assert.equal(candidate.selected, false);
    assert.equal(candidate.similarity.qualityGate.status, "rejected");
    assert.ok(candidate.similarity.qualityGate.reasons.includes("transformed-board-item"));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt mapped resources fail explicitly instead of being misclassified as mapping fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-corrupt-resource-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1" }, sourceType: "runtime" });
  let screenshotBoundsCalls = 0;
  const service = new IconEvidenceService({
    database, cacheDir: path.join(root, "cache"), concurrency: 1,
    resolveSpriteFrame: async () => ({ resourceUrl: "wxfile://mapped.png", mimeType: "image/png", rect: { x: 0, y: 0, width: 1, height: 1 } }),
    readResource: async () => ({ body: Buffer.from("corrupt"), mimeType: "image/png" }),
    resolveScreenshotBounds: async () => { screenshotBoundsCalls += 1; return null; },
  });
  try {
    service.request("i1");
    await service.waitForIdle();
    assert.equal(service.getTask(1).status, "error");
    assert.equal(screenshotBoundsCalls, 0);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uploaded replacement is normalized, manually selected, and leaves planning unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-upload-"));
  fs.mkdirSync(path.join(root, "captures"));
  fs.writeFileSync(path.join(root, "captures", "item-catalog.json"), JSON.stringify({
    chains: [{ id: "c", complete: true, minLevel: 1, maxLevel: 2, itemIds: ["i1", "i2"] }],
    items: [{ id: "i1", chainId: "c", level: 1, baseUnits: 1, mergeTarget: "i2" }, { id: "i2", chainId: "c", level: 2, baseUnits: 2, mergeTarget: null }], producers: [],
  }));
  const events = [];
  const runtime = new AutomationRuntime({
    rootDir: root,
    dataDir: path.join(root, "data"),
    manageConnectionRoute: false,
    onEvent: (event) => events.push(event),
  });
  try {
    const before = runtime.getPlanningCatalog().items.map((item) => item.id);
    const object = runtime.getCatalogObject("item-identity", "i1");
    const uploaded = await runtime.uploadCatalogIcon("i1", { dataBase64: image(3, 2, () => [90, 30, 200, 255]).toString("base64"), mimeType: "image/png", actor: "operator", note: "clean replacement", expectedDisplayIconRevision: object.displayIcon.revision });
    assert.equal(uploaded.selectedIcon.sourceType, "user-upload");
    assert.equal(uploaded.selectedIcon.selectionOrigin, "manual");
    assert.equal(uploaded.iconSelectionHistory.at(-1).action, "manual-select");
    assert.equal(uploaded.revision, object.revision);
    assert.equal(uploaded.displayIcon.revision, object.displayIcon.revision + 1);
    assert.deepEqual(events.filter((event) => event.type === "catalog-display-icon-updated").map(({ type, at, ...event }) => event), [
      { objectType: "item-identity", objectId: "i1", displayIconRevision: uploaded.displayIcon.revision },
    ]);
    assert.deepEqual(runtime.getPlanningCatalog().items.map((item) => item.id), before);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
