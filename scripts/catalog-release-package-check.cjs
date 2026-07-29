#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "package.json",
  "run.cjs",
  "public/index.html",
  "scripts/catalog-release-entry-mode.cjs",
  "scripts/catalog-release-runtime-smoke.cjs",
  "wmpf/src/index.js",
  "wmpf/src/cdp_automation.js",
  "wmpf/frida/hook.js",
];
const failures = requiredFiles.filter((filePath) => {
  const absolutePath = path.join(root, filePath);
  return !fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile();
});
const fridaFiles = fs.existsSync(path.join(root, "wmpf", "frida"))
  ? fs.readdirSync(path.join(root, "wmpf", "frida"), { recursive: true })
    .filter((entry) => fs.statSync(path.join(root, "wmpf", "frida", entry)).isFile())
  : [];
if (!fridaFiles.length) failures.push("wmpf/frida/**/*");
process.stdout.write(`${JSON.stringify({
  requiredFiles,
  fridaFileCount: fridaFiles.length,
  failures,
}, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
