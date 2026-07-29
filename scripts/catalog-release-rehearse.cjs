#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runMigrationRehearsals } = require("../src/catalog-release-rehearsal");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const outputDir = path.resolve(
  argument("--output", ".release-work/catalog-migration"),
);
const evidencePath = path.resolve(
  argument("--evidence", ".release-inputs/catalog-migration.json"),
);
const evidence = runMigrationRehearsals({ outputDir });
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${evidencePath}\n`);
