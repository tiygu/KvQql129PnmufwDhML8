"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { AutomationRuntime } = require("../src/automation-runtime");
const { createControlServer } = require("../src/control-server");

function iconAsset(filePath, hash) {
  return {
    hash,
    mimeType: "image/png",
    width: 1,
    height: 1,
    byteSize: fs.statSync(filePath).size,
    filePath,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  return server.httpServer.address().port;
}

const MERGE_CHAIN_FIXTURE = Object.freeze({
  mergeChainId: "10200068",
  members: Object.freeze([
    Object.freeze({ itemId: "10180040", level: 1 }),
    Object.freeze({ itemId: "10180041", level: 2 }),
  ]),
});

function activateCatalogObject(database, objectType, objectId, payload) {
  database.observeCatalogObject({
    objectType,
    objectId,
    payload,
    sourceType: "runtime-capture",
    sourceRef: `icon-harvest-fixture:${objectId}`,
    countDuplicate: false,
  });
  const object = database.getCatalogObject(objectType, objectId);
  return database.transitionCatalogObject({
    objectType,
    objectId,
    status: "active",
    payload,
    reason: "icon harvest test fixture",
    expectedRevision: object.revision,
    origin: "inference-gate",
  });
}

test("merge-chain preflight requires confirmation and freezes the confirmed member order", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-chain-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const batchRequests = [];
  runtime.iconService.requestBatch = (entries) => {
    batchRequests.push(entries.map((entry) => String(entry.itemId)));
    return entries.map((entry, index) => ({
      status: "queued",
      taskId: 1000 + index,
      itemId: String(entry.itemId),
      shared: false,
    }));
  };

  try {
    assert.throws(
      () => runtime.preflightIconHarvestJob({
        scope: { type: "merge-chain", mergeChainId: "10200002" },
      }),
      (error) => error.code === "MERGE_CHAIN_NOT_VERIFIED",
    );
    const preflight = runtime.preflightIconHarvestJob({
      scope: {
        type: "merge-chain",
        mergeChainId: MERGE_CHAIN_FIXTURE.mergeChainId,
      },
    });

    assert.equal(typeof preflight.preflightId, "string");
    assert.equal(preflight.scope.type, "merge-chain");
    assert.equal(preflight.scope.mergeChainId, MERGE_CHAIN_FIXTURE.mergeChainId);
    assert.equal(preflight.catalogQueryRevision, runtime.getCatalogQueryRevision());
    assert.equal(preflight.expectedMemberCount, 2);
    assert.deepEqual(preflight.missingIdentities, []);
    assert.deepEqual(
      preflight.frozenMembers.map(({ itemId, level, order }) => ({
        itemId,
        level,
        order,
      })),
      MERGE_CHAIN_FIXTURE.members.map((member, order) => ({ ...member, order })),
    );
    assert.deepEqual(preflight.contractChecks, {
      acquisitionContractVersion: "item-icon-acquisition-v1",
      status: "passed",
      checks: [
        { code: "verified-merge-chain", status: "passed" },
        { code: "frozen-members-non-empty", status: "passed" },
        {
          code: "identity-gaps-accounted-for",
          status: "passed",
          missingCount: 0,
        },
        {
          code: "passive-runtime-evidence-only",
          status: "passed",
          boardActionsAllowed: false,
        },
        {
          code: "unloaded-resource-outcome",
          status: "passed",
          outcome: "deferred",
        },
      ],
    });
    assert.deepEqual(preflight.capacity, {
      required: 2,
      available: 100,
      shared: 0,
      limit: 100,
      admissible: true,
    });
    assert.deepEqual(preflight.safety, {
      state: "safe",
      reason: null,
    });
    assert.equal(runtime.listIconHarvestJobs().length, 0);
    assert.equal(runtime.iconService.tasks.size, 0);
    const concurrentPreflight = runtime.preflightIconHarvestJob({
      scope: preflight.scope,
    });

    assert.throws(
      () => runtime.createIconHarvestJob({
        scope: preflight.scope,
        preflightId: preflight.preflightId,
        confirmed: false,
        idempotencyKey: "merge-chain-unconfirmed",
      }),
      (error) => error.code === "ICON_HARVEST_CONFIRMATION_REQUIRED",
    );
    assert.equal(runtime.listIconHarvestJobs().length, 0);

    const created = runtime.createIconHarvestJob({
      scope: preflight.scope,
      preflightId: preflight.preflightId,
      confirmed: true,
      idempotencyKey: "merge-chain-confirmed",
    });
    assert.equal(created.scope.type, "merge-chain");
    assert.equal(created.scope.mergeChainId, MERGE_CHAIN_FIXTURE.mergeChainId);
    assert.equal(created.scope.catalogQueryRevision, preflight.catalogQueryRevision);
    assert.equal(
      created.scope.acquisitionContractVersion,
      "item-icon-acquisition-v1",
    );
    assert.deepEqual(
      created.scope.frozenMembers.map(({ itemId, level, order }) => ({
        itemId,
        level,
        order,
      })),
      MERGE_CHAIN_FIXTURE.members.map((member, order) => ({ ...member, order })),
    );
    assert.deepEqual(
      created.children.map((child) => child.itemId),
      MERGE_CHAIN_FIXTURE.members.map((member) => member.itemId),
    );
    assert.deepEqual(batchRequests, [
      MERGE_CHAIN_FIXTURE.members.map((member) => member.itemId),
    ]);
    assert.throws(
      () => runtime.createIconHarvestJob({
        scope: concurrentPreflight.scope,
        preflightId: concurrentPreflight.preflightId,
        confirmed: true,
        idempotencyKey: "merge-chain-concurrent-preflight",
      }),
      (error) => error.code === "ICON_HARVEST_DUPLICATE_ACTIVE"
        && error.existingJobId === created.jobId,
    );

    const duplicatePreflight = runtime.preflightIconHarvestJob({
      scope: preflight.scope,
    });
    assert.equal(
      duplicatePreflight.duplicates.matchingActiveJob.jobId,
      created.jobId,
    );
    assert.throws(
      () => runtime.createIconHarvestJob({
        scope: duplicatePreflight.scope,
        preflightId: duplicatePreflight.preflightId,
        confirmed: true,
        idempotencyKey: "merge-chain-duplicate",
      }),
      (error) => error.code === "ICON_HARVEST_DUPLICATE_ACTIVE"
        && error.existingJobId === created.jobId,
    );

    MERGE_CHAIN_FIXTURE.members.forEach((member, index) => {
      runtime.iconHarvestJobs.handleAcquisitionEvent({
        type: "icon-acquisition-complete",
        taskId: 1000 + index,
        itemId: member.itemId,
        candidate: {
          id: index + 1,
          assetHash: String(index + 1).repeat(64),
          sourceType: "cocos-runtime-resource",
        },
      });
    });
    assert.equal(runtime.getIconHarvestJob(created.jobId).state, "succeeded");
    const differentScopeJob = runtime.iconHarvestJobs.createMergeChain({
      scope: {
        ...created.scope,
        catalogQueryRevision: "catalog-query-v1:older-scope",
        frozenMembers: [created.scope.frozenMembers[0]],
        scopeFingerprint: "different-frozen-scope",
      },
      idempotencyKey: "artificial-different-scope",
    }).snapshot;
    const changedPreflight = runtime.preflightIconHarvestJob({
      scope: preflight.scope,
    });
    assert.equal(changedPreflight.frozenMembers.length, 2);
    assert.equal(changedPreflight.duplicates.matchingActiveJob, null);
    assert.deepEqual(
      changedPreflight.duplicates.differentScopeActiveJobs.map((job) => job.jobId),
      [differentScopeJob.jobId],
    );
    assert.equal(changedPreflight.duplicates.requiresExplicitNewJob, true);
    assert.throws(
      () => runtime.createIconHarvestJob({
        scope: changedPreflight.scope,
        preflightId: changedPreflight.preflightId,
        confirmed: true,
        createNew: true,
        idempotencyKey: "artificial-different-scope",
      }),
      (error) => error.code === "ICON_HARVEST_IDEMPOTENCY_CONFLICT",
    );
    assert.throws(
      () => runtime.createIconHarvestJob({
        scope: changedPreflight.scope,
        preflightId: changedPreflight.preflightId,
        confirmed: true,
        idempotencyKey: "merge-chain-changed-scope",
      }),
      (error) => error.code === "ICON_HARVEST_EXPLICIT_NEW_REQUIRED",
    );
    const changedScopeJob = runtime.createIconHarvestJob({
      scope: changedPreflight.scope,
      preflightId: changedPreflight.preflightId,
      confirmed: true,
      createNew: true,
      idempotencyKey: "merge-chain-changed-scope",
    });
    assert.equal(changedScopeJob.children.length, 2);

    const persistedOriginal = runtime.getIconHarvestJob(created.jobId);
    assert.deepEqual(
      persistedOriginal.scope.frozenMembers.map((member) => member.itemId),
      MERGE_CHAIN_FIXTURE.members.map((member) => member.itemId),
    );
    assert.equal(
      persistedOriginal.scope.catalogQueryRevision,
      preflight.catalogQueryRevision,
    );
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("scope matching changes when the frozen catalog revision or resource target changes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-fingerprint-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  runtime.iconService.requestBatch = (entries) => entries.map((entry, index) => ({
    status: "queued",
    taskId: 3500 + index,
    itemId: String(entry.itemId),
    shared: false,
  }));

  try {
    const originalPreflight = runtime.preflightIconHarvestJob({
      scope: {
        type: "merge-chain",
        mergeChainId: MERGE_CHAIN_FIXTURE.mergeChainId,
      },
    });
    const originalJob = runtime.createIconHarvestJob({
      scope: originalPreflight.scope,
      preflightId: originalPreflight.preflightId,
      confirmed: true,
      idempotencyKey: "merge-chain-original-fingerprint",
    });
    const changedItemId = MERGE_CHAIN_FIXTURE.members[0].itemId;
    const identity = runtime.database.getCatalogObject(
      "item-identity",
      changedItemId,
    );
    runtime.database.applyCatalogRuling({
      objectType: "item-identity",
      objectId: changedItemId,
      fieldPath: "iconResourceIdentifier",
      decision: "modify",
      value: "fixture/changed-icon-resource",
      actor: "icon-harvest-test",
      note: "change frozen acquisition target",
      expectedRevision: identity.revision,
    });

    const changedPreflight = runtime.preflightIconHarvestJob({
      scope: originalPreflight.scope,
    });
    assert.notEqual(
      changedPreflight.catalogQueryRevision,
      originalPreflight.catalogQueryRevision,
    );
    assert.equal(
      changedPreflight.frozenMembers[0].iconResourceIdentifier,
      "fixture/changed-icon-resource",
    );
    assert.equal(changedPreflight.duplicates.matchingActiveJob, null);
    assert.deepEqual(
      changedPreflight.duplicates.differentScopeActiveJobs.map((job) => job.jobId),
      [originalJob.jobId],
    );
    assert.equal(changedPreflight.duplicates.requiresExplicitNewJob, true);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("merge-chain HTTP admission returns required and available without partial persistence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-capacity-"));
  const publicRoot = path.join(dataDir, "public");
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, "index.html"), "ok");
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  runtime.iconService.softQueueLimit = 1;
  runtime.iconService.queueLimit = 1;
  const server = createControlServer({ runtime, publicRoot, dataDir });
  const port = await listen(server);

  try {
    const preflightResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs/preflight`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: {
            type: "merge-chain",
            mergeChainId: MERGE_CHAIN_FIXTURE.mergeChainId,
          },
        }),
      },
    );
    assert.equal(preflightResponse.status, 200);
    const preflight = await preflightResponse.json();
    assert.deepEqual(preflight.capacity, {
      required: 2,
      available: 1,
      shared: 0,
      limit: 1,
      admissible: false,
    });

    const createResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: preflight.scope,
          preflightId: preflight.preflightId,
          confirmed: true,
          idempotencyKey: "merge-chain-capacity",
        }),
      },
    );
    assert.equal(createResponse.status, 429);
    const rejected = await createResponse.json();
    assert.equal(rejected.code, "ICON_ACQUISITION_QUEUE_FULL");
    assert.equal(rejected.required, 2);
    assert.equal(rejected.available, 1);
    assert.equal(runtime.listIconHarvestJobs().length, 0);
    assert.equal(runtime.iconService.tasks.size, 0);
    assert.equal(runtime.iconService.inFlight.size, 0);
  } finally {
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("unloaded merge-chain resources settle as completed-with-gaps without game actions", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-gaps-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  runtime.iconService.resolveSpriteFrame = async () => null;
  let screenshotLookups = 0;
  runtime.iconService.resolveScreenshotBounds = async ({ itemId }) => {
    screenshotLookups += 1;
    throw new Error(`runtime screenshot bounds not found for item ${itemId}`);
  };
  runtime.iconService.captureScreenshot = async () => {
    throw new Error("screenshot capture must not run without a reliable target");
  };

  try {
    const actionsBefore = runtime.database.db.prepare(
      "SELECT COUNT(*) AS count FROM actions",
    ).get().count;
    const preflight = runtime.preflightIconHarvestJob({
      scope: {
        type: "merge-chain",
        mergeChainId: MERGE_CHAIN_FIXTURE.mergeChainId,
      },
    });
    const created = runtime.createIconHarvestJob({
      scope: preflight.scope,
      preflightId: preflight.preflightId,
      confirmed: true,
      idempotencyKey: "merge-chain-gaps",
    });
    await runtime.iconService.waitForIdle();
    const completed = runtime.getIconHarvestJob(created.jobId);

    assert.equal(completed.state, "completed-with-gaps");
    assert.equal(completed.finalStatus, "completed-with-gaps");
    assert.deepEqual(completed.progress.terminal, {
      succeeded: 0,
      deferred: 2,
      failed: 0,
      cancelled: 0,
    });
    assert.equal(
      completed.children.every((child) => child.state === "deferred"),
      true,
    );
    assert.equal(
      completed.children.every((child) => child.reason === "resource-not-loaded"),
      true,
    );
    assert.equal(
      completed.children.every((child) => child.retryable === true),
      true,
    );
    assert.equal(screenshotLookups, 0);
    assert.equal(
      runtime.database.db.prepare("SELECT COUNT(*) AS count FROM actions").get().count,
      actionsBefore,
    );
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("frozen missing identities persist as deferred children and prevent false success", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-missing-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });

  try {
    activateCatalogObject(
      runtime.database,
      "merge-relation",
      "verified-gap-item-1",
      {
        itemId: "verified-gap-item-1",
        chainId: "verified-chain-with-gap",
        level: 1,
        mergeTarget: "verified-gap-item-2",
      },
    );
    activateCatalogObject(
      runtime.database,
      "merge-relation",
      "verified-gap-item-2",
      {
        itemId: "verified-gap-item-2",
        chainId: "verified-chain-with-gap",
        level: 2,
        mergeTarget: "verified-gap-item-3",
      },
    );
    activateCatalogObject(
      runtime.database,
      "merge-relation",
      "verified-gap-item-3",
      {
        itemId: "verified-gap-item-3",
        chainId: "verified-chain-with-gap",
        level: 3,
        mergeTarget: null,
      },
    );
    activateCatalogObject(
      runtime.database,
      "item-identity",
      "verified-gap-item-1",
      {
        itemId: "verified-gap-item-1",
        chainId: "verified-chain-with-gap",
        level: 1,
        baseUnits: 1,
        iconResourceIdentifier: "fixture/icon",
      },
    );
    activateCatalogObject(
      runtime.database,
      "item-identity",
      "verified-gap-item-3",
      {
        itemId: "verified-gap-item-3",
        chainId: "verified-chain-with-gap",
        level: 3,
        baseUnits: 4,
        iconResourceIdentifier: "fixture/icon-3",
      },
    );
    runtime.iconService.requestBatch = (entries) => entries.map((entry, index) => ({
      status: "queued",
      taskId: 4401 + index,
      itemId: String(entry.itemId),
      shared: false,
    }));

    const preflight = runtime.preflightIconHarvestJob({
      scope: {
        type: "merge-chain",
        mergeChainId: "verified-chain-with-gap",
      },
    });
    assert.equal(preflight.expectedMemberCount, 3);
    assert.deepEqual(preflight.missingIdentities, ["verified-gap-item-2"]);
    assert.deepEqual(
      preflight.frozenMembers.map(
        ({ itemId, order, identityAvailable }) => ({
          itemId,
          order,
          identityAvailable,
        }),
      ),
      [
        {
          itemId: "verified-gap-item-1",
          order: 0,
          identityAvailable: true,
        },
        {
          itemId: "verified-gap-item-2",
          order: 1,
          identityAvailable: false,
        },
        {
          itemId: "verified-gap-item-3",
          order: 2,
          identityAvailable: true,
        },
      ],
    );
    const created = runtime.createIconHarvestJob({
      scope: preflight.scope,
      preflightId: preflight.preflightId,
      confirmed: true,
      idempotencyKey: "verified-chain-with-gap",
    });
    assert.equal(created.progress.total, 3);
    assert.equal(created.progress.terminal.deferred, 1);
    assert.deepEqual(
      created.children.map((child) => child.itemId),
      [
        "verified-gap-item-1",
        "verified-gap-item-2",
        "verified-gap-item-3",
      ],
    );
    assert.equal(
      created.children.find(
        (child) => child.itemId === "verified-gap-item-2",
      ).reason,
      "missing-item-identity",
    );

    runtime.iconHarvestJobs.handleAcquisitionEvent({
      type: "icon-acquisition-complete",
      taskId: 4401,
      itemId: "verified-gap-item-1",
      candidate: {
        id: 1,
        assetHash: "f".repeat(64),
        sourceType: "cocos-runtime-resource",
      },
    });
    runtime.iconHarvestJobs.handleAcquisitionEvent({
      type: "icon-acquisition-complete",
      taskId: 4402,
      itemId: "verified-gap-item-3",
      candidate: {
        id: 2,
        assetHash: "e".repeat(64),
        sourceType: "cocos-runtime-resource",
      },
    });
    const completed = runtime.getIconHarvestJob(created.jobId);
    assert.equal(completed.state, "completed-with-gaps");
    assert.equal(completed.finalStatus, "completed-with-gaps");
    assert.deepEqual(completed.progress.terminal, {
      succeeded: 2,
      deferred: 1,
      failed: 0,
      cancelled: 0,
    });
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("verified relation-only chains create gap-only completed jobs", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-all-gaps-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  let batchCalls = 0;
  runtime.iconService.requestBatch = () => {
    batchCalls += 1;
    return [];
  };

  try {
    for (const [index, itemId] of ["all-gap-1", "all-gap-2"].entries()) {
      activateCatalogObject(
        runtime.database,
        "merge-relation",
        itemId,
        {
          itemId,
          chainId: "verified-all-gap-chain",
          level: index + 1,
          mergeTarget: index === 0 ? "all-gap-2" : null,
        },
      );
    }
    const preflight = runtime.preflightIconHarvestJob({
      scope: {
        type: "merge-chain",
        mergeChainId: "verified-all-gap-chain",
      },
    });
    assert.deepEqual(preflight.missingIdentities, ["all-gap-1", "all-gap-2"]);
    assert.equal(preflight.frozenMembers.length, 2);

    const created = runtime.createIconHarvestJob({
      scope: preflight.scope,
      preflightId: preflight.preflightId,
      confirmed: true,
      idempotencyKey: "verified-all-gap-chain",
    });
    assert.equal(created.state, "completed-with-gaps");
    assert.equal(created.finalStatus, "completed-with-gaps");
    assert.equal(created.progress.total, 2);
    assert.equal(created.progress.terminal.deferred, 2);
    assert.deepEqual(
      created.children.map((child) => child.itemId),
      ["all-gap-1", "all-gap-2"],
    );
    assert.equal(batchCalls, 1);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("single-item Icon Harvest Job persists one child and replays an idempotent create", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-job-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const requests = [];
  runtime.iconService.request = (itemId) => {
    requests.push(String(itemId));
    return { status: "queued", taskId: 71, itemId: String(itemId) };
  };

  try {
    const input = {
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "single-item-job-1",
    };
    const created = runtime.createIconHarvestJob(input);
    const replayed = runtime.createIconHarvestJob(input);

    assert.equal(created.jobId, replayed.jobId);
    assert.equal(created.idempotentReplay, false);
    assert.equal(replayed.idempotentReplay, true);
    assert.equal(created.revision, 1);
    assert.equal(created.state, "queued");
    assert.equal(created.stage, "queued");
    assert.deepEqual(created.scope, input.scope);
    assert.deepEqual(created.progress, {
      settled: 0,
      total: 1,
      terminal: {
        succeeded: 0,
        deferred: 0,
        failed: 0,
        cancelled: 0,
      },
    });
    assert.equal(created.children.length, 1);
    assert.equal(created.children[0].itemId, item.objectId);
    assert.equal(created.children[0].state, "queued");
    assert.deepEqual(requests, [item.objectId]);
    const { idempotentReplay: _replay, taskId: _taskId, ...snapshot } = created;
    assert.deepEqual(runtime.getIconHarvestJob(created.jobId), snapshot);
    assert.equal(runtime.listIconHarvestJobs()[0].jobId, created.jobId);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("runtime-busy harvest jobs persist a stable queued reason until the safe boundary returns", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-busy-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const acquiredPath = path.join(dataDir, "busy-acquired.png");
  fs.writeFileSync(acquiredPath, "acquired");
  runtime.iconService.resolveSpriteFrame = async () => ({
    resourceUrl: "fixture://busy-icon",
    runtimeIdentifier: "busy-icon",
    rect: { x: 0, y: 0, width: 1, height: 1 },
    originalSize: { width: 1, height: 1 },
    offset: { x: 0, y: 0 },
    mimeType: "image/png",
  });
  runtime.iconService.readResource = async () => ({
    body: Buffer.from("fixture"),
    mimeType: "image/png",
    resolvedUrl: "fixture://busy-icon",
  });
  runtime.iconService.processImage = async () => iconAsset(
    acquiredPath,
    "e".repeat(64),
  );

  try {
    runtime.sessionSupervisor.adoptSession({ kind: "test-fixture" });
    const created = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "runtime-busy-single-item-job",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const queued = runtime.getIconHarvestJob(created.jobId);
    assert.equal(queued.state, "queued");
    assert.equal(queued.stage, "waiting-for-runtime-slot");
    assert.equal(queued.reason, "automation-runtime-busy");
    assert.equal(queued.children[0].retryable, true);

    runtime.sessionSupervisor.finish();
    runtime.iconService.notifySafeBoundary();
    await runtime.iconService.waitForIdle();
    assert.equal(runtime.getIconHarvestJob(created.jobId).state, "succeeded");
  } finally {
    runtime.sessionSupervisor.finish();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("successful acquisition publishes and persists one revisioned job snapshot without replacing a manual display choice", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-success-"));
  const events = [];
  let runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
    onEvent: (event) => events.push(event),
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const manualPath = path.join(dataDir, "manual.png");
  const acquiredPath = path.join(dataDir, "acquired.png");
  fs.writeFileSync(manualPath, "manual");
  fs.writeFileSync(acquiredPath, "acquired");
  const manual = runtime.database.saveIconCandidate({
    itemId: item.objectId,
    cacheKey: "manual-candidate",
    sourceType: "user-upload",
    rankScore: 1,
    autoSelect: false,
    asset: iconAsset(manualPath, "a".repeat(64)),
  });
  const decision = runtime.database.getCatalogObject(
    "item-identity",
    item.objectId,
  ).displayIcon;
  runtime.database.selectIconCandidate(item.objectId, manual.id, {
    actor: "operator",
    note: "keep this display choice",
    expectedDisplayIconRevision: decision.revision,
  });
  const semanticBefore = runtime.getCatalogObject(
    "item-identity",
    item.objectId,
  ).effectiveValue;
  const planningBefore = runtime.getPlanningCatalog().items.find(
    (entry) => String(entry.id) === item.objectId,
  );
  runtime.iconService.resolveSpriteFrame = async () => ({
    resourceUrl: "fixture://current-icon",
    runtimeIdentifier: "resolved-current-icon",
    rect: { x: 0, y: 0, width: 1, height: 1 },
    originalSize: { width: 1, height: 1 },
    offset: { x: 0, y: 0 },
    mimeType: "image/png",
  });
  runtime.iconService.readResource = async () => ({
    body: Buffer.from("fixture"),
    mimeType: "image/png",
    resolvedUrl: "fixture://current-icon",
  });
  runtime.iconService.processImage = async () => iconAsset(
    acquiredPath,
    "b".repeat(64),
  );

  try {
    const created = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "successful-single-item-job",
    });
    await runtime.iconService.waitForIdle();
    const completed = runtime.getIconHarvestJob(created.jobId);

    assert.equal(completed.revision, 3);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.stage, "committed");
    assert.deepEqual(completed.progress, {
      settled: 1,
      total: 1,
      terminal: {
        succeeded: 1,
        deferred: 0,
        failed: 0,
        cancelled: 0,
      },
    });
    assert.equal(completed.children[0].result.assetHash, "b".repeat(64));
    assert.equal(
      runtime.getCatalogObject("item-identity", item.objectId).selectedIcon.id,
      manual.id,
    );
    assert.deepEqual(
      runtime.getCatalogObject("item-identity", item.objectId).effectiveValue,
      semanticBefore,
    );
    assert.deepEqual(
      runtime.getPlanningCatalog().items.find(
        (entry) => String(entry.id) === item.objectId,
      ),
      planningBefore,
    );
    assert.deepEqual(
      events.filter((event) => event.type === "icon-harvest-job-updated").at(-1).job,
      completed,
    );

    await runtime.close();
    runtime = new AutomationRuntime({
      rootDir: path.resolve(__dirname, ".."),
      dataDir,
      manageConnectionRoute: false,
    });
    assert.deepEqual(runtime.getIconHarvestJob(created.jobId), completed);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("failed evidence commit settles the acquisition without leaving asset or candidate records", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-rollback-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  const acquiredPath = path.join(dataDir, "failed-acquired.png");
  fs.writeFileSync(acquiredPath, "acquired");
  const acquiredHash = "c".repeat(64);
  runtime.iconService.resolveSpriteFrame = async () => ({
    resourceUrl: "fixture://failed-icon",
    rect: { x: 0, y: 0, width: 1, height: 1 },
    originalSize: { width: 1, height: 1 },
    offset: { x: 0, y: 0 },
    mimeType: "image/png",
  });
  runtime.iconService.readResource = async () => ({
    body: Buffer.from("fixture"),
    mimeType: "image/png",
    resolvedUrl: "fixture://failed-icon",
  });
  runtime.iconService.processImage = async () => iconAsset(
    acquiredPath,
    acquiredHash,
  );
  runtime.database.saveIconCandidateWithDecision = () => {
    throw Object.assign(new Error("injected SQLite failure"), {
      code: "SQLITE_INJECTED_FAILURE",
    });
  };

  try {
    const before = runtime.database.listIconCandidates(item.objectId).length;
    const created = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "failed-single-item-job",
    });
    await runtime.iconService.waitForIdle();
    const failed = runtime.getIconHarvestJob(created.jobId);

    assert.equal(failed.revision, 3);
    assert.equal(failed.state, "failed");
    assert.equal(failed.children[0].reason, "SQLITE_INJECTED_FAILURE");
    assert.equal(failed.children[0].result, null);
    assert.equal(runtime.database.listIconCandidates(item.objectId).length, before);
    assert.equal(runtime.database.getIconAsset(acquiredHash), null);
    assert.equal(fs.existsSync(acquiredPath), false);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("REST list and detail match the revisioned WebSocket snapshot", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-http-"));
  const publicRoot = path.join(dataDir, "public");
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, "index.html"), "ok");
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const requests = [];
  runtime.iconService.request = (itemId) => {
    requests.push(String(itemId));
    return { status: "queued", taskId: 81, itemId: String(itemId) };
  };
  const server = createControlServer({ runtime, publicRoot, dataDir });
  runtime.onEvent = (event) => server.broadcast(event);
  const port = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];

  try {
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const update = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("job update timeout")), 2000);
      client.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "icon-harvest-job-updated") return;
        clearTimeout(timer);
        resolve(event.job);
      });
    });
    const input = {
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "http-single-item-job",
    };
    const response = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    assert.equal(response.status, 202);
    const created = await response.json();
    const websocketSnapshot = await update;
    const detailResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs/${created.jobId}`,
    );
    const detail = await detailResponse.json();
    const listResponse = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs`,
    );
    const list = await listResponse.json();
    const replay = await fetch(
      `http://127.0.0.1:${port}/api/catalog/icon-harvest-jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );

    assert.deepEqual(detail, websocketSnapshot);
    assert.deepEqual(list, { jobs: [detail] });
    assert.equal((await replay.json()).jobId, created.jobId);
    assert.deepEqual(requests, [item.objectId]);
  } finally {
    client.close();
    await server.close();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("runtime restart converges unfinished harvest work to an explicit deferred result", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-restart-"));
  let runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  runtime.iconService.request = () => ({ status: "queued", taskId: 901, itemId: item.objectId });
  const created = runtime.createIconHarvestJob({
    scope: { type: "item", itemId: item.objectId },
    idempotencyKey: "restart-single-item-job",
  });
  assert.equal(created.state, "queued");
  await runtime.close();

  try {
    runtime = new AutomationRuntime({
      rootDir: path.resolve(__dirname, ".."),
      dataDir,
      manageConnectionRoute: false,
    });
    const recovered = runtime.getIconHarvestJob(created.jobId);
    assert.equal(recovered.state, "completed-with-gaps");
    assert.equal(recovered.finalStatus, "completed-with-gaps");
    assert.equal(recovered.reason, "runtime-restarted");
    assert.equal(recovered.children[0].state, "deferred");
    assert.equal(recovered.children[0].retryable, true);
    assert.equal(recovered.children[0].result, null);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("new harvest subscriptions reconcile an already-running runner task", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-harvest-subscription-"));
  const runtime = new AutomationRuntime({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    manageConnectionRoute: false,
  });
  const item = runtime.database.listCatalogObjects({ objectType: "item-identity" })[0];
  runtime.iconService.request = () => ({
    status: "queued",
    taskId: 902,
    itemId: item.objectId,
  });
  runtime.iconService.getTask = () => ({
    status: "running",
    taskId: 902,
    itemId: item.objectId,
  });

  try {
    const created = runtime.createIconHarvestJob({
      scope: { type: "item", itemId: item.objectId },
      idempotencyKey: "existing-runner-task-job",
    });
    assert.equal(created.state, "running");
    assert.equal(created.revision, 2);

    runtime.iconHarvestJobs.handleAcquisitionEvent({
      type: "icon-acquisition-complete",
      taskId: 902,
      itemId: item.objectId,
      candidate: {
        id: 77,
        assetHash: "d".repeat(64),
        sourceType: "cocos-runtime-resource",
      },
    });
    const completed = runtime.getIconHarvestJob(created.jobId);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.revision, 3);
    assert.equal(completed.children[0].result.assetHash, "d".repeat(64));
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
