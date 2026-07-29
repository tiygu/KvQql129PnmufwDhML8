"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AutomationDatabase } = require("./automation-database");
const { IconHarvestJobService } = require("./icon-harvest-jobs");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function rowCount(database, sql) {
  return Number(database.db.prepare(sql).get().count);
}

function catalogCounts(database) {
  return {
    identities: rowCount(
      database,
      "SELECT COUNT(*) AS count FROM catalog_repository_objects WHERE object_type='item-identity'",
    ),
    rulings: rowCount(
      database,
      `SELECT (
        (SELECT COUNT(*) FROM catalog_repository_rulings)
        + (SELECT COUNT(*) FROM catalog_review_resolutions)
      ) AS count`,
    ),
    evidence: rowCount(
      database,
      `SELECT (
        (SELECT COUNT(*) FROM catalog_repository_evidence)
        + (SELECT COUNT(*) FROM catalog_icon_candidates)
      ) AS count`,
    ),
    audits: rowCount(
      database,
      `SELECT (
        (SELECT COUNT(*) FROM catalog_audit_summaries)
        + (SELECT COUNT(*) FROM catalog_evidence_audit_summaries)
        + (SELECT COUNT(*) FROM catalog_icon_currency_history)
        + (SELECT COUNT(*) FROM catalog_icon_selection_history)
      ) AS count`,
    ),
  };
}

function countsPreserved(before, after) {
  return ["identities", "rulings", "evidence", "audits"]
    .every((key) => Number(after[key]) >= Number(before[key]));
}

function restoredCountsMatch(expected, actual) {
  return ["identities", "rulings", "evidence"]
    .every((key) => Number(actual[key]) === Number(expected[key]))
    && Number(actual.audits) >= Number(expected.audits);
}

function observeIdentity(database, objectId, name) {
  return database.observeCatalogObject({
    objectType: "item-identity",
    objectId,
    payload: {
      itemId: objectId,
      name,
      chainId: "release-chain",
      level: 1,
      type: "release-fixture",
    },
    sourceType: "runtime-capture",
    sourceRef: `${objectId}.json`,
    countDuplicate: false,
  });
}

function createAsset(fixtureDir, name, body = name) {
  const filePath = path.join(fixtureDir, `${name}.png`);
  const bytes = Buffer.from(body);
  fs.writeFileSync(filePath, bytes);
  return {
    hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    mimeType: "image/png",
    width: 2,
    height: 2,
    byteSize: bytes.length,
    filePath,
  };
}

function seedSanitizedLegacy(database, fixtureDir) {
  const observed = observeIdentity(database, "legacy-item", "Sanitized legacy item");
  database.completeCatalogReview({
    objectType: "item-identity",
    objectId: "legacy-item",
    decision: "modify",
    snapshot: {
      itemId: "legacy-item",
      name: "Human legacy item",
      chainId: "release-chain",
      level: 1,
      type: "release-fixture",
    },
    actor: "release-rehearsal",
    requestId: "legacy-resolution",
    expectedRevision: observed.revision,
  });
  database.saveIconCandidate({
    itemId: "legacy-item",
    cacheKey: "legacy-resource",
    sourceType: "unknown-legacy-source",
    runtimeIdentifier: "legacy/runtime/resource",
    autoSelect: true,
    asset: createAsset(fixtureDir, "legacy-resource"),
  });
}

function seedBoundary(database, fixtureDir) {
  const automatic = observeIdentity(
    database,
    "boundary-stale-automatic",
    "Boundary stale automatic",
  );
  database.saveIconCandidate({
    itemId: automatic.objectId,
    cacheKey: "boundary-runtime",
    sourceType: "unknown-legacy-source",
    runtimeIdentifier: "boundary/runtime/resource",
    autoSelect: true,
    asset: createAsset(fixtureDir, "boundary-runtime"),
  });

  observeIdentity(database, "boundary-manual", "Boundary protected manual");
  const manual = database.saveIconCandidate({
    itemId: "boundary-manual",
    cacheKey: "boundary-manual",
    sourceType: "user-upload",
    autoSelect: false,
    asset: createAsset(fixtureDir, "boundary-manual"),
  });
  const display = database.getCatalogObject("item-identity", "boundary-manual").displayIcon;
  database.selectIconCandidate("boundary-manual", manual.id, {
    actor: "release-rehearsal",
    note: "preserve the protected manual selection",
    expectedDisplayIconRevision: display.revision,
  });
  fs.rmSync(manual.filePath);

  const duplicate = {
    objectType: "item-identity",
    objectId: "boundary-duplicate-evidence",
    payload: {
      itemId: "boundary-duplicate-evidence",
      name: "Boundary duplicate evidence",
      chainId: "release-chain",
      level: 2,
    },
    sourceType: "runtime-capture",
    sourceRef: "boundary-duplicate.json",
  };
  database.observeCatalogObject(duplicate);
  database.observeCatalogObject(duplicate);

  const jobs = new IconHarvestJobService({ database });
  jobs.createSingleItem({
    itemId: "boundary-stale-automatic",
    idempotencyKey: "boundary-unfinished-job",
  });
}

