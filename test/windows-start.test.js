"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Windows launcher owns a foreground process tree and streams logs in its terminal", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "Windows_start.bat"), "utf8");
  const probe = source.indexOf("scripts\\windows-start.ps1");
  const start = source.indexOf("node run.cjs");

  assert.ok(probe >= 0);
  assert.ok(start > probe);
  assert.match(source, /chcp 65001/i);
  assert.match(source, /-ReplaceExisting/i);
  assert.match(source.slice(probe, start), /if not "%LAUNCH_STATE%"=="10"/i);
  assert.match(source, /if not exist "node_modules\\"/i);
  assert.match(source, /node run\.cjs %\*/);
  assert.doesNotMatch(source, /start\s+[^\r\n]*node run\.cjs/i);
});

test("Windows startup probe replaces only this project's existing listener", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "windows-start.ps1"), "utf8");

  assert.match(source, /\[switch\]\$ReplaceExisting/);
  assert.match(source, /Invoke-WebRequest[\s\S]*-TimeoutSec 3/);
  assert.match(source, /StatusCode -eq 200[\s\S]*id="root"/);
  assert.match(source, /ReplaceExisting[\s\S]*Stop-ProcessTree/);
  assert.match(source, /Restarting unresponsive control console/);
  assert.match(source, /Stop-ProcessTree/);
  assert.match(source, /not started by this project/);
});

test("control process treats closing the terminal as a shutdown signal", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "..", "run.cjs"), "utf8");
  assert.match(source, /\["SIGINT",\s*"SIGTERM",\s*"SIGHUP"\]/);
  assert.match(source, /await runtime\.close\(\)/);
});
