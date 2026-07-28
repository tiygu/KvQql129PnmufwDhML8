"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const localLibraries = "/tmp/playwright-libs/usr/lib/x86_64-linux-gnu";
if (fs.existsSync(localLibraries)) {
  process.env.LD_LIBRARY_PATH = `${localLibraries}:${process.env.LD_LIBRARY_PATH || ""}`;
}

const { chromium } = require("playwright");
const { AutomationRuntime } = require("../src/automation-runtime");
const { createControlServer } = require("../src/control-server");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", resolve);
  });
  return server.httpServer.address().port;
}

function activateIdentity(runtime, objectId, name, level) {
  runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: {
      itemId: objectId,
      name,
      level,
      type: "flower",
      chainId: "browser-directory-chain",
    },
    sourceType: "runtime-capture",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
  runtime.catalogGate.evaluateObject("item-identity", objectId);
}

function observeIdentityPayload(runtime, objectId, payload) {
  runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: { itemId: objectId, ...payload },
    sourceType: "runtime-capture",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
}

function activateIdentityPayload(runtime, objectId, payload) {
  observeIdentityPayload(runtime, objectId, payload);
  runtime.catalogGate.evaluateObject("item-identity", objectId);
}

async function createBrowserDirectoryFixture(runtime, dataDir, viewport) {
  runtime.dashboard = async () => ({
    connected: false,
    connectionError: "browser fixture",
    running: false,
    paused: false,
    state: runtime.lastState,
    plan: { status: "ready", plans: [], recommended: null },
    catalog: runtime.getCatalogView().stats,
    catalogView: runtime.getCatalogView({ includeRepositoryObjects: false }),
    actions: [],
    sessions: [],
    resourceSamples: [],
    connectionRoute: { listening: false, managed: false },
    runtimeControl: { mocked: true },
  });
  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport });
  return {
    browser,
    page,
    port,
    server,
    async close() {
      await browser.close();
      await server.close();
      await runtime.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("Catalog Review Workspace 明确切换全部物品且只在显式选择后打开只读详情", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-item-directory-browser-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  activateIdentity(runtime, "browser-directory-one", "浏览花一", 1);
  activateIdentity(runtime, "browser-directory-two", "浏览花二", 2);
  runtime.dashboard = async () => ({
    connected: false,
    connectionError: "browser fixture",
    running: false,
    paused: false,
    state: runtime.lastState,
    plan: { status: "ready", plans: [], recommended: null },
    catalog: runtime.getCatalogView().stats,
    catalogView: runtime.getCatalogView({ includeRepositoryObjects: false }),
    actions: [],
    sessions: [],
    resourceSamples: [],
    connectionRoute: { listening: false, managed: false },
    runtimeControl: { mocked: true },
  });
  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();

    const pendingScope = page.getByRole("button", { name: /待处理/ });
    const allScope = page.getByRole("button", { name: /全部物品/ });
    await pendingScope.waitFor();
    await allScope.click();

    await page.getByText("选择物品查看只读详情").waitFor();
    assert.equal(await page.getByRole("heading", { name: "浏览花一" }).count(), 0);

    const firstItem = page.getByRole("button", { name: /浏览花一.*browser-directory-one/ });
    const secondItem = page.getByRole("button", { name: /浏览花二.*browser-directory-two/ });
    await firstItem.waitFor();
    await secondItem.waitFor();
    assert.equal(await firstItem.count(), 1);
    assert.equal(await secondItem.count(), 1);
    const directoryPayload = await page.evaluate(async () => fetch("/api/catalog/items?pageSize=200").then((response) => response.json()));
    assert.equal(await page.locator(".catalog-directory-list .panel-head > b").innerText(), String(directoryPayload.total));
    assert.equal(await firstItem.locator(".directory-row-icon.missing").count(), 1);
    assert.equal(await secondItem.locator(".directory-row-icon.missing").count(), 1);
    assert.equal(await page.getByRole("button", { name: "复制 browser-directory-one" }).count(), 1);

    await firstItem.click();
    await page.getByRole("heading", { name: "浏览花一" }).waitFor();
    await page.getByText("只读 Item Identity 详情").waitFor();
    const firstDetail = await page.evaluate(async () => fetch("/api/catalog/items/browser-directory-one").then((response) => response.json()));
    assert.equal(await page.locator(".catalog-directory-detail .panel-head small").innerText(), firstDetail.summary.itemId);
    assert.equal(await page.locator(".directory-facts").getByText(String(firstDetail.identity.effectiveFacts.level)).count(), 1);
    assert.match(page.url(), /[?&]itemId=browser-directory-one(?:&|$)/);
    assert.equal(await page.locator(".catalog-directory-detail input, .catalog-directory-detail textarea").count(), 0);

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "浏览花一" }).waitFor();

    await page.locator(".directory-relationships").getByRole("button", { name: /浏览花二/ }).click();
    await page.getByRole("heading", { name: "浏览花二" }).waitFor();
    await page.goBack();
    await page.getByRole("heading", { name: "浏览花一" }).waitFor();

    await pendingScope.click();
    await page.getByText("待裁定对象").waitFor();
    await allScope.click();
    await page.getByRole("heading", { name: "浏览花一" }).waitFor();

    const search = page.getByRole("searchbox", { name: "搜索全部物品" });
    await search.fill("browser-directory-two");
    await page.getByRole("button", { name: /浏览花二.*browser-directory-two/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /浏览花一.*browser-directory-one/ }).count(), 0);
  } finally {
    await browser.close();
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("invalid itemId deep link renders an explicit not-found selection state", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-item-not-found-browser-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const fixture = await createBrowserDirectoryFixture(
    runtime,
    dataDir,
    { width: 1280, height: 800 },
  );
  const { page, port } = fixture;

  try {
    await page.goto(`http://127.0.0.1:${port}/?itemId=deleted-item`, { waitUntil: "networkidle" });
    const notFound = page.locator("[data-selection-status=\"not-found\"]");
    await notFound.waitFor();
    await notFound.getByText("deleted-item", { exact: true }).waitFor();
    assert.match(page.url(), /[?&]itemId=deleted-item(?:&|$)/);

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("[data-selection-status=\"not-found\"]").waitFor();
  } finally {
    await fixture.close();
  }
});

