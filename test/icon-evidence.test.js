"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { PNG } = require("pngjs");
const { AutomationDatabase } = require("../src/automation-database");
const { AutomationRuntime } = require("../src/automation-runtime");
const { IconEvidenceService, reconstructIcon, readCdpResource, resolveCocosSpriteFrame } = require("../src/icon-evidence");

const COLORS = {
  clear: [0, 0, 0, 0], red: [255, 0, 0, 255], green: [0, 255, 0, 255], blue: [0, 0, 255, 255], yellow: [255, 255, 0, 255],
};

function png(width, height, pixels = {}) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = COLORS[pixels[`${x},${y}`] || "clear"];
      const offset = (y * width + x) * 4;
      image.data.set(color, offset);
    }
  }
  return PNG.sync.write(image);
}

function pixels(buffer) {
  const image = PNG.sync.read(buffer);
  const result = {};
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) result[`${x},${y}`] = [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
  return { width: image.width, height: image.height, pixels: result };
}

test("fixed PNG atlas fixtures reconstruct normal, rotated, offset, and transparent-padding icons", () => {
  const atlas = png(4, 4, { "1,1": "red", "2,1": "green", "0,0": "red", "0,1": "green", "1,0": "yellow", "3,3": "blue" });
  const ordinary = reconstructIcon(atlas, { mimeType: "image/png", rect: { x: 1, y: 1, width: 2, height: 1 }, originalSize: { width: 2, height: 1 }, offset: { x: 0, y: 0 }, rotated: false });
  assert.deepEqual(pixels(ordinary), { width: 2, height: 1, pixels: { "0,0": COLORS.red, "1,0": COLORS.green } });

  const rotated = reconstructIcon(atlas, { mimeType: "image/png", rect: { x: 0, y: 0, width: 2, height: 1 }, originalSize: { width: 2, height: 1 }, offset: { x: 0, y: 0 }, rotated: true });
  assert.deepEqual(pixels(rotated), { width: 2, height: 1, pixels: { "0,0": COLORS.red, "1,0": COLORS.green } });

  const offset = reconstructIcon(atlas, { mimeType: "image/png", rect: { x: 3, y: 3, width: 1, height: 1 }, originalSize: { width: 3, height: 3 }, offset: { x: 1, y: -1 }, rotated: false });
  const restored = pixels(offset);
  assert.equal(restored.width, 3);
  assert.equal(restored.height, 3);
  assert.deepEqual(restored.pixels["2,2"], COLORS.blue);
  assert.deepEqual(restored.pixels["0,0"], COLORS.clear);
});

test("bottom-left atlas coordinates convert before PNG cropping", () => {
  const atlas = png(2, 3, { "0,2": "yellow" });
  const icon = reconstructIcon(atlas, { mimeType: "image/png", rect: { x: 0, y: 0, width: 1, height: 1 }, yOrigin: "bottom-left", originalSize: { width: 1, height: 1 }, offset: { x: 0, y: 0 } });
  assert.deepEqual(pixels(icon).pixels["0,0"], COLORS.yellow);
});

test("CDP reads loaded HTTP, HTTPS, servicewechat, and wxfile image bodies", async () => {
  const urls = ["http://assets.test/a.png", "https://assets.test/b.png", "servicewechat://game/c.png", "wxfile://d.png"];
  const calls = [];
  const client = { send: async (method, params) => {
    calls.push([method, params]);
    if (method === "Page.enable") return {};
    if (method === "Page.getResourceTree") return { frameTree: { frame: { id: "root" }, resources: urls.map((url) => ({ url, mimeType: "image/png" })) } };
    if (method === "Page.getResourceContent") return { content: Buffer.from(params.url).toString("base64"), base64Encoded: true };
    throw new Error(method);
  } };
  for (const resourceUrl of urls) {
    const result = await readCdpResource({ client, resourceUrl });
    assert.equal(result.body.toString(), resourceUrl);
    assert.equal(result.mimeType, "image/png");
  }
  assert.equal(calls.filter(([method]) => method === "Page.getResourceContent").length, 4);
});

