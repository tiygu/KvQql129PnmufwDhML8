"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function loadCoordinator() {
  const filePath = path.join(__dirname, "..", "web", "src", "catalog-review-mutation-coordinator.ts");
  return require(filePath).CatalogReviewMutationCoordinator;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function detail(overrides = {}) {
  return {
    objectType: "item-identity",
    objectId: "101",
    revision: 4,
    effectiveValue: { itemId: "101", name: "Tea" },
    displayIcon: {
      revision: 8,
      candidates: [{ id: 1, assetHash: "a" }, { id: 2, assetHash: "b" }],
      selectedCandidateId: 1,
      selectedIcon: { id: 1, assetHash: "a" },
      history: [],
    },
    iconCandidates: [{ id: 1, assetHash: "a" }, { id: 2, assetHash: "b" }],
    selectedIcon: { id: 1, assetHash: "a" },
    ...overrides,
  };
}

test("同 lane 串行而 semantic 与 display-icon mutation 可以并发", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  const semantic = deferred();
  const icon = deferred();
  const calls = [];
  const coordinator = new CatalogReviewMutationCoordinator({
    client: {
      completeCatalogReview: (input) => {
        calls.push(["semantic", input]);
        return semantic.promise;
      },
      selectCatalogIcon: (input) => {
        calls.push(["icon", input]);
        return icon.promise;
      },
    },
  });
  coordinator.setContext({ detail: detail() });

  const semanticRun = coordinator.execute({
    type: "complete-review",
    decision: "confirm",
    snapshot: { itemId: "101", name: "Tea" },
    actor: "operator",
  });
  const duplicate = await coordinator.execute({
    type: "complete-review",
    decision: "confirm",
    snapshot: { itemId: "101", name: "Tea" },
    actor: "operator",
  });
  const iconRun = coordinator.execute({
    type: "select-icon",
    candidateId: 2,
    actor: "operator",
    note: "choose",
  });

  assert.equal(duplicate.status, "unavailable");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].expectedRevision, 4);
  assert.equal(calls[1][1].expectedDisplayIconRevision, 8);
  semantic.resolve(detail({ revision: 5 }));
  icon.resolve(detail({
    displayIcon: {
      ...detail().displayIcon,
      revision: 9,
      selectedCandidateId: 2,
      selectedIcon: { id: 2, assetHash: "b" },
    },
  }));
  assert.equal((await semanticRun).status, "committed");
  assert.equal((await iconRun).status, "committed");
});

test("乱序响应只合并所属 lane 且 revision 不回退", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  const semantic = deferred();
  const icon = deferred();
  const published = [];
  const coordinator = new CatalogReviewMutationCoordinator({
    client: {
      completeCatalogReview: () => semantic.promise,
      selectCatalogIcon: () => icon.promise,
    },
    onDetail: (value) => published.push(value),
  });
  coordinator.setContext({ detail: detail() });

  const semanticRun = coordinator.execute({
    type: "complete-review",
    decision: "modify",
    snapshot: { itemId: "101", name: "New Tea" },
    actor: "operator",
  });
  const iconRun = coordinator.execute({
    type: "select-icon",
    candidateId: 2,
    actor: "operator",
    note: "choose",
  });
  icon.resolve(detail({
    displayIcon: {
      ...detail().displayIcon,
      revision: 9,
      selectedCandidateId: 2,
      selectedIcon: { id: 2, assetHash: "b" },
    },
  }));
  await iconRun;
  semantic.resolve(detail({
    revision: 5,
    effectiveValue: { itemId: "101", name: "New Tea" },
    displayIcon: { ...detail().displayIcon, revision: 8 },
  }));
  await semanticRun;

  const current = coordinator.currentDetail();
  assert.equal(current.revision, 5);
  assert.equal(current.effectiveValue.name, "New Tea");
  assert.equal(current.displayIcon.revision, 9);
  assert.equal(current.displayIcon.selectedCandidateId, 2);
  assert.ok(published.length >= 2);
});

test("完整审核未知结果重试复用 requestId 而输入变化后换号", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  const requestIds = [];
  const coordinator = new CatalogReviewMutationCoordinator({
    randomId: (() => {
      let id = 0;
      return () => `request-${++id}`;
    })(),
    client: {
      completeCatalogReview: async (input) => {
        requestIds.push(input.requestId);
        if (requestIds.length === 1) throw Object.assign(new Error("network"), { status: 503 });
        return detail({ revision: input.snapshot.name === "Tea" ? 5 : 6 });
      },
    },
  });
  coordinator.setContext({ detail: detail() });
  const input = {
    type: "complete-review",
    decision: "confirm",
    snapshot: { itemId: "101", name: "Tea" },
    actor: "operator",
  };
  assert.equal((await coordinator.execute(input)).status, "failed");
  assert.equal((await coordinator.execute(input)).status, "committed");
  coordinator.setContext({ detail: detail({ revision: 5 }) });
  await coordinator.execute({
    ...input,
    decision: "modify",
    snapshot: { itemId: "101", name: "Coffee" },
  });
  assert.deepEqual(requestIds, ["request-1", "request-1", "request-2"]);
});

