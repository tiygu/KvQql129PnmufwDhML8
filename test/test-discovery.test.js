"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const packageJson = require("../package.json");

test("repository test scripts exclude local worktrees from discovery", () => {
  assert.equal(packageJson.scripts.test, "node --test \"test/*.test.js\"");
  assert.match(packageJson.scripts.check, /(?:^|&& )node --test "test\/\*\.test\.js"$/);
});
