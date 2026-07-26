"use strict";

const INSTALLED = Symbol.for("merge-garden-copilot.broken-pipe-guard");

function guardStream(stream) {
  if (!stream?.on || stream[INSTALLED]) return;
  Object.defineProperty(stream, INSTALLED, { value: true, configurable: false });
  stream.on("error", (error) => {
    if (error?.code === "EPIPE") return;
    throw error;
  });
}

function installBrokenPipeGuards({ stdout = process.stdout, stderr = process.stderr } = {}) {
  guardStream(stdout);
  guardStream(stderr);
}

module.exports = { guardStream, installBrokenPipeGuards };