test("mutation 已提交但 refresh 失败时 retryRefresh 只重试 refresh", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  let mutations = 0;
  let refreshes = 0;
  const coordinator = new CatalogReviewMutationCoordinator({
    client: {
      completeCatalogReview: async () => {
        mutations += 1;
        return detail({ revision: 5 });
      },
    },
    refresh: async () => {
      refreshes += 1;
      if (refreshes === 1) throw new Error("refresh failed");
      return { repository: { reviewQueue: [] } };
    },
  });
  coordinator.setContext({ detail: detail() });
  const outcome = await coordinator.execute({
    type: "complete-review",
    decision: "confirm",
    snapshot: { itemId: "101", name: "Tea" },
    actor: "operator",
  });
  assert.equal(outcome.status, "committed-refresh-needed");
  assert.equal(coordinator.snapshot().semantic.phase, "committed-refresh-needed");
  assert.equal((await coordinator.retryRefresh()).status, "committed");
  assert.equal(mutations, 1);
  assert.equal(refreshes, 2);
});

test("prepared operation 在对象或对应 lane revision 改变后失效", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  let calls = 0;
  const coordinator = new CatalogReviewMutationCoordinator({
    client: {
      setCatalogObjectDisposition: async () => {
        calls += 1;
        return detail({ revision: 6 });
      },
    },
  });
  coordinator.setContext({ detail: detail() });
  const prepared = await coordinator.prepare({
    type: "set-object-disposition",
    disposition: "paused",
    reason: "operator-paused-review",
  });
  coordinator.setContext({ detail: detail({ revision: 5 }) });
  const outcome = await coordinator.confirm(prepared.preparedId);
  assert.equal(outcome.status, "stale-preparation");
  assert.equal(calls, 0);
});

test("失败的 optimistic icon mutation 不覆盖已经到达的更高 revision", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  const request = deferred();
  const coordinator = new CatalogReviewMutationCoordinator({
    client: {
      selectCatalogIcon: () => request.promise,
    },
  });
  coordinator.setContext({ detail: detail() });
  const running = coordinator.execute({
    type: "select-icon",
    candidateId: 2,
    actor: "operator",
    note: "choose",
  });
  coordinator.setContext({
    detail: detail({
      displayIcon: {
        ...detail().displayIcon,
        revision: 10,
        selectedCandidateId: 2,
        selectedIcon: { id: 2, assetHash: "b" },
      },
    }),
  });
  request.reject(new Error("late failure"));
  const outcome = await running;
  assert.equal(outcome.status, "failed");
  assert.equal(coordinator.currentDetail().displayIcon.revision, 10);
  assert.equal(coordinator.currentDetail().displayIcon.selectedCandidateId, 2);
});

test("CatalogReviewWorkspace routes every catalog mutation through the coordinator", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "web", "src", "CatalogReviewWorkspace.tsx"),
    "utf8",
  );
  assert.doesNotMatch(source, /CatalogWorkspaceCommands|commands\./);
  assert.doesNotMatch(
    source,
    /controlApi\.(?:previewCatalogReview|skipCatalogReview|completeCatalogReview|setCatalogObjectDisposition|setCatalogEvidenceDisposition|acquireCatalogIcon|selectCatalogIcon|revokeCatalogIcon|uploadCatalogIcon)/,
  );
  assert.match(source, /CatalogReviewMutationCoordinator/);
});

test("prepared operation input changes are rejected before the endpoint is called", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  let calls = 0;
  const coordinator = new CatalogReviewMutationCoordinator({
    client: {
      setCatalogObjectDisposition: async () => {
        calls += 1;
        return detail({ revision: 6 });
      },
    },
  });
  coordinator.setContext({ detail: detail() });
  const intent = {
    type: "set-object-disposition",
    disposition: "paused",
    reason: "operator-paused-review",
  };
  const prepared = await coordinator.prepare(intent);
  const outcome = await coordinator.confirm(prepared.preparedId, {
    ...intent,
    reason: "operator-paused-review-updated",
  });
  assert.equal(outcome.status, "stale-preparation");
  assert.equal(calls, 0);
});

