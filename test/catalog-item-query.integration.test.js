"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { AutomationRuntime } = require("../src/automation-runtime");
const { createControlServer } = require("../src/control-server");
const { CatalogItemQuery } = require("../src/catalog-item-query");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", resolve);
  });
  return server.httpServer.address().port;
}

function waitForWebSocketEvent(client, type, label = type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.off("message", onMessage);
      client.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (raw) => {
      let event;
      try {
        event = JSON.parse(String(raw));
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (event.type !== type) return;
      cleanup();
      resolve(event);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timeout`));
    }, 2000);
    client.on("message", onMessage);
    client.on("error", onError);
  });
}

function observeIdentity(runtime, objectId, payload, sourceRef = `${objectId}.json`) {
  return runtime.database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload,
    sourceType: "runtime-capture",
    sourceRef,
    countDuplicate: false,
  });
}

function activateIdentity(runtime, objectId, payload) {
  observeIdentity(runtime, objectId, payload);
  return runtime.catalogGate.evaluateObject("item-identity", objectId);
}

function provisionalIdentity(runtime, objectId, payload) {
  const observed = observeIdentity(runtime, objectId, payload);
  return runtime.database.saveCatalogVersion({
    objectType: "item-identity",
    objectId,
    payload,
    status: "provisional",
    origin: "inference-gate",
    expectedRevision: observed.revision,
  });
}

async function withFixture(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-item-query-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const server = createControlServer({
    runtime,
    publicRoot: path.join(dataDir, "public"),
    dataDir,
  });
  const port = await listen(server);
  try {
    await run({ runtime, server, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("完整物品目录通过真实控制服务恰好投影每个 Item Identity 一次", async () => {
  await withFixture(async ({ runtime, baseUrl }) => {
    activateIdentity(runtime, "directory-active", {
      itemId: "directory-active",
      name: "确认花",
      level: 3,
      type: "flower",
      chainId: "directory-chain",
    });
    provisionalIdentity(runtime, "directory-pending", {
      itemId: "directory-pending",
      name: "候选花",
      level: 2,
      type: "flower",
      chainId: "directory-chain",
    });
    const unnamed = activateIdentity(runtime, "directory-unnamed", {
      itemId: "directory-unnamed",
      name: " ",
      level: null,
      type: "",
      chainId: null,
    });
    runtime.database.setCatalogObjectDisposition(
      "item-identity",
      "directory-unnamed",
      "paused",
      { reason: "directory-fixture", expectedRevision: unnamed.revision },
    );

    const legacyBefore = await fetch(`${baseUrl}/api/catalog`).then((response) => response.json());
    const response = await fetch(`${baseUrl}/api/catalog/items?pageSize=200`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();

    const expectedIds = runtime.database.listCatalogObjects({ objectType: "item-identity" })
      .map((entry) => entry.objectId);
    assert.equal(body.total, expectedIds.length);
    assert.equal(body.returnedCount, expectedIds.length);
    assert.equal(body.hasMore, false);
    assert.equal(body.nextCursor, null);
    assert.equal(typeof body.catalogQueryRevision, "string");
    assert.equal(new Set(body.items.map((item) => item.itemId)).size, expectedIds.length);
    assert.deepEqual(body.items.map((item) => item.itemId).sort(), expectedIds.sort());

    const active = body.items.find((item) => item.itemId === "directory-active");
    assert.deepEqual(active, {
      itemId: "directory-active",
      displayTitle: "确认花",
      displayTitleSource: "candidate-name",
      identity: {
        confirmedName: null,
        candidateName: "确认花",
        level: 3,
        itemType: "flower",
        mergeChainId: "directory-chain",
        chainPosition: 3,
      },
      displayIcon: {
        state: "missing",
        freshness: "missing",
        selectedCandidateId: null,
        url: null,
      },
      catalogState: {
        status: "active",
        disposition: "enabled",
      },
      review: {
        status: "clear",
        action: null,
        reasonCount: 0,
      },
      matchedFields: [],
      detailUrl: "/api/catalog/items/directory-active",
      updatedAt: active.updatedAt,
    });

    const unnamedSummary = body.items.find((item) => item.itemId === "directory-unnamed");
    assert.equal(unnamedSummary.displayTitle, "未命名物品");
    assert.equal(unnamedSummary.displayTitleSource, "presentation-fallback");
    assert.equal(unnamedSummary.identity.confirmedName, null);
    assert.equal(unnamedSummary.identity.candidateName, null);
    assert.equal(unnamedSummary.identity.level, null);
    assert.equal(unnamedSummary.identity.itemType, null);
    assert.equal(unnamedSummary.identity.mergeChainId, null);
    assert.equal(unnamedSummary.catalogState.disposition, "paused");

    const pending = body.items.find((item) => item.itemId === "directory-pending");
    assert.equal(pending.review.status, "needs-review");
    assert.equal(pending.review.action, "review");

    const legacyAfter = await fetch(`${baseUrl}/api/catalog`).then((response) => response.json());
    assert.deepEqual(legacyAfter, legacyBefore);
  });
});

test("Item Identity detail separates icon currency, selection, lineage, assets, and audited decisions", async () => {
  await withFixture(async ({ runtime, baseUrl }) => {
    activateIdentity(runtime, "display-icon-detail", {
      itemId: "display-icon-detail",
      name: "Display Icon Detail",
      level: 4,
      type: "flower",
      chainId: "display-icon-chain",
    });
    const iconRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-item-icon-detail-"));
    const writeCandidate = (name, contents) => {
      const filePath = path.join(iconRoot, `${name}.png`);
      fs.writeFileSync(filePath, contents);
      return filePath;
    };
    const saveCandidate = ({
      cacheKey,
      sourceType,
      hash,
      rankScore,
      filePath,
    }) => runtime.database.saveIconCandidate({
      itemId: "display-icon-detail",
      cacheKey,
      sourceType,
      autoSelect: false,
      rankScore,
      asset: {
        hash,
        mimeType: "image/png",
        width: 2,
        height: 3,
        byteSize: fs.statSync(filePath).size,
        filePath,
      },
    });

    try {
      const current = saveCandidate({
        cacheKey: "current-candidate",
        sourceType: "user-upload",
        hash: "a".repeat(64),
        rankScore: 9,
        filePath: writeCandidate("current", "current"),
      });
      const stale = saveCandidate({
        cacheKey: "stale-candidate",
        sourceType: "unknown-legacy-source",
        hash: "b".repeat(64),
        rankScore: 20,
        filePath: writeCandidate("stale", "stale"),
      });
      const predecessor = saveCandidate({
        cacheKey: "superseded-candidate",
        sourceType: "user-upload",
        hash: "c".repeat(64),
        rankScore: 30,
        filePath: writeCandidate("superseded", "superseded"),
      });
      runtime.database.db.prepare(`INSERT INTO catalog_icon_candidate_lineage(
        predecessor_candidate_id,successor_candidate_id,relation,reason,created_at
      ) VALUES(?,?,?,?,?)`).run(
        predecessor.id,
        current.id,
        "replaced-by",
        "operator chose the clearer source",
        new Date().toISOString(),
      );

      const unconfirmedResponse = await fetch(`${baseUrl}/api/catalog/icon/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectId: "display-icon-detail",
          candidateId: stale.id,
          actor: "detail-operator",
          note: "historical candidate is the recognizable icon",
          expectedDisplayIconRevision: 1,
        }),
      });
      assert.equal(unconfirmedResponse.status, 409);
      assert.equal((await unconfirmedResponse.json()).code, "STALE_ICON_CONFIRMATION_REQUIRED");
      assert.equal(runtime.database.getCatalogObject(
        "item-identity",
        "display-icon-detail",
      ).displayIcon.revision, 1);

      const selectedResponse = await fetch(`${baseUrl}/api/catalog/icon/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectId: "display-icon-detail",
          candidateId: stale.id,
          actor: "detail-operator",
          note: "historical candidate is the recognizable icon",
          expectedDisplayIconRevision: 1,
          confirmStale: true,
        }),
      });
      assert.equal(selectedResponse.status, 200);
      fs.rmSync(stale.filePath);

      const selectedDetail = await fetch(
        `${baseUrl}/api/catalog/items/display-icon-detail`,
      ).then((response) => response.json());
      assert.equal(selectedDetail.displayIcon.selection.revision, 2);
      assert.equal(selectedDetail.displayIcon.selection.manualProtection, true);
      assert.equal(selectedDetail.displayIcon.candidates.currentDisplay[0].candidateId, stale.id);
      assert.equal(selectedDetail.displayIcon.candidates.currentDisplay[0].currency.status, "stale");
      assert.equal(selectedDetail.displayIcon.candidates.currentDisplay[0].selection.origin, "manual");
      assert.equal(selectedDetail.displayIcon.candidates.currentDisplay[0].lineage.status, "retained");
      assert.equal(selectedDetail.displayIcon.candidates.currentDisplay[0].asset.available, false);
      assert.deepEqual(
        selectedDetail.displayIcon.candidates.eligible.map((candidate) => candidate.candidateId),
        [current.id],
      );
      assert.deepEqual(
        selectedDetail.displayIcon.candidates.historical.map((candidate) => candidate.candidateId),
        [predecessor.id],
      );
      assert.deepEqual(
        selectedDetail.displayIcon.candidates.historical[0].lineage.replacedByCandidateIds,
        [current.id],
      );
      assert.equal(selectedDetail.displayIcon.candidates.historical[0].currency.status, "current");
      assert.equal(
        selectedDetail.displayIcon.candidates.historical[0].lineage.status,
        "superseded",
      );
      assert.equal(
        selectedDetail.displayIcon.candidates.historical[0].technical.assetHash,
        "c".repeat(64),
      );

      const revokedResponse = await fetch(`${baseUrl}/api/catalog/icon/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectId: "display-icon-detail",
          actor: "detail-operator",
          note: "protect an intentionally empty display",
          expectedDisplayIconRevision: 2,
        }),
      });
      assert.equal(revokedResponse.status, 200);
      const revoked = await revokedResponse.json();
      assert.equal(revoked.displayIcon.protectedEmpty, true);

      const automaticResponse = await fetch(`${baseUrl}/api/catalog/icon/automatic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectId: "display-icon-detail",
          actor: "detail-operator",
          note: "return display choice to automatic control",
          expectedDisplayIconRevision: 3,
        }),
      });
      assert.equal(automaticResponse.status, 200);
      const automatic = await automaticResponse.json();
      assert.equal(automatic.displayIcon.revision, 4);
      assert.equal(automatic.displayIcon.selectedCandidate.id, current.id);
      assert.equal(automatic.displayIcon.selectionOrigin, "automatic");

      const finalDetail = await fetch(
        `${baseUrl}/api/catalog/items/display-icon-detail`,
      ).then((response) => response.json());
      assert.deepEqual(
        finalDetail.displayIcon.selectionHistory.map((entry) => ({
          action: entry.action,
          actor: entry.actor,
          previousCandidateId: entry.previousCandidateId,
          candidateId: entry.candidateId,
          revision: entry.revision,
        })),
        [
          {
            action: "manual-select-stale-confirmed",
            actor: "detail-operator",
            previousCandidateId: null,
            candidateId: stale.id,
            revision: 2,
          },
          {
            action: "manual-revoke",
            actor: "detail-operator",
            previousCandidateId: stale.id,
            candidateId: null,
            revision: 3,
          },
          {
            action: "automatic-control-return",
            actor: "detail-operator",
            previousCandidateId: null,
            candidateId: current.id,
            revision: 4,
          },
        ],
      );
    } finally {
      fs.rmSync(iconRoot, { recursive: true, force: true });
    }
  });
});

test("物品目录搜索、游标和只读详情保持同一 Catalog Query Revision", async () => {
  await withFixture(async ({ runtime, baseUrl }) => {
    activateIdentity(runtime, "directory-search-a", {
      itemId: "directory-search-a",
      name: "星光花",
      level: 1,
      type: "flower",
      chainId: "search-chain",
      iconResourceIdentifier: "legacy-star-icon",
    });
    observeIdentity(runtime, "directory-search-a", {
      itemId: "directory-search-a",
      name: "星光花",
      level: 1,
      type: "flower",
      chainId: "search-chain",
      iconResourceIdentifier: "current-star-icon",
    }, "directory-search-a-current.json");
    runtime.catalogGate.evaluateObject("item-identity", "directory-search-a");
    activateIdentity(runtime, "directory-search-b", {
      itemId: "directory-search-b",
      name: "星光花束",
      level: 2,
      type: "flower",
      chainId: "search-chain",
    });
    activateIdentity(runtime, "directory-search-null", {
      itemId: "directory-search-null",
      name: "无链目录项",
      level: null,
      type: "flower",
      chainId: null,
    });

    const firstResponse = await fetch(`${baseUrl}/api/catalog/items?q=%E6%98%9F%E5%85%89%E8%8A%B1&pageSize=1`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.total, 2);
    assert.equal(first.returnedCount, 1);
    assert.equal(first.hasMore, true);
    assert.equal(typeof first.nextCursor, "string");
    assert.equal(first.items[0].itemId, "directory-search-a");
    assert.deepEqual(first.items[0].matchedFields, ["candidateName"]);

    const secondResponse = await fetch(`${baseUrl}/api/catalog/items?q=%E6%98%9F%E5%85%89%E8%8A%B1&pageSize=1&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.catalogQueryRevision, first.catalogQueryRevision);
    assert.equal(second.items[0].itemId, "directory-search-b");

    const historical = await fetch(`${baseUrl}/api/catalog/items?q=legacy-star-icon`);
    assert.equal(historical.status, 200);
    const historicalPayload = await historical.json();
    assert.equal(historicalPayload.items[0].itemId, "directory-search-a");
    assert.deepEqual(historicalPayload.items[0].matchedFields, ["historicalIconIdentifier"]);

    const descending = await fetch(`${baseUrl}/api/catalog/items?sort=chain-level&direction=desc&pageSize=200`)
      .then((response) => response.json());
    assert.ok(
      descending.items.findIndex((item) => item.itemId === "directory-search-a")
      < descending.items.findIndex((item) => item.itemId === "directory-search-null"),
    );

    const detailResponse = await fetch(`${baseUrl}${first.items[0].detailUrl}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.catalogQueryRevision, first.catalogQueryRevision);
    assert.deepEqual(detail.summary, { ...first.items[0], matchedFields: [] });
    assert.equal(detail.readOnly, true);
    assert.equal(detail.identity.itemId, "directory-search-a");
    assert.deepEqual(detail.capabilities, {
      canView: true,
      canEnterSemanticReview: false,
      semanticReviewUrl: null,
    });
    assert.equal(Array.isArray(detail.relationships.mergeChain.members), true);

    const unknown = await fetch(`${baseUrl}/api/catalog/items/not-present`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), {
      ok: false,
      error: "catalog-item-not-found",
      code: "CATALOG_ITEM_NOT_FOUND",
      itemId: "not-present",
    });

    const mismatch = await fetch(`${baseUrl}/api/catalog/items?q=different&pageSize=1&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).code, "CATALOG_CURSOR_MISMATCH");

    const decodedCursor = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
    const tamperedCursor = Buffer.from(JSON.stringify({
      ...decodedCursor,
      orderingTuple: ["tampered-ordering-value"],
    })).toString("base64url");
    const tampered = await fetch(`${baseUrl}/api/catalog/items?q=%E6%98%9F%E5%85%89%E8%8A%B1&pageSize=1&cursor=${encodeURIComponent(tamperedCursor)}`);
    assert.equal(tampered.status, 400);
    assert.equal((await tampered.json()).code, "CATALOG_CURSOR_MISMATCH");

    const observed = observeIdentity(runtime, "directory-revision-new", {
      itemId: "directory-revision-new",
      name: "新目录项",
      level: 1,
    });
    assert.ok(observed);
    const stale = await fetch(`${baseUrl}/api/catalog/items?q=%E6%98%9F%E5%85%89%E8%8A%B1&pageSize=1&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(stale.status, 409);
    const stalePayload = await stale.json();
    assert.equal(stalePayload.code, "CATALOG_QUERY_REVISION_CHANGED");
    assert.notEqual(stalePayload.catalogQueryRevision, first.catalogQueryRevision);

    const restartedQuery = new CatalogItemQuery(runtime.database);
    assert.notEqual(restartedQuery.list({ query: "星光花", pageSize: 1 }).catalogQueryRevision, first.catalogQueryRevision);
  });
});

test("目录上下文请求在 Node 侧恢复分页深度并判定已选项是否仍在结果集", async () => {
  await withFixture(async ({ runtime, baseUrl }) => {
    for (let index = 0; index < 5; index += 1) {
      activateIdentity(runtime, `context-item-${index}`, {
        itemId: `context-item-${index}`,
        name: `Context Item ${index}`,
        level: index + 1,
        type: index === 4 ? "generator" : "flower",
        chainId: "context-chain",
      });
    }

    const expanded = await fetch(
      `${baseUrl}/api/catalog/items?q=context-item&pageSize=2&loadedCount=5&selectedItemId=context-item-4`,
    ).then((response) => response.json());
    assert.equal(expanded.returnedCount, 5);
    assert.equal(expanded.items.length, 5);
    assert.equal(expanded.hasMore, false);
    assert.equal(expanded.selectionInResults, true);

    const firstPage = await fetch(
      `${baseUrl}/api/catalog/items?q=context-item&pageSize=2&selectedItemId=context-item-4`,
    ).then((response) => response.json());
    assert.equal(firstPage.items.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.selectionInResults, true);

    const excluded = await fetch(
      `${baseUrl}/api/catalog/items?q=context-item&pageSize=2&itemType=flower&selectedItemId=context-item-4`,
    ).then((response) => response.json());
    assert.equal(excluded.selectionInResults, false);
  });
});

test("目录查询公开默认与最大 page size 并拒绝越界值", async () => {
  await withFixture(async ({ runtime, baseUrl }) => {
    const baselineTotal = runtime.listCatalogItems({ pageSize: 200 }).total;
    for (let index = 0; index < 51; index += 1) {
      activateIdentity(runtime, `page-size-${String(index).padStart(2, "0")}`, {
        itemId: `page-size-${String(index).padStart(2, "0")}`,
        name: `Page Size ${String(index).padStart(2, "0")}`,
        level: 1,
        type: "fixture",
      });
    }

    const defaultResponse = await fetch(`${baseUrl}/api/catalog/items`);
    assert.equal(defaultResponse.status, 200);
    const defaultPage = await defaultResponse.json();
    assert.equal(defaultPage.pageSize, 50);
    assert.equal(defaultPage.total, baselineTotal + 51);
    assert.equal(defaultPage.returnedCount, 50);
    assert.equal(defaultPage.hasMore, true);
    assert.equal(typeof defaultPage.nextCursor, "string");

    const maximumResponse = await fetch(`${baseUrl}/api/catalog/items?pageSize=200`);
    assert.equal(maximumResponse.status, 200);
    assert.equal((await maximumResponse.json()).pageSize, 200);

    const oversizedResponse = await fetch(`${baseUrl}/api/catalog/items?pageSize=201`);
    assert.equal(oversizedResponse.status, 400);
    assert.deepEqual(await oversizedResponse.json(), {
      ok: false,
      error: "catalog-query-invalid-page-size",
      code: "CATALOG_QUERY_INVALID_PAGE_SIZE",
      minimum: 1,
      maximum: 200,
    });
  });
});

test("目录游标绑定规范化筛选而不是筛选参数的传输顺序", async () => {
  await withFixture(async ({ runtime, baseUrl }) => {
    for (const [itemId, level] of [
      ["normalized-filter-a", 1],
      ["normalized-filter-b", 2],
      ["normalized-filter-c", 1],
    ]) {
      activateIdentity(runtime, itemId, {
        itemId,
        name: itemId,
        level,
        type: "flower",
      });
    }

    const firstResponse = await fetch(
      `${baseUrl}/api/catalog/items?q=normalized-filter&level=1&level=2&pageSize=1`,
    );
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.hasMore, true);

    const secondResponse = await fetch(
      `${baseUrl}/api/catalog/items?q=normalized-filter&level=2&level=1&level=1&pageSize=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.catalogQueryRevision, first.catalogQueryRevision);
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0].itemId, first.items[0].itemId);
  });
});

