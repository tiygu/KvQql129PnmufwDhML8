#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { runReleaseGates } = require("../src/catalog-release-gates");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const configPath = path.resolve(
    argument("--config", "docs/catalog-release.example.json"),
  );
  const evidenceDir = path.resolve(
    argument("--evidence-dir", `.release-evidence/${Date.now()}`),
  );
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const manifest = await runReleaseGates({
    workspace: process.cwd(),
    evidenceDir,
    config,
  });
  process.stdout.write(`${path.join(evidenceDir, "manifest.json")}\n`);
  if (manifest.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
