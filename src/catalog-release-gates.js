"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ZipArchive } = require("archiver");

const RELEASE_GATE_IDS = [
  "compatible-migration",
  "read-only-catalog",
  "icon-write",
];

const REQUIRED_MIGRATION_FIXTURES = [
  "fresh",
  "sanitized-legacy",
  "boundary",
];

const REQUIRED_STAGE_COMMAND_IDS = {
  "compatible-migration": ["migration-rehearsal", "migration-contract"],
  "read-only-catalog": ["api-contract", "catalog-performance", "browser-e2e"],
  "icon-write": [
    "job-contract",
    "repository-check",
    "web-build",
    "package-files",
    "real-runtime-smoke",
  ],
};

const FATAL_ROLLBACK_TRIGGERS = [
  ["identityLoss", "identity-loss"],
  ["humanRulingLoss", "human-ruling-loss"],
  ["humanSelectionLoss", "human-selection-loss"],
  ["crossIdentityWrite", "cross-identity-write"],
  ["duplicateIdempotentWork", "duplicate-idempotent-work"],
  ["revisionIsolationFailure", "revision-isolation-failure"],
  ["falseSuccessAfterSqliteFailure", "false-success-after-sqlite-failure"],
  ["oldEntryIncompatibility", "old-entry-incompatibility"],
];

function safeName(value) {
  return String(value || "command")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "command";
}