test("Cocos provider uses an atomic scene query and the selected Item Identity resource hint", async () => {
  let expression = "", context;
  const client = { evaluate: async (source, contextId) => { expression = source; context = contextId; return { runtimeIdentifier: "frame", textureUuid: "uuid", resourceUrl: "wxfile://icon.png", rect: { x: 0, y: 0, width: 1, height: 1 } }; } };
  const result = await resolveCocosSpriteFrame({ client, contextId: 42, itemId: "item-7", itemIdentity: { itemId: "item-7", iconResourceIdentifier: "IconRes_7" } });
  assert.equal(context, 42);
  assert.match(expression, /item-7/);
  assert.match(expression, /IconRes_7/);
  assert.match(expression, /getComponentsInChildren/);
  assert.doesNotMatch(expression, /while\s*\(|5000/);
  assert.equal(result.textureUuid, "uuid");
});

function withService(run, { concurrency = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-evidence-"));
  const database = new AutomationDatabase(path.join(dir, "catalog.db"));
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1" }, sourceType: "runtime" });
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i2", payload: { itemId: "i2" }, sourceType: "runtime" });
  return Promise.resolve(run({ database, dir, concurrency })).finally(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
}

test("resource and crop cache persists complete source metadata without duplicate processing", async () => withService(async ({ database, dir }) => {
  let resourceReads = 0;
  const atlas = png(2, 1, { "0,0": "red", "1,0": "green" });
  const events = [];
  const service = new IconEvidenceService({
    database, cacheDir: path.join(dir, "icon-cache"), concurrency: 1,
    resolveSpriteFrame: async ({ itemId }) => ({ runtimeIdentifier: `sprite:${itemId}`, textureUuid: "texture-uuid", resourceUrl: "wxfile://atlas.png", mimeType: "image/png", rect: { x: itemId === "i1" ? 0 : 1, y: 0, width: 1, height: 1 }, originalSize: { width: 1, height: 1 }, offset: { x: 0, y: 0 }, rotated: false }),
    readResource: async () => { resourceReads += 1; return { body: atlas, mimeType: "image/png", resolvedUrl: "wxfile://atlas.png" }; },
    onEvent: (event) => events.push(event),
  });

  const first = service.request("i1", { contextId: 7 });
  const duplicateInFlight = service.request("i1", { contextId: 7 });
  assert.equal(duplicateInFlight.taskId, first.taskId);
  await service.waitForIdle();
  assert.equal(resourceReads, 1);
  const candidate = database.getSelectedIconCandidate("i1");
  assert.equal(candidate.sourceType, "cocos-runtime-resource");
  assert.equal(candidate.resourceUrl, "wxfile://atlas.png");
  assert.equal(candidate.textureUuid, "texture-uuid");
  assert.deepEqual(candidate.crop.rect, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(candidate.width, 1);
  assert.equal(candidate.height, 1);
  assert.equal(candidate.mimeType, "image/png");
  assert.equal(fs.existsSync(candidate.filePath), true);

  service.request("i1", { contextId: 7 });
  await service.waitForIdle();
  assert.equal(resourceReads, 1);
  assert.equal(events.some((event) => event.type === "icon-acquisition-complete" && event.cached === true), true);

  const wrongFile = path.join(dir, "wrong.png");
  const wrongBody = png(1, 1, { "0,0": "blue" });
  fs.writeFileSync(wrongFile, wrongBody);
  database.saveIconCandidate({
    itemId: "i1", cacheKey: "wrong-generic-icon", sourceType: "cocos-runtime-resource",
    runtimeIdentifier: "icon", crop: { rect: { x: 9, y: 9, width: 1, height: 1 } }, rankScore: 1,
    asset: { hash: crypto.createHash("sha256").update(wrongBody).digest("hex"), mimeType: "image/png", width: 1, height: 1, byteSize: wrongBody.length, filePath: wrongFile },
  });
  assert.equal(database.getSelectedIconCandidate("i1").runtimeIdentifier, "icon");
  service.request("i1", { contextId: 7 });
  await service.waitForIdle();
  assert.equal(database.getSelectedIconCandidate("i1").runtimeIdentifier, "sprite:i1");

  const restartedService = new IconEvidenceService({
    database, cacheDir: path.join(dir, "icon-cache"), concurrency: 1,
    resolveSpriteFrame: service.resolveSpriteFrame,
    readResource: async () => { throw new Error("persistent cache should avoid resource read"); },
  });
  restartedService.request("i1", { contextId: 7 });
  await restartedService.waitForIdle();
  assert.equal(restartedService.getTask(1).status, "complete");

  service.request("i2", { contextId: 7 });
  await service.waitForIdle();
  assert.equal(database.listIconAssets().length, 3);
  const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "icon-snapshot-"));
  const restoredDatabase = new AutomationDatabase(path.join(portableRoot, "automation.db"));
  try {
    restoredDatabase.importCatalogSnapshot(database.exportCatalogSnapshot());
    const restored = restoredDatabase.getSelectedIconCandidate("i1");
    assert.equal(fs.existsSync(restored.filePath), true);
    assert.equal(restored.filePath.startsWith(portableRoot), true);
  } finally {
    restoredDatabase.close();
    fs.rmSync(portableRoot, { recursive: true, force: true });
  }
  fs.rmSync(candidate.filePath);
  const identity = database.getCatalogObject("item-identity", "i1");
  assert.equal(identity.selectedIcon, null);
  assert.equal(identity.completenessGaps.some((gap) => gap.type === "icon-gap"), true);
  const queueEntry = database.getCatalogReviewQueue().find((entry) => entry.objectId === "i1");
  assert.equal(queueEntry?.reasons.some((reason) => reason.type === "icon-gap") ?? false, false);
}));

test("identical normalized icons from different resources deduplicate by content hash", async () => withService(async ({ database, dir }) => {
  const icon = png(1, 1, { "0,0": "blue" });
  const service = new IconEvidenceService({
    database, cacheDir: path.join(dir, "cache"), concurrency: 1,
    resolveSpriteFrame: async ({ itemId }) => ({ runtimeIdentifier: itemId, resourceUrl: `https://assets.test/${itemId}.png`, mimeType: "image/png", rect: { x: 0, y: 0, width: 1, height: 1 }, originalSize: { width: 1, height: 1 }, offset: { x: 0, y: 0 } }),
    readResource: async ({ resourceUrl }) => ({ body: icon, mimeType: "image/png", resolvedUrl: resourceUrl }),
  });
  service.request("i1"); service.request("i2");
  await service.waitForIdle();
  assert.equal(database.listIconAssets().length, 1);
  assert.equal(database.listIconCandidates("i1").length, 1);
  assert.equal(database.listIconCandidates("i2").length, 1);
}));

test("identical resource and crop reuse processing across Item Identities", async () => withService(async ({ database, dir }) => {
  let reads = 0;
  const service = new IconEvidenceService({
    database, cacheDir: path.join(dir, "cache"), concurrency: 1,
    resolveSpriteFrame: async ({ itemId }) => ({ runtimeIdentifier: itemId, textureUuid: "shared", resourceUrl: "wxfile://shared.png", mimeType: "image/png", rect: { x: 0, y: 0, width: 1, height: 1 }, originalSize: { width: 1, height: 1 }, offset: { x: 0, y: 0 } }),
    readResource: async () => { reads += 1; return { body: png(1, 1, { "0,0": "blue" }), mimeType: "image/png", resolvedUrl: "wxfile://shared.png" }; },
  });
  service.request("i1");
  await service.waitForIdle();
  service.request("i2");
  await service.waitForIdle();
  assert.equal(reads, 1);
  assert.equal(database.getSelectedIconCandidate("i1").assetHash, database.getSelectedIconCandidate("i2").assetHash);
}));

test("image tasks are bounded and request returns before processing", async () => withService(async ({ database, dir }) => {
  let active = 0, maximum = 0;
  for (let index = 3; index <= 7; index += 1) database.observeCatalogObject({ objectType: "item-identity", objectId: `i${index}`, payload: { itemId: `i${index}` }, sourceType: "runtime" });
  const service = new IconEvidenceService({
    database, cacheDir: path.join(dir, "cache"), concurrency: 2,
    resolveSpriteFrame: async ({ itemId }) => ({ runtimeIdentifier: itemId, resourceUrl: `https://assets.test/${itemId}.png`, mimeType: "image/png", rect: { x: 0, y: 0, width: 1, height: 1 }, originalSize: { width: 1, height: 1 }, offset: { x: 0, y: 0 } }),
    readResource: async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 15)); active -= 1; return { body: png(1, 1, { "0,0": "yellow" }), mimeType: "image/png" }; },
  });
  const queued = ["i1", "i2", "i3", "i4", "i5", "i6", "i7"].map((itemId) => service.request(itemId));
  assert.equal(queued.every((result) => result.status === "queued"), true);
  assert.equal(active, 0);
  await service.waitForIdle();
  assert.equal(maximum, 2);
}));