test("Catalog Query Revision 只随完整物品目录投影变化", async () => {
  await withFixture(async ({ runtime }) => {
    activateIdentity(runtime, "revision-projection-item", {
      itemId: "revision-projection-item",
      name: "Revision Projection Item",
      level: 1,
      type: "flower",
    });
    const before = runtime.listCatalogItems();
    const recreated = new CatalogItemQuery(runtime.database).list();
    assert.equal(recreated.catalogQueryRevision, before.catalogQueryRevision);

    runtime.database.observeCatalogObject({
      objectType: "production-profile",
      objectId: "revision-unrelated-producer",
      payload: {
        producerItemId: "revision-unrelated-producer",
        energyCost: 1,
        drops: [],
      },
      sourceType: "runtime-capture",
      sourceRef: "revision-unrelated-producer.json",
      countDuplicate: false,
    });

    const after = runtime.listCatalogItems();
    assert.equal(after.catalogQueryRevision, before.catalogQueryRevision);
    assert.deepEqual(after.items, before.items);
  });
});

test("每个控制台通过 WebSocket 收到 Catalog Query Revision 更新并在重连时取得当前 revision", async () => {
  await withFixture(async ({ runtime, server, baseUrl }) => {
    const item = activateIdentity(runtime, "revision-websocket-item", {
      itemId: "revision-websocket-item",
      name: "Revision WebSocket Item",
      level: 1,
      type: "flower",
    });
    const initialRevision = runtime.listCatalogItems().catalogQueryRevision;
    const websocketUrl = `${baseUrl.replace("http:", "ws:")}/ws`;
    const clients = [new WebSocket(websocketUrl), new WebSocket(websocketUrl)];

    try {
      const connected = clients.map((client) =>
        waitForWebSocketEvent(client, "control-connected"));
      await Promise.all(clients.map((client) => new Promise((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      })));
      const connectionEvents = await Promise.all(connected);
      assert.deepEqual(
        connectionEvents.map((event) => event.catalogQueryRevision),
        [initialRevision, initialRevision],
      );

      const updatedEvents = clients.map((client) =>
        waitForWebSocketEvent(client, "catalog-query-updated"));
      const paused = runtime.database.setCatalogObjectDisposition(
        "item-identity",
        "revision-websocket-item",
        "paused",
        { reason: "revision websocket test", expectedRevision: item.revision },
      );
      server.broadcast({ type: "catalog-test-tick" });

      const updated = await Promise.all(updatedEvents);
      assert.equal(updated.every((event) => event.catalogQueryRevision !== initialRevision), true);
      assert.equal(new Set(updated.map((event) => event.catalogQueryRevision)).size, 1);

      const reconnected = new WebSocket(websocketUrl);
      try {
        const reconnectEventPromise =
          waitForWebSocketEvent(reconnected, "control-connected", "reconnect revision");
        await new Promise((resolve, reject) => {
          reconnected.once("open", resolve);
          reconnected.once("error", reject);
        });
        const reconnectEvent = await reconnectEventPromise;
        assert.equal(reconnectEvent.catalogQueryRevision, updated[0].catalogQueryRevision);

        const secondUpdatedEvents = clients.map((client) =>
          waitForWebSocketEvent(client, "catalog-query-updated", "existing client revision"));
        runtime.database.setCatalogObjectDisposition(
          "item-identity",
          "revision-websocket-item",
          "enabled",
          { reason: "revision reconnect test", expectedRevision: paused.revision },
        );
        const newestConnection = new WebSocket(websocketUrl);
        try {
          const newestConnectionEventPromise =
            waitForWebSocketEvent(newestConnection, "control-connected", "newest connection");
          await new Promise((resolve, reject) => {
            newestConnection.once("open", resolve);
            newestConnection.once("error", reject);
          });
          const newestConnectionEvent = await newestConnectionEventPromise;
          server.broadcast({ type: "catalog-test-tick" });
          const secondUpdated = await Promise.all(secondUpdatedEvents);
          assert.equal(
            secondUpdated.every((event) =>
              event.catalogQueryRevision === newestConnectionEvent.catalogQueryRevision),
            true,
          );
        } finally {
          newestConnection.close();
        }
      } finally {
        reconnected.close();
      }
    } finally {
      for (const client of clients) client.close();
    }
  });
});