test("complete-directory controls preserve server order and restore pending query state after search", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-item-search-browser-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  activateIdentityPayload(runtime, "aurora", {
    name: "Different Name",
    level: null,
    type: "generator",
    chainId: null,
  });
  activateIdentityPayload(runtime, "rank-prefix", {
    name: "Aurora Bloom",
    level: 2,
    type: "flower",
    chainId: "rank-chain",
  });
  activateIdentityPayload(runtime, "rank-substring", {
    name: "Night Aurora",
    level: 1,
    type: "flower",
    chainId: "other-chain",
  });
  for (let index = 0; index < 205; index += 1) {
    const suffix = String(index).padStart(3, "0");
    observeIdentityPayload(runtime, `filler-${suffix}`, {
      name: `Filler ${suffix}`,
      level: 1,
      type: "filler",
      chainId: "filler-chain",
    });
  }
  runtime.dashboard = async () => ({
    connected: false,
    connectionError: "browser fixture",
    running: false,
    paused: false,
    state: runtime.lastState,
    plan: { status: "ready", plans: [], recommended: null },
    catalog: runtime.getCatalogView().stats,
    catalogView: runtime.getCatalogView({ includeRepositoryObjects: false }),
    actions: [],
    sessions: [],
    resourceSamples: [],
    connectionRoute: { listening: false, managed: false },
    runtimeControl: { mocked: true },
  });
  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "图鉴" }).click();

    const pendingScope = page.getByRole("button", { name: /待处理/ });
    const allScope = page.getByRole("button", { name: /全部物品/ });
    const search = page.getByRole("searchbox", { name: "搜索全部物品" });
    const sort = page.getByLabel("目录排序");
    const direction = page.getByLabel("排序方向");
    const itemType = page.getByLabel("物品类型筛选");

    await allScope.click();
    await sort.selectOption("chain-level");
    await direction.selectOption("desc");
    await itemType.fill("flower, generator");
    await pendingScope.click();
    assert.match(await pendingScope.getAttribute("class") || "", /active/);

    await search.fill("aurora");
    await page.getByRole("button", { name: /Different Name.*aurora/ }).waitFor();
    assert.equal(await sort.inputValue(), "relevance");
    assert.equal(await direction.inputValue(), "asc");
    const serverSearch = await page.evaluate(async () =>
      fetch("/api/catalog/items?q=aurora&sort=relevance&direction=asc&itemType=flower&itemType=generator&pageSize=200")
        .then((response) => response.json()));
    const renderedSearchIds = await page.locator(".catalog-directory-list .directory-copy-id")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("title")));
    assert.deepEqual(renderedSearchIds, serverSearch.items.map((item) => item.itemId));
    assert.equal(await page.getByText("匹配：Item ID").count(), 1);

    await itemType.fill("flower");
    await search.fill("");
    assert.match(await pendingScope.getAttribute("class") || "", /active/);
    assert.equal(await sort.inputValue(), "chain-level");
    assert.equal(await direction.inputValue(), "desc");
    assert.equal(await itemType.inputValue(), "flower, generator");

    await allScope.click();
    const serverFiltered = await page.evaluate(async () =>
      fetch("/api/catalog/items?sort=chain-level&direction=desc&itemType=flower&itemType=generator&pageSize=200")
        .then((response) => response.json()));
    await page.getByRole("button", { name: /Aurora Bloom.*rank-prefix/ }).waitFor();
    const renderedFilteredIds = await page.locator(".catalog-directory-list .directory-copy-id")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("title")));
    assert.deepEqual(renderedFilteredIds, serverFiltered.items.map((item) => item.itemId));

    await itemType.fill("");
    const loadMore = page.getByRole("button", { name: "加载更多" });
    await loadMore.waitFor();
    let releaseLoadMore;
    const loadMoreGate = new Promise((resolve) => { releaseLoadMore = resolve; });
    await page.route("**/api/catalog/items?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.searchParams.has("cursor")) await loadMoreGate;
      await route.continue();
    });
    await loadMore.click();
    await itemType.fill("not-a-type");
    await page.getByText("没有符合条件的 Item Identity").waitFor();
    releaseLoadMore();
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".catalog-directory-list .directory-copy-id").count(), 0);
  } finally {
    await browser.close();
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("relationship history restores query, pagination, list scroll, and keyboard focus", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-item-history-browser-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  activateIdentityPayload(runtime, "history-origin", {
    name: "History Item Origin",
    level: 1,
    type: "flower",
    chainId: "history-chain",
  });
  activateIdentityPayload(runtime, "history-target", {
    name: "History Item Target",
    level: 2,
    type: "generator",
    chainId: "history-chain",
  });
  activateIdentityPayload(runtime, "history-late", {
    name: "ZZZ History Item Late",
    level: 3,
    type: "flower",
    chainId: "history-chain",
  });
  for (let index = 0; index < 205; index += 1) {
    const suffix = String(index).padStart(3, "0");
    observeIdentityPayload(runtime, `history-filler-${suffix}`, {
      name: `History Item Filler ${suffix}`,
      level: 1,
      type: "flower",
      chainId: `history-filler-chain-${suffix}`,
    });
  }
  const fixture = await createBrowserDirectoryFixture(
    runtime,
    dataDir,
    { width: 1280, height: 900 },
  );
  const { page, port, server } = fixture;

  try {
    await page.goto(`http://127.0.0.1:${port}/?itemId=history-origin`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "History Item Origin" }).waitFor();

    const lateRelation = page.getByRole("button", { name: /ZZZ History Item Late/ });
    await lateRelation.click();
    await page.getByRole("heading", { name: "ZZZ History Item Late" }).waitFor();
    assert.equal(await page.locator("[data-selection-status=\"out-of-results\"]").count(), 0);
    await page.goBack();
    await page.getByRole("heading", { name: "History Item Origin" }).waitFor();

    const search = page.locator(".catalog-directory-toolbar input[type=search]");
    const sort = page.locator(".catalog-directory-query-controls select").filter({ has: page.locator("option[value=\"chain-level\"]") });
    const direction = page.locator(".catalog-directory-query-controls select[aria-label=\"排序方向\"]");
    const itemType = page.locator(".catalog-directory-query-controls input[aria-label=\"物品类型筛选\"]");
    await search.fill("item");
    await sort.selectOption("chain-level");
    await direction.selectOption("desc");
    await itemType.fill("flower");

    const loadMore = page.locator(".directory-load-more");
    await loadMore.waitFor();
    await loadMore.click();
    await page.locator(".catalog-directory-list .directory-copy-id[title=\"history-origin\"]").waitFor();
    assert.equal(await page.locator(".catalog-directory-list .directory-copy-id").count(), 207);

    const list = page.locator(".catalog-directory-list .review-queue-list");
    await list.evaluate((element) => { element.scrollTop = 200; });
    server.broadcast({
      type: "control-connected",
      catalogQueryRevision: runtime.getCatalogQueryRevision(),
    });
    await page.waitForTimeout(50);
    await list.evaluate((element) => { element.scrollTop = 320; });
    const originalScrollTop = await list.evaluate((element) => element.scrollTop);

    activateIdentityPayload(runtime, "history-refresh", {
      name: "History Item Refresh",
      level: 1,
      type: "flower",
      chainId: "history-refresh-chain",
    });
    server.broadcast({ type: "catalog-test-tick" });
    await page.locator(".catalog-directory-list .directory-copy-id[title=\"history-refresh\"]").waitFor();
    assert.equal(await list.evaluate((element) => element.scrollTop), originalScrollTop);

    const relationTarget = page.getByRole("button", { name: /History Item Target/ });
    await relationTarget.focus();
    await relationTarget.press("Enter");
    const targetHeading = page.getByRole("heading", { name: "History Item Target" });
    await targetHeading.waitFor();
    await page.locator("[data-selection-status=\"out-of-results\"]").waitFor();
    assert.equal(await page.locator(".catalog-directory-detail input, .catalog-directory-detail textarea").count(), 0);
    assert.equal(await targetHeading.evaluate((element) => element === document.activeElement), true);
    assert.equal(await list.evaluate((element) => element.scrollTop), originalScrollTop);

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "History Item Target" }).waitFor();
    await page.locator("[data-selection-status=\"out-of-results\"]").waitFor();

    await page.goBack();
    await page.getByRole("heading", { name: "History Item Origin" }).waitFor();
    assert.equal(await search.inputValue(), "item");
    assert.equal(await sort.inputValue(), "chain-level");
    assert.equal(await direction.inputValue(), "desc");
    assert.equal(await itemType.inputValue(), "flower");
    assert.equal(await page.locator(".catalog-directory-list .directory-copy-id").count(), 208);
    assert.equal(await list.evaluate((element) => element.scrollTop), originalScrollTop);
    assert.equal(await relationTarget.evaluate((element) => element === document.activeElement), true);
  } finally {
    await fixture.close();
  }
});