test("image decoding and reconstruction yield the Node event loop to a worker", async () => withService(async ({ database, dir }) => {
  const atlas = png(512, 512, { "0,0": "yellow" });
  const service = new IconEvidenceService({
    database, cacheDir: path.join(dir, "cache"), concurrency: 1,
    resolveSpriteFrame: async () => ({ resourceUrl: "wxfile://large.png", mimeType: "image/png", rect: { x: 0, y: 0, width: 512, height: 512 }, originalSize: { width: 512, height: 512 }, offset: { x: 0, y: 0 } }),
    readResource: async () => ({ body: atlas, mimeType: "image/png", resolvedUrl: "wxfile://large.png" }),
  });
  let turns = 0, running = true;
  const countTurn = () => { turns += 1; if (running) setImmediate(countTurn); };
  setImmediate(countTurn);
  service.request("i1");
  await service.waitForIdle();
  running = false;
  assert.ok(turns > 1, `expected worker processing to leave the event loop responsive, observed ${turns} turns`);
}));

test("automation priority aborts an in-flight icon CDP task at its current boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "icon-interrupt-"));
  const database = new AutomationDatabase(path.join(root, "automation.db"));
  database.observeCatalogObject({ objectType: "item-identity", objectId: "i1", payload: { itemId: "i1" }, sourceType: "runtime" });
  let safe = true;
  const service = new IconEvidenceService({
    database,
    cacheDir: path.join(root, "cache"),
    concurrency: 1,
    isSafeBoundary: () => safe,
    resolveSpriteFrame: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("CDP command aborted"), { name: "AbortError" })), { once: true })),
  });
  try {
    service.request("i1");
    await new Promise((resolve) => setImmediate(resolve));
    safe = false;
    assert.equal(service.interruptForAutomation(), 1);
    await service.waitForIdle();
    assert.equal(service.getTask(1).status, "deferred");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("Automation Runtime acquires icons in the background without changing Active planning eligibility", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-icon-"));
  fs.mkdirSync(path.join(root, "captures"));
  fs.writeFileSync(path.join(root, "captures", "item-catalog.json"), JSON.stringify({
    chains: [{ id: "c", complete: true, minLevel: 1, maxLevel: 2, itemIds: ["i1", "i2"] }],
    items: [{ id: "i1", chainId: "c", level: 1, baseUnits: 1, mergeTarget: "i2" }, { id: "i2", chainId: "c", level: 2, baseUnits: 2, mergeTarget: null }],
    producers: [],
  }), "utf8");
  const events = [];
  const runtime = new AutomationRuntime({ rootDir: root, dataDir: path.join(root, "data"), manageConnectionRoute: false, onEvent: (event) => events.push(event) });
  let reads = 0;
  runtime.iconService.resolveSpriteFrame = async ({ itemId }) => ({ runtimeIdentifier: itemId, resourceUrl: "wxfile://icon.png", mimeType: "image/png", rect: { x: 0, y: 0, width: 1, height: 1 }, originalSize: { width: 1, height: 1 }, offset: { x: 0, y: 0 } });
  runtime.iconService.readResource = async () => { reads += 1; return { body: png(1, 1, { "0,0": "green" }), mimeType: "image/png", resolvedUrl: "wxfile://icon.png" }; };
  try {
    const planningBefore = runtime.getPlanningCatalog().items.map((item) => item.id);
    assert.equal(runtime.getCatalogObject("item-identity", "i1").selectedIcon, null);
    const queued = runtime.acquireCatalogIcon("i1");
    assert.equal(queued.status, "queued");
    assert.equal(reads, 0);
    await runtime.iconService.waitForIdle();
    assert.equal(reads, 1);
    assert.deepEqual(runtime.getPlanningCatalog().items.map((item) => item.id), planningBefore);
    assert.match(runtime.getCatalogObject("item-identity", "i1").selectedIcon.url, /^\/api\/catalog\/icon\//);
    assert.equal(runtime.getCatalogView().items.find((item) => item.id === "i1").iconUrl != null, true);
    runtime.database.observeCatalogObject({ objectType: "item-identity", objectId: "board-only", payload: { itemId: "board-only", level: 5 }, sourceType: "passive-runtime", sourceRef: "board-state", countDuplicate: false });
    runtime.queueVisibleBoardIconEvidence({ board: { grids: [{ itemId: "board-only", level: 5 }] } });
    await runtime.iconService.waitForIdle();
    assert.match(runtime.getCatalogView().iconUrls["board-only"], /^\/api\/catalog\/icon\//);
    assert.equal(events.some((event) => event.type === "icon-acquisition-complete"), true);
    runtime.running = true;
    assert.throws(() => runtime.acquireCatalogIcon("i2"), (error) => error.code === "ICON_ACQUISITION_UNSAFE_BOUNDARY");
    runtime.running = false;
    runtime.actionBoundaryPending = true;
    assert.throws(() => runtime.acquireCatalogIcon("i2"), (error) => error.code === "ICON_ACQUISITION_UNSAFE_BOUNDARY");
    runtime.actionBoundaryPending = false;
  } finally {
    await runtime.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