test("pending scope is distinct and search always targets the complete directory", async () => {
  await withFixture(async ({ runtime, baseUrl }) => {
    activateIdentity(runtime, "directory-clear", {
      itemId: "directory-clear",
      name: "已确认目录项",
      level: 4,
      type: "flower",
      chainId: "directory-clear-chain",
    });
    provisionalIdentity(runtime, "directory-review", {
      itemId: "directory-review",
      name: "待审核目录项",
      level: 5,
    });

    const pendingResponse = await fetch(`${baseUrl}/api/catalog/items?scope=pending&pageSize=200`);
    assert.equal(pendingResponse.status, 200);
    const pending = await pendingResponse.json();
    assert.equal(pending.items.some((item) => item.itemId === "directory-review"), true);
    assert.equal(pending.items.some((item) => item.itemId === "directory-clear"), false);

    const incompatible = await fetch(`${baseUrl}/api/catalog/items?scope=pending&q=directory`);
    assert.equal(incompatible.status, 400);
    assert.deepEqual(await incompatible.json(), {
      ok: false,
      error: "catalog-query-incompatible-scope",
      code: "CATALOG_QUERY_INCOMPATIBLE_SCOPE",
    });

    const searched = await fetch(`${baseUrl}/api/catalog/items?q=directory-clear`);
    assert.equal(searched.status, 200);
    assert.equal((await searched.json()).items[0].itemId, "directory-clear");
  });
});

