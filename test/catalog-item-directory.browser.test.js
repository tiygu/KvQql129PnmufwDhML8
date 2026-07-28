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