test("every mutation intent reaches its typed client endpoint with lane revision", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  const calls = [];
  const clients = {
    completeCatalogReview: async (input) => {
      calls.push(["complete", input]);
      return detail({ revision: 5 });
    },
    previewCatalogReview: async (input) => {
      calls.push(["preview", input]);
      return { snapshot: input.snapshot, planningImpact: {} };
    },
    skipCatalogReview: async (input) => {
      calls.push(["skip", input]);
      return { nextReviewTarget: null };
    },
    setCatalogObjectDisposition: async (input) => {
      calls.push(["object", input]);
      return detail({ revision: 6 });
    },
    setCatalogEvidenceDisposition: async (input) => {
      calls.push(["evidence", input]);
      return detail({ revision: 7 });
    },
    createIconHarvestJob: async (itemId, idempotencyKey) => {
      calls.push(["acquire", itemId, idempotencyKey]);
      return { jobId: "job-3", revision: 1, state: "queued" };
    },
    selectCatalogIcon: async (input) => {
      calls.push(["select", input]);
      return detail({ displayIcon: { ...detail().displayIcon, revision: 9 } });
    },
    revokeCatalogIcon: async (input) => {
      calls.push(["revoke", input]);
      return detail({ displayIcon: { ...detail().displayIcon, revision: 10 } });
    },
    uploadCatalogIcon: async (input) => {
      calls.push(["upload", input]);
      return detail({ displayIcon: { ...detail().displayIcon, revision: 11 } });
    },
  };
  const coordinator = new CatalogReviewMutationCoordinator({ client: clients });
  coordinator.setContext({ detail: detail() });
  const intents = [
    { type: "complete-review", decision: "confirm", snapshot: { itemId: "101" }, actor: "operator" },
    { type: "preview-review", snapshot: { itemId: "101" } },
    { type: "skip-review" },
    { type: "set-object-disposition", disposition: "paused", reason: "test" },
    { type: "set-evidence-disposition", evidenceId: 1, disposition: "eligible", reason: "test" },
    { type: "acquire-icon", idempotencyKey: "job-key-3" },
    { type: "select-icon", candidateId: 2, actor: "operator", note: "test" },
    { type: "revoke-icon", actor: "operator", note: "test" },
    { type: "upload-icon", dataBase64: "AA==", mimeType: "image/png", actor: "operator", note: "test" },
  ];
  for (const intent of intents) {
    const outcome = await coordinator.execute(intent);
    assert.equal(outcome.status, "committed", intent.type);
  }
  assert.deepEqual(calls.map(([name]) => name), [
    "complete", "preview", "skip", "object", "evidence",
    "acquire", "select", "revoke", "upload",
  ]);
  assert.equal(calls.find(([name]) => name === "complete")[1].expectedRevision, 4);
  assert.equal(calls.find(([name]) => name === "select")[1].expectedDisplayIconRevision, 8);
});

test("semantic and display-icon conflicts remain lane-local", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  const coordinator = new CatalogReviewMutationCoordinator({
    client: {
      setCatalogObjectDisposition: async () => {
        throw Object.assign(new Error("semantic conflict"), {
          status: 409,
          payload: { code: "CATALOG_REVISION_CONFLICT" },
        });
      },
      revokeCatalogIcon: async () => {
        throw Object.assign(new Error("icon conflict"), {
          status: 409,
          payload: { code: "CATALOG_REVISION_CONFLICT" },
        });
      },
    },
  });
  coordinator.setContext({ detail: detail() });
  const semantic = await coordinator.execute({
    type: "set-object-disposition",
    disposition: "paused",
    reason: "test",
  });
  const icon = await coordinator.execute({
    type: "revoke-icon",
    actor: "operator",
    note: "test",
  });
  assert.equal(semantic.status, "conflict");
  assert.equal(icon.status, "conflict");
  assert.equal(coordinator.snapshot().semantic.phase, "conflicted");
  assert.equal(coordinator.snapshot().displayIcon.phase, "conflicted");
});

test("late response from a previous object cannot replace the selected detail", async () => {
  const CatalogReviewMutationCoordinator = loadCoordinator();
  const request = deferred();
  const coordinator = new CatalogReviewMutationCoordinator({
    client: { selectCatalogIcon: () => request.promise },
  });
  coordinator.setContext({ detail: detail() });
  const running = coordinator.execute({
    type: "select-icon",
    candidateId: 2,
    actor: "operator",
    note: "test",
  });
  const other = detail({ objectId: "202", displayIcon: { ...detail().displayIcon, revision: 1 } });
  coordinator.setContext({ detail: other });
  request.resolve(detail({
    displayIcon: { ...detail().displayIcon, revision: 9, selectedCandidateId: 2 },
  }));
  await running;
  assert.equal(coordinator.currentDetail().objectId, "202");
});