test("search ranks deterministically, composes filters, and distinguishes current from historical icon identifiers", async () => {
  await withFixture(async ({ runtime, baseUrl }) => {
    activateIdentity(runtime, "rank-prefix", {
      itemId: "rank-prefix",
      name: "Aurora Bloom",
      level: 2,
      type: "flower",
      chainId: "rank-chain",
    });
    activateIdentity(runtime, "aurora", {
      itemId: "aurora",
      name: "Different Name",
      level: null,
      type: "generator",
      chainId: null,
    });
    activateIdentity(runtime, "icon-search", {
      itemId: "icon-search",
      name: "Icon Search",
      level: 4,
      type: "flower",
      chainId: "rank-chain",
    });
    for (const itemId of ["rank-tie-b", "rank-tie-a"]) {
      activateIdentity(runtime, itemId, {
        itemId,
        name: "Stable Tie",
        level: 3,
        type: "tie",
        chainId: "tie-chain",
      });
    }

    const saveCandidate = (cacheKey, sourceType, runtimeIdentifier) => {
      const body = Buffer.from(cacheKey);
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const filePath = path.join(runtime.dataDir, `${hash}.png`);
      fs.writeFileSync(filePath, body);
      return runtime.database.saveIconCandidate({
        itemId: "icon-search",
        cacheKey,
        sourceType,
        runtimeIdentifier,
        rankScore: 1,
        autoSelect: false,
        asset: {
          hash,
          mimeType: "image/png",
          width: 1,
          height: 1,
          byteSize: body.length,
          filePath,
        },
      });
    };
    const currentCandidate = saveCandidate(
      "current-eligible",
      "manual-upload",
      "current-unselected-icon",
    );
    const staleCandidate = saveCandidate(
      "historical-ineligible",
      "legacy-unknown-source",
      "historical-icon",
    );
    assert.equal(currentCandidate.currency.status, "current");
    assert.equal(staleCandidate.currency.status, "stale");

    const ranked = await fetch(`${baseUrl}/api/catalog/items?q=aurora`).then((response) => response.json());
    assert.deepEqual(
      ranked.items.slice(0, 2).map((item) => item.itemId),
      ["aurora", "rank-prefix"],
    );
    assert.deepEqual(ranked.items[0].matchedFields, ["itemId"]);
    assert.deepEqual(ranked.items[1].matchedFields, ["candidateName"]);

    const normalized = await fetch(
      `${baseUrl}/api/catalog/items?q=${encodeURIComponent("ＡＵＲＯＲＡ   ＢＬＯＯＭ")}`,
    ).then((response) => response.json());
    assert.equal(normalized.items[0].itemId, "rank-prefix");
    assert.deepEqual(normalized.items[0].matchedFields, ["candidateName"]);

    const filtered = await fetch(
      `${baseUrl}/api/catalog/items?status=active&status=provisional&status=observed&itemType=flower&itemType=generator&level=unknown&level=2&sort=chain-level&direction=desc`,
    ).then((response) => response.json());
    assert.deepEqual(
      filtered.items.map((item) => item.itemId),
      ["rank-prefix", "aurora"],
    );

    for (const direction of ["asc", "desc"]) {
      const tied = await fetch(
        `${baseUrl}/api/catalog/items?itemType=tie&sort=chain-level&direction=${direction}`,
      ).then((response) => response.json());
      assert.deepEqual(
        tied.items.map((item) => item.itemId),
        ["rank-tie-a", "rank-tie-b"],
      );
    }

    const current = await fetch(`${baseUrl}/api/catalog/items?q=current-unselected-icon`)
      .then((response) => response.json());
    assert.equal(current.items[0].itemId, "icon-search");
    assert.deepEqual(current.items[0].matchedFields, ["currentIconIdentifier"]);

    const historical = await fetch(`${baseUrl}/api/catalog/items?q=historical-icon`)
      .then((response) => response.json());
    assert.equal(historical.items[0].itemId, "icon-search");
    assert.deepEqual(historical.items[0].matchedFields, ["historicalIconIdentifier"]);
    assert.equal(runtime.database.getSelectedIconCandidate("icon-search"), null);

    runtime.database.selectIconCandidate("icon-search", currentCandidate.id, {
      actor: "catalog-query-test",
      note: "exercise the explicit unknown icon-freshness filter",
      expectedDisplayIconRevision: runtime.database.getCatalogObject(
        "item-identity",
        "icon-search",
      ).displayIcon.revision,
    });
    runtime.database.db.prepare(
      "UPDATE catalog_icon_candidates SET currency_status='unknown' WHERE id=?",
    ).run(currentCandidate.id);
    const unknownFreshness = await fetch(
      `${baseUrl}/api/catalog/items?iconFreshness=unknown`,
    ).then((response) => response.json());
    assert.deepEqual(
      unknownFreshness.items.map((item) => item.itemId),
      ["icon-search"],
    );

    const empty = await fetch(`${baseUrl}/api/catalog/items?status=not-a-status`)
      .then((response) => response.json());
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.items, []);
  });
});

