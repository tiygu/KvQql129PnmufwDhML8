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
  if (outcomes.deferred > Number(thresholds.maximumDeferred ?? Number.MAX_SAFE_INTEGER)) {
    failures.push("real-runtime deferred count exceeds its threshold");
  }
  if (outcomes.failed > Number(thresholds.maximumFailed ?? 0)) {
    failures.push("real-runtime failure count exceeds its threshold");
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

function stageValidation({ gateId, config, workspace }) {
  const failures = [];
  const artifacts = [];
  let rollback = null;
  if (gateId === "compatible-migration") {
    const migrationPath = resolveArtifactPath(workspace, config.artifacts?.migration);
    failures.push(...artifactFailures(migrationPath, "migration"));
    if (!failures.length) {
      failures.push(...validateMigrationEvidence(readJson(migrationPath)));
      artifacts.push(migrationPath);
    }
  }
  if (gateId === "read-only-catalog") {
    const performancePath = resolveArtifactPath(workspace, config.artifacts?.performance);
    failures.push(...artifactFailures(performancePath, "performance"));
    if (!failures.length) {
      failures.push(...validatePerformanceEvidence(
        readJson(performancePath),
        config.performanceThresholds,
      ));
      artifacts.push(performancePath);
    }
    const screenshots = Array.isArray(config.artifacts?.screenshots)
      ? config.artifacts.screenshots
      : [];
    if (!screenshots.length) failures.push("at least one browser screenshot is required");
    for (const screenshot of screenshots) {
      const screenshotPath = resolveArtifactPath(workspace, screenshot);
      failures.push(...artifactFailures(screenshotPath, "browser screenshot"));
      if (fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).isFile()) {
        artifacts.push(screenshotPath);
      }
    }
  }
  if (gateId === "icon-write") {
    const runtimePath = resolveArtifactPath(workspace, config.artifacts?.runtimeSmoke);
    failures.push(...artifactFailures(runtimePath, "real-runtime smoke"));
    if (!failures.length) {
      const runtimeEvidence = readJson(runtimePath);
      failures.push(...validateRuntimeSmokeEvidence(runtimeEvidence));
      rollback = evaluateRollbackTriggers(runtimeEvidence.rollbackObservations);
      if (rollback.triggered) {
        failures.push(`rollback trigger observed: ${rollback.triggers.join(", ")}`);
      }
      artifacts.push(runtimePath);
    }
    for (const requiredFile of config.packaging?.requiredFiles || []) {
      const requiredPath = resolveArtifactPath(workspace, requiredFile);
      if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
        failures.push(`required package file is missing: ${requiredFile}`);
      }
    }
    for (const field of [
      "switchEntryModeCommand",
      "switchServiceVersionCommand",
      "restoreBackupCommand",
    ]) {
      if (!String(config.rollback?.[field] || "").trim()) {
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
    `- Switch entry mode: \`${manifest.rollback.switchEntryModeCommand}\``,
    `- Switch service version: \`${manifest.rollback.switchServiceVersionCommand}\``,
    `- Restore backup: \`${manifest.rollback.restoreBackupCommand}\``,
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
    activeEntryMode: "legacy-advanced",
    gates: [],
    artifacts: [],
    rollback: {
      switchEntryModeCommand: config.rollback?.switchEntryModeCommand || "",
      switchServiceVersionCommand: config.rollback?.switchServiceVersionCommand || "",
      restoreBackupCommand: config.rollback?.restoreBackupCommand || "",
      assessment: null,
    },
    knownLimitations: Array.isArray(config.knownLimitations)
      ? config.knownLimitations.map(String)
      : [],
  };
  const usedArtifactNames = new Set();
  let blocked = false;

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
      const result = await commandRunner(command, {
        workspace: resolvedWorkspace,
        gateId,
      });
      const logName = `${safeName(command.id)}.log`;
      const logPath = path.join(commandsDir, logName);
      writeCommandLog(logPath, command, result);
      gate.commands.push({
        id: command.id,
        command: [command.command, ...(command.args || [])].join(" "),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        log: path.relative(resolvedEvidenceDir, logPath).replaceAll("\\", "/"),
      });
      if (result.exitCode !== 0) {
        gate.failures.push(`${command.id} exited with ${result.exitCode}`);
      }
    }

    if (!gate.failures.length) {
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
    }

    gate.status = gate.failures.length ? "failed" : "passed";
    if (gate.status === "failed") blocked = true;
  }

  manifest.status = blocked ? "blocked" : "passed";
  manifest.activeEntryMode = blocked ? "legacy-advanced" : "full-snapshot";
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
