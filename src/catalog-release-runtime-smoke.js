"use strict";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      payload?.message
      || payload?.error
      || `request failed with ${response.status}`,
    );
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function postJson(fetchImpl, url, body) {
  return requestJson(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function terminal(job) {
  return Boolean(job?.finalStatus)
    || ["succeeded", "completed-with-gaps", "failed", "cancelled"]
      .includes(job?.state);
}

function successfulTerminal(job) {
  const state = String(job?.finalStatus || job?.state || "");
  return ["succeeded", "completed-with-gaps"].includes(state);
}

function detailCandidates(detail) {
  const groups = detail?.displayIcon?.candidates || {};
  return [
    ...(groups.currentDisplay || []),
    ...(groups.eligible || []),
    ...(groups.historical || []),
  ];
}

async function waitForJob({
  fetchImpl,
  baseUrl,
  initialJob,
  pollIntervalMs,
  timeoutMs,
  sleepImpl,
}) {
  if (terminal(initialJob)) return initialJob;
  const started = Date.now();
  let snapshot = initialJob;
  while (Date.now() - started < timeoutMs) {
    await sleepImpl(pollIntervalMs);
    snapshot = await requestJson(
      fetchImpl,
      new URL(
        `/api/catalog/icon-harvest-jobs/${encodeURIComponent(snapshot.jobId)}`,
        baseUrl,
      ),
    );
    if (terminal(snapshot)) return snapshot;
  }
  const error = new Error(`Icon Harvest Job timed out: ${snapshot?.jobId || "unknown"}`);
  error.code = "CATALOG_RELEASE_RUNTIME_SMOKE_TIMEOUT";
  throw error;
}

function actionIdentity(action) {
  return String(
    action?.id
    ?? action?.actionId
    ?? `${action?.sequence ?? ""}:${action?.type ?? ""}:${action?.created_at ?? action?.createdAt ?? ""}`,
  );
}

async function collectRuntimeSmokeEvidence({
  baseUrl,
  mergeChainId,
  idempotencyPrefix,
  minimumMembers = 20,
  minimumSucceeded = 1,
  maximumDeferred = 5,
  maximumFailed = 0,
  maximumCancelled = 0,
  pollIntervalMs = 1000,
  timeoutMs = 10 * 60 * 1000,
  fetchImpl = fetch,
  sleepImpl = sleep,
  rollbackObservations = {},
  now = () => new Date(),
} = {}) {
  const normalizedBaseUrl = new URL(baseUrl).toString();
  const normalizedChainId = String(mergeChainId || "").trim();
  const normalizedPrefix = String(idempotencyPrefix || "").trim();
  if (!normalizedChainId || !normalizedPrefix) {
    throw new TypeError("mergeChainId and idempotencyPrefix are required");
  }

  const health = await requestJson(
    fetchImpl,
    new URL("/api/health", normalizedBaseUrl),
  );
  const dashboardBefore = await requestJson(
    fetchImpl,
    new URL("/api/dashboard", normalizedBaseUrl),
  );
  const directoryUrl = new URL("/api/catalog/items", normalizedBaseUrl);
  directoryUrl.searchParams.set("mergeChainId", normalizedChainId);
  directoryUrl.searchParams.set("pageSize", "200");
  directoryUrl.searchParams.set("sort", "chain-level");
  directoryUrl.searchParams.set("direction", "asc");
  const directory = await requestJson(fetchImpl, directoryUrl);
  const directoryMembers = Array.isArray(directory?.items) ? directory.items : [];
  if (!directoryMembers.length) {
    throw new Error(`merge chain is absent from the directory: ${normalizedChainId}`);
  }

  const selectedItemId = String(directoryMembers[0].itemId);
  const singleCreated = await postJson(
    fetchImpl,
    new URL("/api/catalog/icon-harvest-jobs", normalizedBaseUrl),
    {
      scope: { type: "item", itemId: selectedItemId },
      idempotencyKey: `${normalizedPrefix}-single`,
    },
  );
  const singleJob = await waitForJob({
    fetchImpl,
    baseUrl: normalizedBaseUrl,
    initialJob: singleCreated,
    pollIntervalMs,
    timeoutMs,
    sleepImpl,
  });

  const preflight = await postJson(
    fetchImpl,
    new URL("/api/catalog/icon-harvest-jobs/preflight", normalizedBaseUrl),
    {
      scope: { type: "merge-chain", mergeChainId: normalizedChainId },
    },
  );
  const frozenMembers = Array.isArray(preflight?.frozenMembers)
    ? preflight.frozenMembers
    : [];
  if (frozenMembers.length < Number(minimumMembers)) {
    throw new Error(
      `Merge-Chain Icon Harvest preflight returned ${frozenMembers.length} members; `
      + `${minimumMembers} required`,
    );
  }
  const chainRequest = {
    scope: { type: "merge-chain", mergeChainId: normalizedChainId },
    preflightId: preflight.preflightId,
    confirmed: true,
    idempotencyKey: `${normalizedPrefix}-chain`,
  };
  const chainCreated = await postJson(
    fetchImpl,
    new URL("/api/catalog/icon-harvest-jobs", normalizedBaseUrl),
    chainRequest,
  );
  const idempotentReplay = await postJson(
    fetchImpl,
    new URL("/api/catalog/icon-harvest-jobs", normalizedBaseUrl),
    chainRequest,
  );
  const chainJob = await waitForJob({
    fetchImpl,
    baseUrl: normalizedBaseUrl,
    initialJob: chainCreated,
    pollIntervalMs,
    timeoutMs,
    sleepImpl,
  });
  const children = Array.isArray(chainJob?.children) ? chainJob.children : [];
  const successfulChildren = children.filter((child) => child.state === "succeeded");
  const evidenceRecords = [];
  for (const child of successfulChildren) {
    const detail = await requestJson(
      fetchImpl,
      new URL(
        `/api/catalog/items/${encodeURIComponent(child.itemId)}`,
        normalizedBaseUrl,
      ),
    );
    const candidateId = child.result?.candidateId ?? null;
    const candidate = detailCandidates(detail).find((entry) =>
      String(entry?.candidateId) === String(candidateId));
    const persisted = candidateId != null
      && candidate != null
      && candidate.asset?.available === true
      && Boolean(candidate.technical?.provenance || candidate.sourceType);
    evidenceRecords.push({
      itemId: child.itemId,
      candidateId,
      persisted,
      acquisitionResult: child.result || null,
      detail,
    });
  }

  const directoryAfter = await requestJson(fetchImpl, directoryUrl);
  const afterMemberIds = new Set(
    (directoryAfter?.items || []).map((item) => String(item.itemId)),
  );
  const identityLoss = directoryMembers.some((item) =>
    !afterMemberIds.has(String(item.itemId)));
  const duplicateIdempotentWork = String(idempotentReplay?.jobId || "")
    !== String(chainCreated?.jobId || "");
  const dashboardAfter = await requestJson(
    fetchImpl,
    new URL("/api/dashboard", normalizedBaseUrl),
  );
  const beforeActions = new Set(
    (dashboardBefore?.actions || []).map(actionIdentity),
  );
  const generatedActions = (dashboardAfter?.actions || [])
    .filter((action) => !beforeActions.has(actionIdentity(action)));
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    baseUrl: normalizedBaseUrl,
    mergeChainId: normalizedChainId,
    health,
    readOnlyBrowse: {
      passed: Boolean(directory?.catalogQueryRevision)
        && Number(directory?.total) >= Number(minimumMembers),
      catalogQueryRevision: directory?.catalogQueryRevision || null,
      total: Number(directory?.total || 0),
      sampledMembers: directoryMembers.map((item) => item.itemId),
    },
    singleItemJob: {
      passed: singleJob?.state === "succeeded",
      jobId: singleJob?.jobId || null,
      snapshot: singleJob,
    },
    mergeChainPreflight: preflight,
    mergeChainJob: {
      passed: successfulTerminal(chainJob),
      jobId: chainJob?.jobId || null,
      state: chainJob?.state || null,
      finalStatus: chainJob?.finalStatus || null,
      gameActionsGenerated: generatedActions.length,
      generatedActions,
      children,
    },
    outcomeThresholds: {
      minimumMembers: Number(minimumMembers),
      minimumSucceeded: Number(minimumSucceeded),
      maximumDeferred: Number(maximumDeferred),
      maximumFailed: Number(maximumFailed),
      maximumCancelled: Number(maximumCancelled),
    },
    evidenceRecords,
    taskRecords: children,
    rollbackObservations: {
      ...rollbackObservations,
      identityLoss: Boolean(rollbackObservations.identityLoss) || identityLoss,
      duplicateIdempotentWork: Boolean(
        rollbackObservations.duplicateIdempotentWork,
      ) || duplicateIdempotentWork,
    },
  };
}

module.exports = {
  collectRuntimeSmokeEvidence,
};
