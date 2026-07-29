"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  evaluateRollbackTriggers,
  runReleaseGates,
  validateMigrationEvidence,
  validatePerformanceEvidence,
  validateRuntimeSmokeEvidence,
} = require("../src/catalog-release-gates");
const {
  runMigrationRehearsals,
} = require("../src/catalog-release-rehearsal");
const {
  measureCatalogPerformance,
} = require("../src/catalog-release-performance");
const {
  collectRuntimeSmokeEvidence,
} = require("../src/catalog-release-runtime-smoke");

function migrationEvidence() {
  return {
    fixtures: ["fresh", "sanitized-legacy", "boundary"].map((name) => ({
      name,
      rehearsals: [1, 2].map((run) => ({
        run,
        passed: true,
        backup: {
          path: `${name}.pre-v4.bak`,
          readable: true,
          sha256: `${name}-backup`,
        },
        counts: {
          before: { identities: 3, rulings: 1, evidence: 2, audits: 4 },
          after: { identities: 3, rulings: 1, evidence: 2, audits: 4 },
        },
        auditInvariant: true,
        oldEntryReadWrite: true,
      })),
      restore: {
        readable: true,
        countsMatch: true,
      },
    })),
  };
}

function performanceEvidence() {
  return {
    catalogSize: 5000,
    runs: [
      { listMs: 80, searchMs: 100, detailMs: 20, projectionRebuildMs: 800 },
      { listMs: 90, searchMs: 110, detailMs: 25, projectionRebuildMs: 900 },
      { listMs: 85, searchMs: 105, detailMs: 23, projectionRebuildMs: 850 },
    ],
  };
}

