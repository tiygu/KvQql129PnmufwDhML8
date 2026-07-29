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
        legacySchemaObserved: true,
        boundaryChecks: name === "boundary" ? {
          staleAutomaticCleared: true,
          manualSelectionProtected: true,
          missingAssetRetained: true,
          duplicateEvidenceCounted: true,
          unfinishedJobRetained: true,
        } : null,
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
    result: index < 16 ? { candidateId: `candidate-runtime-member-${index + 1}` } : null,
  }));
  return {
    baseUrl: "http://127.0.0.1:3210",
    mergeChainId: "runtime-chain",
    readOnlyBrowse: { passed: true },
    singleItemJob: { passed: true, jobId: "job-single" },
    mergeChainJob: {
      passed: true,
      jobId: "job-chain",
      state: "completed-with-gaps",
      finalStatus: "completed-with-gaps",
      gameActionsGenerated: 0,
      children,
    },
    outcomeThresholds: {
      minimumMembers: 20,
      minimumSucceeded: 15,
      maximumDeferred: 4,
      maximumFailed: 1,
      maximumCancelled: 0,
    },
    evidenceRecords: children
      .filter((child) => child.state === "succeeded")
      .map((child) => ({
        itemId: child.itemId,
        candidateId: `candidate-${child.itemId}`,
        persisted: true,
        detail: {
          displayIcon: {
            candidates: {
              currentDisplay: [],
              eligible: [{
                candidateId: `candidate-${child.itemId}`,
                sourceType: "runtime-cache",
                asset: { available: true },
                technical: { provenance: { producer: "runtime-cache" } },
              }],
              historical: [],
            },
          },
        },
      })),
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

function requiredStages() {
  const commands = (ids) => ids.map((id) => ({ id, command: id }));
  return {
    "compatible-migration": commands([
      "migration-rehearsal",
      "migration-contract",
    ]),
    "read-only-catalog": commands([
      "api-contract",
      "catalog-performance",
      "browser-e2e",
    ]),
    "icon-write": commands([
      "job-contract",
      "repository-check",
      "web-build",
      "package-files",
      "real-runtime-smoke",
    ]),
  };
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
      const itemId = decodeURIComponent(url.pathname.split("/").at(-1));
      payload = {
        summary: { itemId },
        displayIcon: {
          candidates: {
            currentDisplay: [],
            eligible: [{
              candidateId: `candidate-${itemId}`,
              sourceType: "runtime-cache",
              asset: { available: true },
              technical: { provenance: { producer: "runtime-cache" } },
            }],
            historical: [],
          },
        },
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
  assert.equal(evidence.evidenceRecords.every((record) => record.persisted), true);
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
    entryModeGuard: {
      id: "guard-legacy-entry",
      command: "guard-legacy-entry",
    },
    stages: requiredStages(),
    activation: {
      id: "activate-full-snapshot",
      command: "activate-entry",
    },
    packaging: {
      requiredFiles: ["wmpf/frida/agent.js"],
    },
    rollback: {
      switchEntryMode: { id: "rollback-entry", command: "switch-entry" },
      switchServiceVersion: { id: "rollback-service", command: "switch-version" },
      restoreBackup: { id: "restore-backup", command: "restore-backup" },
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
      "guard-legacy-entry",
      "migration-rehearsal",
      "migration-contract",
      "api-contract",
      "catalog-performance",
      "browser-e2e",
      "job-contract",
      "repository-check",
      "web-build",
      "package-files",
      "real-runtime-smoke",
      "activate-entry",
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
    assert.equal(
      fs.existsSync(path.join(evidenceDir, "commands", "real-runtime-smoke.log")),
      true,
    );
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
        entryModeGuard: { id: "guard-legacy-entry", command: "guard-legacy-entry" },
        stages: requiredStages(),
        packaging: { requiredFiles: [] },
        rollback: {
          switchEntryMode: { id: "rollback-entry", command: "switch-entry" },
          switchServiceVersion: { id: "rollback-service", command: "switch-version" },
          restoreBackup: { id: "restore-backup", command: "restore-backup" },
        },
      },
      commandRunner: async (command) => {
        executed.push(command.id);
        return {
          exitCode: command.id === "migration-rehearsal" ? 1 : 0,
          stdout: "",
          stderr: "migration failed",
          durationMs: 5,
        };
      },
    });

    assert.deepEqual(executed, ["guard-legacy-entry", "migration-rehearsal"]);
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

test("runtime evidence rejects failed jobs, unbounded deferral, and missing persisted candidates", () => {
  const failed = runtimeEvidence();
  failed.mergeChainJob.state = "failed";
  failed.mergeChainJob.finalStatus = "failed";
  assert.match(validateRuntimeSmokeEvidence(failed).join("\n"), /successful terminal state/);

  const unbounded = runtimeEvidence();
  delete unbounded.outcomeThresholds.maximumDeferred;
  assert.match(validateRuntimeSmokeEvidence(unbounded).join("\n"), /maximum deferred threshold/);

  const missing = runtimeEvidence();
  missing.evidenceRecords[0].persisted = false;
  assert.match(validateRuntimeSmokeEvidence(missing).join("\n"), /persisted candidate/);

  const cancelled = runtimeEvidence();
  cancelled.mergeChainJob.children[15].state = "cancelled";
  assert.match(validateRuntimeSmokeEvidence(cancelled).join("\n"), /cancelled count/);
});

test("fatal runtime evidence executes rollback commands and does not activate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-rollback-"));
  const inputs = path.join(root, "inputs");
  const migrationPath = path.join(inputs, "migration.json");
  const performancePath = path.join(inputs, "performance.json");
  const runtimePath = path.join(inputs, "runtime.json");
  const screenshotPath = path.join(inputs, "catalog.png");
  const runtime = runtimeEvidence();
  runtime.rollbackObservations = { identityLoss: true };
  writeJson(migrationPath, migrationEvidence());
  writeJson(performancePath, performanceEvidence());
  writeJson(runtimePath, runtime);
  fs.writeFileSync(screenshotPath, "png");
  const executed = [];
  try {
    const manifest = await runReleaseGates({
      workspace: root,
      evidenceDir: path.join(root, "bundle"),
      config: {
        releaseId: "rollback-release",
        decisionOwner: "release-owner",
        artifacts: {
          migration: migrationPath,
          performance: performancePath,
          runtimeSmoke: runtimePath,
          screenshots: [screenshotPath],
        },
        entryModeGuard: { id: "guard-legacy-entry", command: "guard-legacy-entry" },
        stages: requiredStages(),
        activation: { id: "activate", command: "activate" },
        packaging: { requiredFiles: [] },
        rollback: {
          switchEntryMode: { id: "rollback-entry", command: "switch-entry" },
          switchServiceVersion: { id: "rollback-service", command: "switch-version" },
          restoreBackup: { id: "restore", command: "restore" },
        },
      },
      commandRunner: async (command) => {
        executed.push(command.command);
        return {
          exitCode: command.id === "real-runtime-smoke" ? 1 : 0,
          stdout: "",
          stderr: command.id === "real-runtime-smoke"
            ? "runtime validator blocked"
            : "",
          durationMs: 1,
        };
      },
    });
    assert.deepEqual(executed, [
      "guard-legacy-entry",
      "migration-rehearsal",
      "migration-contract",
      "api-contract",
      "catalog-performance",
      "browser-e2e",
      "job-contract",
      "repository-check",
      "web-build",
      "package-files",
      "real-runtime-smoke",
      "switch-entry",
      "switch-version",
    ]);
    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.activeEntryMode, "legacy-advanced");
    assert.deepEqual(
      manifest.rollback.execution.map((entry) => entry.id),
      ["rollback-entry", "rollback-service"],
    );
    assert.equal(fs.existsSync(path.join(root, "bundle", "commands", "rollback-entry.log")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed gate evidence still emits a blocked review bundle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-malformed-"));
  const migrationPath = path.join(root, "migration.json");
  fs.writeFileSync(migrationPath, "{\"fixtures\":");
  try {
    const manifest = await runReleaseGates({
      workspace: root,
      evidenceDir: path.join(root, "bundle"),
      config: {
        releaseId: "malformed-release",
        decisionOwner: "release-owner",
        artifacts: { migration: migrationPath },
        entryModeGuard: { id: "guard-legacy-entry", command: "guard-legacy-entry" },
        stages: requiredStages(),
        packaging: { requiredFiles: [] },
        rollback: {
          switchEntryMode: { id: "rollback-entry", command: "switch-entry" },
          switchServiceVersion: { id: "rollback-service", command: "switch-version" },
          restoreBackup: { id: "restore", command: "restore" },
        },
      },
      commandRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
    });
    assert.equal(manifest.status, "blocked");
    assert.match(manifest.gates[0].failures.join("\n"), /invalid JSON/);
    assert.equal(fs.existsSync(path.join(root, "bundle", "manifest.json")), true);
    assert.equal(fs.existsSync(`${path.join(root, "bundle")}.zip`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release configuration requires ownership, a verified legacy guard, and mandatory commands", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-config-"));
  const migrationPath = path.join(root, "migration.json");
  writeJson(migrationPath, migrationEvidence());
  try {
    const missingOwner = await runReleaseGates({
      workspace: root,
      evidenceDir: path.join(root, "ownerless"),
      config: {
        releaseId: "ownerless-release",
        decisionOwner: "",
        entryModeGuard: { id: "guard", command: "guard" },
        stages: requiredStages(),
        artifacts: { migration: migrationPath },
      },
      commandRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
    });
    assert.equal(missingOwner.status, "blocked");
    assert.equal(missingOwner.activeEntryMode, "unknown");
    assert.match(missingOwner.configurationFailures.join("\n"), /decisionOwner/);

    const missingCommands = await runReleaseGates({
      workspace: root,
      evidenceDir: path.join(root, "short-plan"),
      config: {
        releaseId: "short-plan-release",
        decisionOwner: "release-owner",
        entryModeGuard: { id: "guard", command: "guard" },
        stages: {
          ...requiredStages(),
          "compatible-migration": [{
            id: "migration-rehearsal",
            command: "migration-rehearsal",
          }],
        },
        artifacts: { migration: migrationPath },
      },
      commandRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
    });
    assert.equal(missingCommands.status, "blocked");
    assert.equal(missingCommands.activeEntryMode, "legacy-advanced");
    assert.match(
      missingCommands.gates[0].failures.join("\n"),
      /missing required command: migration-contract/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed initial entry guard reports unknown mode and skips every gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-release-guard-"));
  try {
    const manifest = await runReleaseGates({
      workspace: root,
      evidenceDir: path.join(root, "bundle"),
      config: {
        releaseId: "guard-failure",
        decisionOwner: "release-owner",
        entryModeGuard: { id: "guard", command: "guard" },
        stages: requiredStages(),
      },
      commandRunner: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "mode readback mismatch",
        durationMs: 1,
      }),
    });
    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.activeEntryMode, "unknown");
    assert.equal(manifest.entryModeGuard.status, "failed");
    assert.deepEqual(manifest.gates.map((gate) => gate.status), [
      "skipped",
      "skipped",
      "skipped",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
