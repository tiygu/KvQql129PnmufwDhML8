"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

test("harvest control client exposes revisioned cancel/retry and reconnect notifications", () => {
  const api = fs.readFileSync(
    path.join(__dirname, "..", "web", "src", "control-api.ts"),
    "utf8",
  );

  assert.match(api, /cancelIconHarvestJob/);
  assert.match(api, /retryIconHarvestJob/);
  assert.match(api, /expectedRevision/);
  assert.match(api, /control-connected/);
  assert.match(api, /recoverAllJobs/);
  assert.match(api, /job\.revision\s*>\s*knownRevision\s*\+\s*1/);
  assert.match(api, /rest-gap/);
  assert.match(api, /rest-reconnect/);
});

test("harvest control client repairs gaps and never applies a stale REST revision", async () => {
  const original = {
    fetch: globalThis.fetch,
    location: globalThis.location,
    WebSocket: globalThis.WebSocket,
    window: globalThis.window,
  };
  const sockets = [];
  let listRevision = 1;
  const responses = [];
  class FakeWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }

    close() {
      this.readyState = 3;
    }

    emit(event) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  }

  globalThis.location = { protocol: "http:", host: "fixture.test" };
  globalThis.window = {
    setTimeout,
    clearTimeout,
  };
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url) => {
    const requestPath = String(url);
    responses.push(requestPath);
    const payload = requestPath.endsWith("/api/catalog/icon-harvest-jobs")
      ? { jobs: [{ jobId: "job-1", revision: listRevision }] }
      : { jobId: "job-1", revision: 3 };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const moduleUrl = `${pathToFileURL(path.join(
      __dirname,
      "..",
      "web",
      "src",
      "control-api.ts",
    )).href}?test=${Date.now()}`;
    const { controlApi } = await import(moduleUrl);
    const events = [];
    const stop = controlApi.onEvent((event) => events.push(event));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      events.filter((event) => event.job).map((event) => event.job.revision),
      [1],
    );

    sockets[0].emit({
      type: "icon-harvest-job-updated",
      job: { jobId: "job-1", revision: 3 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.at(-1).recovery, "rest-gap");

    listRevision = 2;
    sockets[0].emit({ type: "control-connected" });
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0].emit({
      type: "icon-harvest-job-updated",
      job: { jobId: "job-1", revision: 4 },
    });
    assert.deepEqual(
      events.filter((event) => event.job).map((event) => event.job.revision),
      [1, 3, 4],
    );
    assert.ok(responses.some((url) => url.endsWith("/job-1")));
    stop();
  } finally {
    globalThis.fetch = original.fetch;
    if (original.location === undefined) delete globalThis.location;
    else globalThis.location = original.location;
    if (original.WebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = original.WebSocket;
    if (original.window === undefined) delete globalThis.window;
    else globalThis.window = original.window;
  }
});