function createPreMigrationFixture(name, fixtureDir) {
  const databasePath = path.join(fixtureDir, "catalog.db");
  const database = new AutomationDatabase(databasePath);
  try {
    if (name === "sanitized-legacy") seedSanitizedLegacy(database, fixtureDir);
    if (name === "boundary") seedBoundary(database, fixtureDir);
    const counts = catalogCounts(database);
    database.db.exec("PRAGMA user_version=3; DELETE FROM schema_migrations WHERE version=4;");
    return { databasePath, counts };
  } finally {
    database.close();
  }
}

function verifyOldEntryReadWrite(database) {
  const before = database.getCatalogReleaseControl();
  const requestedMode = before.entryMode === "legacy-advanced"
    ? "full-snapshot"
    : "legacy-advanced";
  const changed = database.setCatalogReleaseControl({ entryMode: requestedMode });
  const restored = database.setCatalogReleaseControl({ entryMode: before.entryMode });
  return changed.entryMode === requestedMode && restored.entryMode === before.entryMode;
}

function inspectRestoredBackup(backupPath, restoreDir) {
  fs.mkdirSync(restoreDir, { recursive: true });
  const restoredPath = path.join(restoreDir, "catalog-restored.db");
  fs.copyFileSync(backupPath, restoredPath);
  const restored = new AutomationDatabase(restoredPath);
  try {
    return {
      readable: true,
      counts: catalogCounts(restored),
      schema: restored.getCatalogSchemaStatus(),
    };
  } finally {
    restored.close();
  }
}

function runFixture(name, outputDir) {
  const fixtureDir = path.join(outputDir, name);
  fs.mkdirSync(fixtureDir, { recursive: true });
  const created = createPreMigrationFixture(name, fixtureDir);
  const backupPath = `${created.databasePath}.pre-v4.bak`;
  const rehearsals = [];
  let expectedBefore = created.counts;

  for (let run = 1; run <= 2; run += 1) {
    const database = new AutomationDatabase(created.databasePath);
    try {
      const after = catalogCounts(database);
      const oldEntryReadWrite = verifyOldEntryReadWrite(database);
      const backupReadable = fs.existsSync(backupPath)
        && fs.statSync(backupPath).isFile();
      const record = {
        run,
        passed: backupReadable
          && countsPreserved(expectedBefore, after)
          && oldEntryReadWrite,
        backup: {
          path: backupPath,
          readable: backupReadable,
          sha256: backupReadable ? sha256(backupPath) : null,
        },
        counts: {
          before: expectedBefore,
          after,
        },
        auditInvariant: Number(after.audits) >= Number(expectedBefore.audits),
        oldEntryReadWrite,
        schema: database.getCatalogSchemaStatus(),
      };
      rehearsals.push(record);
      expectedBefore = after;
    } finally {
      database.close();
    }
  }

  const restore = inspectRestoredBackup(
    backupPath,
    path.join(fixtureDir, "restore-check"),
  );
  return {
    name,
    databasePath: created.databasePath,
    rehearsals,
    restore: {
      ...restore,
      countsMatch: restoredCountsMatch(created.counts, restore.counts),
    },
  };
}

function runMigrationRehearsals({
  outputDir,
  now = () => new Date(),
} = {}) {
  const resolvedOutputDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    fixtures: [
      runFixture("fresh", resolvedOutputDir),
      runFixture("sanitized-legacy", resolvedOutputDir),
      runFixture("boundary", resolvedOutputDir),
    ],
  };
}

module.exports = {
  catalogCounts,
  runMigrationRehearsals,
};
