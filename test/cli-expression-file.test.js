"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveEvalExpression } = require("../src/cli");

test("eval resolves a JavaScript expression from a file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-lab-expression-"));
  const expressionFile = path.join(directory, "probe.js");
  fs.writeFileSync(expressionFile, "(() => ({ ok: true }))()\n", "utf8");

  await assert.doesNotReject(async () => {
    const expression = await resolveEvalExpression({ "expression-file": expressionFile });
    assert.equal(expression, "(() => ({ ok: true }))()\n");
  });
});