function isTrue(value) {
  return value === true || (Number.isFinite(Number(value)) && Number(value) > 0);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveArtifactPath(workspace, filePath) {
  if (!filePath) return null;
  return path.resolve(workspace, filePath);
}

function countValue(counts, key) {
  const value = Number(counts?.[key]);
  return Number.isFinite(value) ? value : null;
}

function validateMigrationEvidence(evidence) {
  const failures = [];
  const fixtures = Array.isArray(evidence?.fixtures) ? evidence.fixtures : [];
  for (const requiredName of REQUIRED_MIGRATION_FIXTURES) {
    const fixture = fixtures.find((entry) => entry?.name === requiredName);
    if (!fixture) {
      failures.push(`missing migration fixture: ${requiredName}`);
      continue;
    }
    if (!Array.isArray(fixture.rehearsals) || fixture.rehearsals.length !== 2) {
      failures.push(`${requiredName} must contain exactly two rehearsals`);
      continue;
    }
    const backupPaths = new Set();
    for (const [index, rehearsal] of fixture.rehearsals.entries()) {
      const label = `${requiredName} rehearsal ${index + 1}`;
      if (rehearsal?.passed !== true) failures.push(`${label} did not pass`);
      if (!rehearsal?.backup?.path || rehearsal.backup.readable !== true) {
        failures.push(`${label} lacks one readable backup`);
      } else {
        backupPaths.add(rehearsal.backup.path);
      }
      if (!rehearsal?.backup?.sha256) {
        failures.push(`${label} lacks a backup checksum`);
      }
      for (const key of ["identities", "rulings", "evidence", "audits"]) {
        const before = countValue(rehearsal?.counts?.before, key);
        const after = countValue(rehearsal?.counts?.after, key);
        if (before == null || after == null || after < before) {
          failures.push(`${label} reduced or omitted ${key}`);
        }
      }
      if (rehearsal?.auditInvariant !== true) {
        failures.push(`${label} did not preserve the audit invariant`);
      }
      if (rehearsal?.oldEntryReadWrite !== true) {
        failures.push(`${label} did not verify old-entry read/write compatibility`);
      }
      if (rehearsal?.legacySchemaObserved !== true) {
        failures.push(`${label} did not start from a genuine pre-v4 schema`);
      }
      if (requiredName === "boundary") {
        for (const [check, passed] of Object.entries(
          rehearsal?.boundaryChecks || {},
        )) {
          if (passed !== true) failures.push(`${label} failed boundary check: ${check}`);
        }
        if (Object.keys(rehearsal?.boundaryChecks || {}).length < 5) {
          failures.push(`${label} omitted required boundary checks`);
        }
      }
    }
    if (backupPaths.size !== 1) {
      failures.push(`${requiredName} must reuse one backup across both rehearsals`);
    }
    if (fixture.restore?.readable !== true || fixture.restore?.countsMatch !== true) {
      failures.push(`${requiredName} backup restore was not verified`);
    }
  }
  return failures;
}

function validatePerformanceEvidence(evidence, thresholds = {}) {
  const failures = [];
  const runs = Array.isArray(evidence?.runs) ? evidence.runs : [];
  const queryThresholdMs = Number(thresholds.queryP95Ms ?? 250);
  const rebuildThresholdMs = Number(thresholds.projectionRebuildMs ?? 2000);
  if (!Number.isInteger(Number(evidence?.catalogSize)) || Number(evidence.catalogSize) < 1) {
    failures.push("performance evidence must identify the realistic catalog size");
  }
  if (runs.length < 3) {
    failures.push("performance evidence requires at least three warmed runs");
    return failures;
  }
  for (const [index, run] of runs.slice(0, 3).entries()) {
    for (const metric of ["listMs", "searchMs", "detailMs"]) {
      const value = Number(run?.[metric]);
      if (!Number.isFinite(value) || value > queryThresholdMs) {
        failures.push(`performance run ${index + 1} ${metric} exceeds ${queryThresholdMs}ms`);
      }
    }
    const rebuild = Number(run?.projectionRebuildMs);
    if (!Number.isFinite(rebuild) || rebuild > rebuildThresholdMs) {
      failures.push(
        `performance run ${index + 1} projectionRebuildMs exceeds ${rebuildThresholdMs}ms`,
      );
    }
  }
  return failures;
}

function validateRuntimeSmokeEvidence(evidence) {
  const failures = [];
  const children = Array.isArray(evidence?.mergeChainJob?.children)
    ? evidence.mergeChainJob.children
    : [];
  const thresholds = evidence?.outcomeThresholds || {};
  const minimumMembers = Number(thresholds.minimumMembers ?? 20);
  const uniqueMembers = new Set(
    children.map((child) => String(child?.itemId || "").trim()).filter(Boolean),
  );
  if (uniqueMembers.size < minimumMembers || minimumMembers < 20) {
    failures.push(`real-runtime smoke requires at least 20 unique members`);
  }
  if (evidence?.readOnlyBrowse?.passed !== true) {
    failures.push("real-runtime read-only directory browse did not pass");
  }
  if (evidence?.singleItemJob?.passed !== true) {
    failures.push("real-runtime single-item Icon Harvest Job did not pass");
  }
  if (evidence?.mergeChainJob?.passed !== true) {
    failures.push("real-runtime Merge-Chain Icon Harvest did not pass");
  }
  const terminalState = String(
    evidence?.mergeChainJob?.finalStatus
    || evidence?.mergeChainJob?.state
    || "",
  );
  if (!["succeeded", "completed-with-gaps"].includes(terminalState)) {
    failures.push("real-runtime Merge-Chain Icon Harvest lacks a successful terminal state");
  }
  if (Number(evidence?.mergeChainJob?.gameActionsGenerated) !== 0) {
    failures.push("Merge-Chain Icon Harvest generated a game action");
  }

  const outcomes = {
    succeeded: children.filter((child) => child?.state === "succeeded").length,
    deferred: children.filter((child) => child?.state === "deferred").length,
    failed: children.filter((child) => child?.state === "failed").length,
    cancelled: children.filter((child) => child?.state === "cancelled").length,
  };
  const settled = Object.values(outcomes).reduce((sum, value) => sum + value, 0);
  if (settled !== children.length) failures.push("real-runtime task records contain unsettled children");
  if (outcomes.succeeded < Number(thresholds.minimumSucceeded ?? 1)) {
    failures.push("real-runtime success count is below its threshold");
  }
  const maximumDeferred = Number(thresholds.maximumDeferred);
  if (!Number.isFinite(maximumDeferred) || maximumDeferred < 0) {
    failures.push("real-runtime maximum deferred threshold must be finite and non-negative");
  } else if (outcomes.deferred > maximumDeferred) {
    failures.push("real-runtime deferred count exceeds its threshold");
  }
  if (outcomes.failed > Number(thresholds.maximumFailed ?? 0)) {
    failures.push("real-runtime failure count exceeds its threshold");
  }
  const maximumCancelled = Number(thresholds.maximumCancelled);
  if (!Number.isFinite(maximumCancelled) || maximumCancelled < 0) {
    failures.push("real-runtime maximum cancelled threshold must be finite and non-negative");
  } else if (outcomes.cancelled > maximumCancelled) {
    failures.push("real-runtime cancelled count exceeds its threshold");
  }
  const evidenceRecords = Array.isArray(evidence?.evidenceRecords)
    ? evidence.evidenceRecords
    : [];
  const taskRecords = Array.isArray(evidence?.taskRecords) ? evidence.taskRecords : [];
  if (taskRecords.length < children.length) {
    failures.push("real-runtime evidence does not retain every task record");
  }
  if (evidenceRecords.length < outcomes.succeeded) {
    failures.push("real-runtime evidence does not retain every successful evidence record");
  }
  const evidenceByItem = new Map(
    evidenceRecords.map((record) => [String(record?.itemId || ""), record]),
  );
  for (const child of children.filter((entry) => entry?.state === "succeeded")) {
    const record = evidenceByItem.get(String(child.itemId || ""));
    const expectedCandidateId = child?.result?.candidateId;
    const groups = record?.detail?.displayIcon?.candidates || {};
    const persistedCandidate = [
      ...(groups.currentDisplay || []),
      ...(groups.eligible || []),
      ...(groups.historical || []),
    ].find((candidate) =>
      String(candidate?.candidateId) === String(expectedCandidateId));
    if (expectedCandidateId == null
      || String(record?.candidateId) !== String(expectedCandidateId)
      || record.persisted !== true
      || persistedCandidate?.asset?.available !== true
      || !Boolean(
        persistedCandidate?.technical?.provenance
        || persistedCandidate?.sourceType,
      )) {
      failures.push(`real-runtime successful item lacks a persisted candidate: ${child.itemId}`);
    }
  }
  return failures;
}

function evaluateRollbackTriggers(observations = {}) {
  const triggers = FATAL_ROLLBACK_TRIGGERS
    .filter(([key]) => isTrue(observations[key]))
    .map(([, label]) => label);
  return {
    triggered: triggers.length > 0,
    triggers,
    action: triggers.length ? "disable-icon-write-entry" : "continue",
  };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyArtifact(sourcePath, artifactDir, usedNames) {
  let name = path.basename(sourcePath);
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  let suffix = 2;
  while (usedNames.has(name)) {
    name = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  usedNames.add(name);
  const destination = path.join(artifactDir, name);
  fs.copyFileSync(sourcePath, destination);
  return {
    source: sourcePath,
    bundledPath: path.relative(path.dirname(artifactDir), destination).replaceAll("\\", "/"),
    sha256: sha256(destination),
    bytes: fs.statSync(destination).size,
  };
}

function writeCommandLog(logPath, command, result) {
  const printable = [command.command, ...(command.args || [])].join(" ");
  const body = [
    `$ ${printable}`,
    `exitCode=${result.exitCode}`,
    `durationMs=${result.durationMs}`,
    "",
    "--- stdout ---",
    result.stdout || "",
    "",
    "--- stderr ---",
    result.stderr || "",
    "",
  ].join("\n");
  fs.writeFileSync(logPath, body);
}

function defaultCommandRunner(command, { workspace }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const executable = process.platform === "win32"
      && ["npm", "npx"].includes(command.command)
      ? `${command.command}.cmd`
      : command.command;
    const child = spawn(executable, command.args || [], {
      cwd: command.cwd ? path.resolve(workspace, command.cwd) : workspace,
      env: { ...process.env, ...(command.env || {}) },
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}${error.stack || error}`,
        durationMs: Math.round(durationMs),
      });
    });
    child.on("close", (exitCode) => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        stdout,
        stderr,
        durationMs: Math.round(durationMs),
      });
    });
  });
}

function artifactFailures(filePath, label) {
  if (!filePath) return [`${label} artifact path is required`];
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return [`${label} artifact is not readable: ${filePath}`];
  }
  return [];
}

function readEvidenceArtifact(filePath, label, failures, artifacts) {
  const unreadable = artifactFailures(filePath, label);
  failures.push(...unreadable);
  if (unreadable.length) return null;
  artifacts.push(filePath);
  try {
    return readJson(filePath);
  } catch (error) {
    failures.push(`${label} artifact contains invalid JSON: ${error.message}`);
    return null;
  }
}

function validCommand(command) {
  return Boolean(
    command
    && String(command.id || "").trim()
    && String(command.command || "").trim(),
  );
}

function printableCommand(command) {
  return validCommand(command)
    ? [command.command, ...(command.args || [])].join(" ")
    : "";
}

function stageValidation({ gateId, config, workspace }) {
  const failures = [];
  const artifacts = [];
  let rollback = null;
  const commandIds = new Set(
    (config.stages?.[gateId] || []).map((command) => String(command?.id || "")),
  );
  for (const requiredId of REQUIRED_STAGE_COMMAND_IDS[gateId]) {
    if (!commandIds.has(requiredId)) {
      failures.push(`${gateId} is missing required command: ${requiredId}`);
    }
  }
  if (gateId === "compatible-migration") {
    const migrationPath = resolveArtifactPath(workspace, config.artifacts?.migration);
    const evidence = readEvidenceArtifact(
      migrationPath,
      "migration",
      failures,
      artifacts,
    );
    if (evidence) failures.push(...validateMigrationEvidence(evidence));
  }
  if (gateId === "read-only-catalog") {
    const performancePath = resolveArtifactPath(workspace, config.artifacts?.performance);
    const evidence = readEvidenceArtifact(
      performancePath,
      "performance",
      failures,
      artifacts,
    );
    if (evidence) {
      failures.push(...validatePerformanceEvidence(
        evidence,
        config.performanceThresholds,
      ));
    }
    const screenshots = Array.isArray(config.artifacts?.screenshots)
      ? config.artifacts.screenshots
      : [];
    if (!screenshots.length) failures.push("at least one browser screenshot is required");
    for (const screenshot of screenshots) {
      const screenshotPath = resolveArtifactPath(workspace, screenshot);
      failures.push(...artifactFailures(screenshotPath, "browser screenshot"));
      if (screenshotPath
        && fs.existsSync(screenshotPath)
        && fs.statSync(screenshotPath).isFile()) {
        artifacts.push(screenshotPath);
      }
    }
  }
  if (gateId === "icon-write") {
    const runtimePath = resolveArtifactPath(workspace, config.artifacts?.runtimeSmoke);
    const runtimeEvidence = readEvidenceArtifact(
      runtimePath,
      "real-runtime smoke",
      failures,
      artifacts,
    );
    if (runtimeEvidence) {
      failures.push(...validateRuntimeSmokeEvidence(runtimeEvidence));
      rollback = evaluateRollbackTriggers(runtimeEvidence.rollbackObservations);
      if (rollback.triggered) {
        failures.push(`rollback trigger observed: ${rollback.triggers.join(", ")}`);
      }
    }
    for (const requiredFile of config.packaging?.requiredFiles || []) {
      const requiredPath = resolveArtifactPath(workspace, requiredFile);
      if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
        failures.push(`required package file is missing: ${requiredFile}`);
      }
    }
    for (const field of ["switchEntryMode", "switchServiceVersion", "restoreBackup"]) {
      if (!validCommand(config.rollback?.[field])) {
        failures.push(`rollback.${field} is required`);
      }
    }
  }
  return { failures, artifacts, rollback };
}

function renderSummary(manifest) {
  const lines = [
    `# Catalog release evidence: ${manifest.releaseId}`,
    "",
    `- Status: **${manifest.status}**`,
    `- Active entry mode: \`${manifest.activeEntryMode}\``,
    `- Decision owner: ${manifest.decisionOwner}`,
    `- Generated: ${manifest.generatedAt}`,
    `- Initial entry guard: ${manifest.entryModeGuard.status}`,
    `- Configuration: ${manifest.configurationFailures.length
      ? manifest.configurationFailures.join("; ")
      : "valid"}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Checks |",
    "| --- | --- | --- |",
  ];
  for (const gate of manifest.gates) {
    lines.push(`| ${gate.id} | ${gate.status} | ${gate.failures.length ? gate.failures.join("; ") : "passed"} |`);
  }
  lines.push(
    "",
    "## Rollback",
    "",
    `- Switch entry mode: \`${printableCommand(manifest.rollback.switchEntryMode)}\``,
    `- Switch service version: \`${printableCommand(manifest.rollback.switchServiceVersion)}\``,
    `- Restore backup: \`${printableCommand(manifest.rollback.restoreBackup)}\``,
    `- Executed rollback steps: ${manifest.rollback.execution.length}`,
    `- Activation: \`${printableCommand(manifest.activation.command)}\` (${manifest.activation.status})`,
    "",
    "## Known limitations",
    "",
  );
  if (manifest.knownLimitations.length) {
    for (const limitation of manifest.knownLimitations) lines.push(`- ${limitation}`);
  } else {
    lines.push("- None recorded.");
  }
  lines.push("");
  return lines.join("\n");
}

function createEvidenceArchive(sourceDir, archivePath) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const output = fs.createWriteStream(archivePath);
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function runReleaseGates({
  workspace,
  evidenceDir,
  config,
  commandRunner = defaultCommandRunner,
  now = () => new Date(),
}) {
  const resolvedWorkspace = path.resolve(workspace || process.cwd());
  const resolvedEvidenceDir = path.resolve(resolvedWorkspace, evidenceDir);
  const commandsDir = path.join(resolvedEvidenceDir, "commands");
  const artifactsDir = path.join(resolvedEvidenceDir, "artifacts");
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  const generatedAt = now().toISOString();
  const manifest = {
    schemaVersion: 1,
    releaseId: String(config.releaseId || "").trim(),
    generatedAt,
    decisionOwner: String(config.decisionOwner || "").trim(),
    status: "running",
    activeEntryMode: "unknown",
    configurationFailures: [],
    entryModeGuard: {
      command: config.entryModeGuard || null,
      status: "not-run",
      execution: null,
    },
    gates: [],
    artifacts: [],
    activation: {
      command: config.activation || null,
      status: "not-run",
      execution: null,
    },
    rollback: {
      switchEntryMode: config.rollback?.switchEntryMode || null,
      switchServiceVersion: config.rollback?.switchServiceVersion || null,
      restoreBackup: config.rollback?.restoreBackup || null,
      assessment: null,
      execution: [],
    },
    knownLimitations: Array.isArray(config.knownLimitations)
      ? config.knownLimitations.map(String)
      : [],
  };
  const usedArtifactNames = new Set();
  let blocked = false;
  let verifiedEntryMode = "unknown";

  const executeRecordedCommand = async (command, context = {}) => {
    let result;
    if (!validCommand(command)) {
      result = {
        exitCode: 1,
        stdout: "",
        stderr: "invalid command specification",
        durationMs: 0,
      };
    } else {
      try {
        result = await commandRunner(command, {
          workspace: resolvedWorkspace,
          ...context,
        });
      } catch (error) {
        result = {
          exitCode: 1,
          stdout: "",
          stderr: error.stack || String(error),
          durationMs: 0,
        };
      }
    }
    const logName = `${safeName(command?.id || context.logName)}.log`;
    const logPath = path.join(commandsDir, logName);
    writeCommandLog(logPath, command || {}, result);
    return {
      id: command?.id || context.logName || "invalid-command",
      command: printableCommand(command),
      exitCode: Number(result.exitCode),
      durationMs: Number(result.durationMs || 0),
      log: path.relative(resolvedEvidenceDir, logPath).replaceAll("\\", "/"),
    };
  };

  const executeRollback = async (gate) => {
    if (manifest.rollback.execution.length) return;
    for (const field of ["switchEntryMode", "switchServiceVersion"]) {
      const command = config.rollback?.[field];
      if (!validCommand(command)) continue;
      const execution = await executeRecordedCommand(command, {
        gateId: gate.id,
        operation: "rollback",
      });
      manifest.rollback.execution.push(execution);
      if (field === "switchEntryMode") {
        verifiedEntryMode = execution.exitCode === 0
          ? "legacy-advanced"
          : "unknown";
      }
      if (execution.exitCode !== 0) {
        gate.failures.push(`${execution.id} rollback exited with ${execution.exitCode}`);
      }
    }
  };

  if (!manifest.releaseId) {
    manifest.configurationFailures.push("releaseId is required");
  }
  if (!manifest.decisionOwner) {
    manifest.configurationFailures.push("decisionOwner is required");
  }
  if (!validCommand(config.entryModeGuard)) {
    manifest.configurationFailures.push("entryModeGuard command is required");
  }
  if (!manifest.configurationFailures.length) {
    const execution = await executeRecordedCommand(config.entryModeGuard, {
      operation: "entry-mode-guard",
    });
    manifest.entryModeGuard.execution = execution;
    manifest.entryModeGuard.status = execution.exitCode === 0 ? "passed" : "failed";
    if (execution.exitCode === 0) {
      verifiedEntryMode = "legacy-advanced";
    } else {
      manifest.configurationFailures.push(
        `${execution.id} entry-mode guard exited with ${execution.exitCode}`,
      );
    }
  }
  if (manifest.configurationFailures.length) blocked = true;

  for (const gateId of RELEASE_GATE_IDS) {
    const gate = {
      id: gateId,
      status: blocked ? "skipped" : "running",
      commands: [],
      failures: [],
      artifacts: [],
    };
    manifest.gates.push(gate);
    if (blocked) continue;

    const commands = Array.isArray(config.stages?.[gateId])
      ? config.stages[gateId]
      : [];
    if (!commands.length) gate.failures.push(`${gateId} has no commands`);
    for (const command of commands) {
      if (gate.failures.length) break;
      const execution = await executeRecordedCommand(command, {
        gateId,
      });
      gate.commands.push(execution);
      if (execution.exitCode !== 0) {
        gate.failures.push(`${execution.id} exited with ${execution.exitCode}`);
      }
    }

    const validation = stageValidation({
      gateId,
      config,
      workspace: resolvedWorkspace,
    });
    gate.failures.push(...validation.failures);
    if (validation.rollback) manifest.rollback.assessment = validation.rollback;
    for (const artifactPath of validation.artifacts) {
      const copied = copyArtifact(artifactPath, artifactsDir, usedArtifactNames);
      gate.artifacts.push(copied.bundledPath);
      manifest.artifacts.push(copied);
    }
    if (validation.rollback?.triggered) {
      await executeRollback(gate);
    }

    gate.status = gate.failures.length ? "failed" : "passed";
    if (gate.status === "failed") blocked = true;
  }

  if (!blocked) {
    const gate = manifest.gates.at(-1);
    if (!validCommand(config.activation)) {
      gate.failures.push("activation command is required");
      gate.status = "failed";
      manifest.activation.status = "failed";
      blocked = true;
    } else {
      const execution = await executeRecordedCommand(config.activation, {
        gateId: gate.id,
        operation: "activation",
      });
      gate.commands.push(execution);
      manifest.activation.execution = execution;
      manifest.activation.status = execution.exitCode === 0 ? "passed" : "failed";
      if (execution.exitCode !== 0) {
        gate.failures.push(`${execution.id} activation exited with ${execution.exitCode}`);
        gate.status = "failed";
        blocked = true;
        verifiedEntryMode = "unknown";
        await executeRollback(gate);
      } else {
        verifiedEntryMode = "full-snapshot";
      }
    }
  }

  manifest.status = blocked ? "blocked" : "passed";
  manifest.activeEntryMode = verifiedEntryMode;
  manifest.bundleArchive = `${path.basename(resolvedEvidenceDir)}.zip`;
  fs.writeFileSync(
    path.join(resolvedEvidenceDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(resolvedEvidenceDir, "SUMMARY.md"), renderSummary(manifest));
  await createEvidenceArchive(resolvedEvidenceDir, `${resolvedEvidenceDir}.zip`);
  return manifest;
}

module.exports = {
  FATAL_ROLLBACK_TRIGGERS,
  RELEASE_GATE_IDS,
  evaluateRollbackTriggers,
  runReleaseGates,
  validateMigrationEvidence,
  validatePerformanceEvidence,
  validateRuntimeSmokeEvidence,
};
