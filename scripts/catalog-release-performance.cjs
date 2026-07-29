#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  measureCatalogPerformance,
} = require("../src/catalog-release-performance");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const evidencePath = path.resolve(
  argument("--evidence", ".release-inputs/catalog-performance.json"),
);
const databasePath = path.resolve(
  argument("--database", ".release-work/catalog-performance/catalog.db"),
);
const evidence = measureCatalogPerformance({
  databasePath,
  catalogSize: Number(argument("--catalog-size", "5000")),
  queryThresholdMs: Number(argument("--query-threshold-ms", "250")),
  projectionRebuildThresholdMs: Number(
    argument("--rebuild-threshold-ms", "2000"),
  ),
});
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${evidencePath}\n`);
if (!evidence.passed) process.exitCode = 1;