test("two consoles keep independent directory views and converge on a published query revision", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-item-directory-multi-console-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  activateIdentity(runtime, "console-alpha-one", "Console Alpha One", 1);
  activateIdentity(runtime, "console-beta-one", "Console Beta One", 1);
  runtime.dashboard = async () => ({
    connected: false,
    connectionError: "browser fixture",
    running: false,
    paused: false,
    state: runtime.lastState,
    plan: { status: "ready", plans: [], recommended: null },
    catalog: runtime.getCatalogView().stats,
    catalogView: runtime.getCatalogView({ includeRepositoryObjects: false }),
    actions: [],
    sessions: [],
    resourceSamples: [],
    connectionRoute: { listening: false, managed: false },
    runtimeControl: { mocked: true },
  });
  const server = createControlServer({
    runtime,
    publicRoot: path.join(__dirname, "..", "public"),
    dataDir,
  });
  const port = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const alphaPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const betaPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let betaQueryRequests = 0;
  betaPage.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/catalog/items") betaQueryRequests += 1;
  });

  try {
    await Promise.all([
      alphaPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" }),
      betaPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" }),
    ]);
    await Promise.all([
      alphaPage.getByRole("button", { name: "图鉴" }).click(),
      betaPage.getByRole("button", { name: "图鉴" }).click(),
    ]);
    await Promise.all([
      alphaPage.getByRole("button", { name: /全部物品/ }).click(),
      betaPage.getByRole("button", { name: /全部物品/ }).click(),
    ]);

    const alphaSearch = alphaPage.getByRole("searchbox", { name: "搜索全部物品" });
    const betaSearch = betaPage.getByRole("searchbox", { name: "搜索全部物品" });
    await alphaSearch.fill("console-alpha");
    await betaSearch.fill("console-beta");
    await alphaPage.getByRole("button", { name: /Console Alpha One.*console-alpha-one/ }).waitFor();
    await betaPage.getByRole("button", { name: /Console Beta One.*console-beta-one/ }).waitFor();
    const betaRequestsBeforeUpdate = betaQueryRequests;

    activateIdentity(runtime, "console-alpha-two", "Console Alpha Two", 2);
    server.broadcast({ type: "catalog-test-tick" });

    await alphaPage.getByRole("button", { name: /Console Alpha Two.*console-alpha-two/ }).waitFor();
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const check = () => {
        if (betaQueryRequests > betaRequestsBeforeUpdate) return resolve();
        if (Date.now() >= deadline) return reject(new Error("second console did not reconcile"));
        setTimeout(check, 20);
      };
      check();
    });
    assert.equal(await alphaSearch.inputValue(), "console-alpha");
    assert.equal(await betaSearch.inputValue(), "console-beta");
    assert.equal(await alphaPage.locator(".catalog-directory-list .directory-copy-id").count(), 2);
    assert.equal(await betaPage.locator(".catalog-directory-list .directory-copy-id").count(), 1);
  } finally {
    await browser.close();
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