test("projection rebuild batches uncomplicated catalog objects instead of hydrating them one by one", async () => {
  await withFixture(async ({ runtime }) => {
    const items = Array.from({ length: 250 }, (_, index) => ({
      id: `batch-item-${String(index + 1).padStart(3, "0")}`,
      name: `Batch item ${index + 1}`,
      chainId: "batch-chain",
      level: (index % 20) + 1,
      type: "merge-item",
      mergeTarget: index < 249
        ? `batch-item-${String(index + 2).padStart(3, "0")}`
        : null,
    }));
    runtime.database.importCatalog({
      chains: [{
        id: "batch-chain",
        minLevel: 1,
        maxLevel: 20,
        complete: true,
        itemIds: items.map((item) => item.id),
      }],
      items,
      producers: [],
    }, {
      sourceFile: "batch-projection-fixture.json",
      sourceType: "test-fixture",
    });
    const originalGetCatalogObject = runtime.database.getCatalogObject.bind(runtime.database);
    let individualHydrations = 0;
    runtime.database.getCatalogObject = (...args) => {
      individualHydrations += 1;
      return originalGetCatalogObject(...args);
    };

    const query = new CatalogItemQuery(runtime.database);
    assert.match(query.revision(), /^catalog-query-v1:/);
    assert.equal(individualHydrations < 25, true);
    assert.equal(query.list({
      query: "batch-item",
      pageSize: 200,
      sort: "relevance",
    }).total, 250);
  });
});
