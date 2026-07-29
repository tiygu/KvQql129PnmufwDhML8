"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const localLibraries = "/tmp/playwright-libs/usr/lib/x86_64-linux-gnu";
if (fs.existsSync(localLibraries)) {
  process.env.LD_LIBRARY_PATH = `${localLibraries}:${process.env.LD_LIBRARY_PATH || ""}`;
}
const { chromium } = require("playwright");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

function json(response, payload) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function dashboard() {
  return {
    connected: true,
    running: false,
    paused: false,
    connectionRoute: { listening: true, managed: false },
    state: {
      scene: "board",
      resources: { coins: 0, diamonds: 0, energy: 20 },
      energy: { amount: 20, limit: 100 },
      board: {
        width: 1,
        height: 1,
        occupied: 0,
        empty: 1,
        grids: [],
        mergeCandidates: [],
        requiredItemCounts: {},
      },
      orders: [],
      producers: [],
      mapMission: null,
      mapProgress: {},
      overlays: [],
    },
    plan: { status: "ready", plans: [], recommended: null },
    catalog: { chains: 0, items: 0, producers: 0, drops: 0 },
    catalogView: {
      chains: [],
      items: [],
      producers: [],
      repository: { summary: { states: { observed: 0, provisional: 0, active: 0 } }, objects: [] },
    },
    actions: [],
    resourceSamples: [],
  };
}

function createFixtureServer() {
  let releaseDashboard;
  let startRequested = false;
  let dashboardRequests = 0;
  const dashboardPending = new Promise((resolve) => { releaseDashboard = resolve; });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/dashboard") {
      dashboardRequests += 1;
      await dashboardPending;
      return json(response, dashboard());
    }
    if (url.pathname === "/api/catalog") {
      return json(response, {
        stats: { chains: 0, items: 0, producers: 0, drops: 0 },
        chains: [],
        items: [],
        producers: [],
        repository: { summary: { states: { observed: 0, provisional: 0, active: 0 } }, objects: [] },
      });
    }
    if (url.pathname === "/api/connection") {
      return json(response, { listening: true, managed: false });
    }
    if (url.pathname === "/api/settings") {
      return json(response, {
        mode: "automatic",
        delayMs: 100,
        settleMs: 500,
        autoMapUpgrade: false,
        strategy: "efficiency",
        prioritySlot: null,
        fontScale: 1.1,
      });
    }
    if (url.pathname === "/api/automation/start") {
      startRequested = true;
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const filePath = path.join(publicDir, relativePath);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      return response.end();
    }
    const contentType = filePath.endsWith(".js")
      ? "text/javascript"
      : filePath.endsWith(".css")
        ? "text/css"
        : "text/html";
    response.writeHead(200, { "content-type": contentType });
    response.end(fs.readFileSync(filePath));
  });

  return {
    server,
    releaseStaleDashboard: () => releaseDashboard(),
    startRequested: () => startRequested,
    dashboardRequests: () => dashboardRequests,
  };
}

test("过期仪表盘响应不会覆盖点击后的自动化启动态", async () => {
  const fixture = createFixtureServer();
  await new Promise((resolve, reject) => {
    fixture.server.once("error", reject);
    fixture.server.listen(0, "127.0.0.1", resolve);
  });
  const port = fixture.server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    const startButton = page.getByRole("button", { name: "开始自动化" });
    await startButton.waitFor();
    await startButton.click();
    await page.locator(".run-btn", { hasText: "暂停自动化" }).waitFor();
    assert.equal(fixture.startRequested(), true);

    fixture.releaseStaleDashboard();
    await page.waitForTimeout(50);

    const launchButton = page.locator(".run-btn");
    assert.equal(await launchButton.textContent(), "暂停自动化");
    assert.match(await launchButton.getAttribute("class"), /\bstop\b/);
  } finally {
    await browser.close();
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test("dashboard polling coalesces while a prior refresh is still pending", async () => {
  const fixture = createFixtureServer();
  await new Promise((resolve, reject) => {
    fixture.server.once("error", reject);
    fixture.server.listen(0, "127.0.0.1", resolve);
  });
  const port = fixture.server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForTimeout(8500);
    assert.equal(fixture.dashboardRequests(), 1);

    fixture.releaseStaleDashboard();
    await page.waitForTimeout(100);
    assert.equal(fixture.dashboardRequests(), 2);
  } finally {
    await browser.close();
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});