function runtimeEvidence() {
  const children = Array.from({ length: 20 }, (_, index) => ({
    itemId: `runtime-member-${index + 1}`,
    state: index < 16 ? "succeeded" : index < 19 ? "deferred" : "failed",
    reason: index < 16 ? null : index < 19 ? "resource-unloaded" : "quality-rejected",
  }));
  return {
    baseUrl: "http://127.0.0.1:3210",
    mergeChainId: "runtime-chain",
    readOnlyBrowse: { passed: true },
    singleItemJob: { passed: true, jobId: "job-single" },
    mergeChainJob: {
      passed: true,
      jobId: "job-chain",
      gameActionsGenerated: 0,
      children,
    },
    outcomeThresholds: {
      minimumMembers: 20,
      minimumSucceeded: 15,
      maximumDeferred: 4,
      maximumFailed: 1,
    },
    evidenceRecords: children
      .filter((child) => child.state === "succeeded")
      .map((child) => ({ itemId: child.itemId, candidateId: `candidate-${child.itemId}` })),
    taskRecords: children.map((child) => ({
      itemId: child.itemId,
      state: child.state,
      reason: child.reason,
    })),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("release evidence validators enforce database, performance, and real-runtime gates", () => {
  assert.deepEqual(validateMigrationEvidence(migrationEvidence()), []);
  assert.deepEqual(validatePerformanceEvidence(performanceEvidence()), []);
  assert.deepEqual(validateRuntimeSmokeEvidence(runtimeEvidence()), []);

  const invalidMigration = migrationEvidence();
  invalidMigration.fixtures[1].rehearsals.pop();
  assert.match(validateMigrationEvidence(invalidMigration).join("\n"), /two rehearsals/);

  const slow = performanceEvidence();
  slow.runs[2].searchMs = 251;
  assert.match(validatePerformanceEvidence(slow).join("\n"), /searchMs/);

  const tooSmall = runtimeEvidence();
  tooSmall.mergeChainJob.children.pop();
  tooSmall.taskRecords.pop();
  assert.match(validateRuntimeSmokeEvidence(tooSmall).join("\n"), /20 unique members/);
});

test("migration rehearsal runs fresh, sanitized legacy, and boundary fixtures twice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-rehearsal-"));
  try {
    const evidence = runMigrationRehearsals({
      outputDir: root,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });

    assert.deepEqual(evidence.fixtures.map((fixture) => fixture.name), [
      "fresh",
      "sanitized-legacy",
      "boundary",
    ]);
    assert.deepEqual(
      evidence.fixtures.map((fixture) => fixture.rehearsals.length),
      [2, 2, 2],
    );
    assert.deepEqual(validateMigrationEvidence(evidence), []);
    for (const fixture of evidence.fixtures) {
      assert.equal(fixture.rehearsals[0].backup.sha256, fixture.rehearsals[1].backup.sha256);
      assert.equal(fixture.restore.readable, true);
      assert.equal(fixture.restore.countsMatch, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("performance rehearsal records three warmed list, search, detail, and rebuild runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-performance-"));
  try {
    const evidence = measureCatalogPerformance({
      databasePath: path.join(root, "catalog.db"),
      catalogSize: 200,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });

    assert.equal(evidence.catalogSize, 200);
    assert.equal(evidence.runs.length, 3);
    assert.equal(evidence.queryThresholdMs, 250);
    assert.equal(evidence.projectionRebuildThresholdMs, 2000);
    assert.equal(evidence.sampleItemId, "release-item-000100");
    assert.deepEqual(validatePerformanceEvidence(evidence), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real-runtime collector preserves 20 member task and evidence records", async () => {
  const members = Array.from({ length: 20 }, (_, index) => ({
    itemId: `live-member-${index + 1}`,
  }));
  const children = members.map((member) => ({
    itemId: member.itemId,
    state: "succeeded",
    result: { candidateId: `candidate-${member.itemId}` },
  }));
  const responses = [];
  const fakeFetch = async (input, options = {}) => {
    const url = new URL(input);
    const body = options.body ? JSON.parse(options.body) : null;
    responses.push([options.method || "GET", url.pathname, body]);
    let payload;
    if (url.pathname === "/api/health") payload = { ok: true };
    else if (url.pathname === "/api/dashboard") payload = { actions: [] };
    else if (url.pathname === "/api/catalog/items") {
      payload = {
        catalogQueryRevision: "catalog-query-v1:live",
        total: members.length,
        items: members,
      };
    } else if (url.pathname === "/api/catalog/icon-harvest-jobs/preflight") {
      payload = {
        preflightId: "preflight-live",
        mergeChainId: "live-chain",
        frozenMembers: members,
      };
    } else if (url.pathname === "/api/catalog/icon-harvest-jobs"
      && body.scope.type === "item") {
      payload = {
        jobId: "job-single-live",
        state: "succeeded",
        finalStatus: "succeeded",
        children: [{ itemId: body.scope.itemId, state: "succeeded" }],
      };
    } else if (url.pathname === "/api/catalog/icon-harvest-jobs") {
      payload = {
        jobId: "job-chain-live",
        state: "succeeded",
        finalStatus: "succeeded",
        children,
      };
    } else if (url.pathname.startsWith("/api/catalog/items/")) {
      payload = {
        summary: { itemId: decodeURIComponent(url.pathname.split("/").at(-1)) },
        iconEvidence: { currentDisplay: null, eligibleCandidates: [] },
      };
    } else {
      throw new Error(`unexpected request: ${url.pathname}`);
    }
    return {
      ok: true,
      status: 200,
      async json() { return payload; },
    };
  };

  const evidence = await collectRuntimeSmokeEvidence({
    baseUrl: "http://127.0.0.1:3210",
    mergeChainId: "live-chain",
    idempotencyPrefix: "release-live",
    fetchImpl: fakeFetch,
    now: () => new Date("2026-07-29T12:00:00.000Z"),
  });

  assert.equal(evidence.mergeChainJob.children.length, 20);
  assert.equal(evidence.taskRecords.length, 20);
  assert.equal(evidence.evidenceRecords.length, 20);
  assert.equal(evidence.mergeChainJob.gameActionsGenerated, 0);
  assert.deepEqual(validateRuntimeSmokeEvidence(evidence), []);
  assert.equal(
    responses.some(([, route]) => route === "/api/catalog/icon-harvest-jobs/preflight"),
    true,
  );
});

test("fatal rollback observations disable icon writes while expected gaps do not", () => {
  assert.deepEqual(evaluateRollbackTriggers({
    deferred: 8,
    queueFull: 2,
    operatorCancelled: 1,
    unloadedResources: 4,
    qualityRejected: 3,
  }), {
    triggered: false,
    triggers: [],
    action: "continue",
  });

  assert.deepEqual(evaluateRollbackTriggers({
    identityLoss: 1,
    falseSuccessAfterSqliteFailure: true,
    deferred: 3,
  }), {
    triggered: true,
    triggers: ["identity-loss", "false-success-after-sqlite-failure"],
    action: "disable-icon-write-entry",
  });
});

test("release gates are sequential and emit a reviewable evidence bundle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-gates-"));
  const evidenceDir = path.join(root, "bundle");
  const artifactsDir = path.join(root, "inputs");
  const migrationPath = path.join(artifactsDir, "migration.json");
  const performancePath = path.join(artifactsDir, "performance.json");
  const runtimePath = path.join(artifactsDir, "runtime.json");
  const screenshotPath = path.join(artifactsDir, "catalog.png");
  writeJson(migrationPath, migrationEvidence());
  writeJson(performancePath, performanceEvidence());
  writeJson(runtimePath, runtimeEvidence());
  fs.writeFileSync(screenshotPath, "png");
  fs.mkdirSync(path.join(root, "wmpf", "frida"), { recursive: true });
  fs.writeFileSync(path.join(root, "wmpf", "frida", "agent.js"), "fixture");

  const executed = [];
  const config = {
    releaseId: "catalog-icons-2026-07-29",
    decisionOwner: "release-owner",
    knownLimitations: ["Real runtime remains operator initiated."],
    artifacts: {
      migration: migrationPath,
      performance: performancePath,
      runtimeSmoke: runtimePath,
      screenshots: [screenshotPath],
    },
    stages: {
      "compatible-migration": [{ id: "migration", command: "migration-check" }],
      "read-only-catalog": [
        { id: "contract", command: "contract-check" },
        { id: "browser", command: "browser-check" },
      ],
      "icon-write": [
        { id: "repository", command: "npm-check" },
        { id: "web-build", command: "web-build" },
        { id: "runtime", command: "runtime-smoke" },
      ],
    },
    packaging: {
      requiredFiles: ["wmpf/frida/agent.js"],
    },
    rollback: {
      switchEntryModeCommand: "catalog release-control legacy-advanced",
      switchServiceVersionCommand: "deploy previous-service-version",
      restoreBackupCommand: "stop service && restore BACKUP_PATH",
    },
  };

  try {
    const manifest = await runReleaseGates({
      workspace: root,
      evidenceDir,
      config,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
      commandRunner: async (command) => {
        executed.push(command.command);
        return {
          exitCode: 0,
          stdout: `${command.id} passed`,
          stderr: "",
          durationMs: 10,
        };
      },
    });

    assert.deepEqual(executed, [
      "migration-check",
      "contract-check",
      "browser-check",
      "npm-check",
      "web-build",
      "runtime-smoke",
    ]);
    assert.equal(manifest.status, "passed");
    assert.equal(manifest.activeEntryMode, "full-snapshot");
    assert.deepEqual(
      manifest.gates.map((gate) => [gate.id, gate.status]),
      [
        ["compatible-migration", "passed"],
        ["read-only-catalog", "passed"],
        ["icon-write", "passed"],
      ],
    );
    assert.equal(fs.existsSync(path.join(evidenceDir, "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(evidenceDir, "SUMMARY.md")), true);
    assert.equal(fs.existsSync(`${evidenceDir}.zip`), true);
    assert.equal(fs.existsSync(path.join(evidenceDir, "commands", "runtime.log")), true);
    assert.equal(fs.existsSync(path.join(evidenceDir, "artifacts", "catalog.png")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed gate blocks later stages and records rollback-ready state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-blocked-"));
  const migrationPath = path.join(root, "migration.json");
  writeJson(migrationPath, migrationEvidence());
  const executed = [];

  try {
    const manifest = await runReleaseGates({
      workspace: root,
      evidenceDir: path.join(root, "bundle"),
      config: {
        releaseId: "blocked-release",
        decisionOwner: "release-owner",
        knownLimitations: [],
        artifacts: { migration: migrationPath },
        stages: {
          "compatible-migration": [{ id: "migration", command: "migration-check" }],
          "read-only-catalog": [{ id: "contract", command: "contract-check" }],
          "icon-write": [{ id: "runtime", command: "runtime-smoke" }],
        },
        packaging: { requiredFiles: [] },
        rollback: {
          switchEntryModeCommand: "switch-entry",
          switchServiceVersionCommand: "switch-version",
          restoreBackupCommand: "restore-backup",
        },
      },
      commandRunner: async (command) => {
        executed.push(command.id);
        return {
          exitCode: command.id === "migration" ? 1 : 0,
          stdout: "",
          stderr: "migration failed",
          durationMs: 5,
        };
      },
    });

    assert.deepEqual(executed, ["migration"]);
    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.activeEntryMode, "legacy-advanced");
    assert.deepEqual(
      manifest.gates.map((gate) => gate.status),
      ["failed", "skipped", "skipped"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
