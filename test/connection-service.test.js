"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { ConnectionService } = require("../src/connection-service");

test("连接服务启动受管WMPF子进程并等待CDP端口", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "connection-service-"));
  fs.mkdirSync(path.join(rootDir, "wmpf", "src"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "wmpf", "src", "index.js"), "");
  const child = new EventEmitter();
  child.pid = 1234; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("exit", 0, "SIGTERM")); return true; };
  const terminalOut = new PassThrough();
  const terminalError = new PassThrough();
  let visibleOutput = "";
  let visibleError = "";
  terminalOut.on("data", (chunk) => { visibleOutput += chunk.toString("utf8"); });
  terminalError.on("data", (chunk) => { visibleError += chunk.toString("utf8"); });
  let probes = 0, spawnArgs = null;
  const service = new ConnectionService({
    rootDir, dataDir: path.join(rootDir, "data"), executable: "node.exe",
    spawnProcess: (...args) => { spawnArgs = args; return child; },
    probePort: async () => ++probes >= 3,
    stdout: terminalOut,
    stderr: terminalError,
  });
  const started = await service.start({ timeoutMs: 2000 });
  assert.equal(started.ok, true);
  assert.equal(started.managed, true);
  assert.equal(spawnArgs[0], "node.exe");
  assert.equal(spawnArgs[2].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spawnArgs[2].windowsHide, false);
  assert.deepEqual(spawnArgs[1].slice(1), ["--debug-main", "--debug-frida"]);
  child.stdout.write("route ready\n");
  child.stderr.write("route warning\n");
  assert.match(visibleOutput, /route ready/);
  assert.match(visibleError, /route warning/);
  const stopped = await service.stop();
  assert.equal(stopped.ok, true);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("连接服务识别已经存在的外部CDP路线且不重复启动", async () => {
  let spawned = false;
  const service = new ConnectionService({ rootDir: process.cwd(), dataDir: path.join(os.tmpdir(), "connection-external"), spawnProcess: () => { spawned = true; }, probePort: async () => true });
  const result = await service.start();
  assert.equal(result.reason, "external-route-detected");
  assert.equal(result.managed, false);
  assert.equal(spawned, false);
});

test("并发启动请求共享同一次CDP路线启动过程", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "connection-singleflight-"));
  fs.mkdirSync(path.join(rootDir, "wmpf", "src"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "wmpf", "src", "index.js"), "");
  const child = new EventEmitter();
  child.pid = 4321; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("exit", 0, "SIGTERM")); return true; };
  let spawnCount = 0, probes = 0;
  const service = new ConnectionService({
    rootDir, dataDir: path.join(rootDir, "data"),
    spawnProcess: () => { spawnCount += 1; return child; },
    probePort: async () => ++probes >= 4,
  });
  const first = service.start({ timeoutMs: 2000 });
  const second = service.start({ timeoutMs: 2000 });
  assert.equal(first, second);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(spawnCount, 1);
  await service.stop();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("自定义端口仍保留完整debug参数并追加端口覆盖", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "connection-debug-args-"));
  fs.mkdirSync(path.join(rootDir, "wmpf", "src"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "wmpf", "src", "index.js"), "");
  const child = new EventEmitter();
  child.pid = 5678; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("exit", 0, "SIGTERM")); return true; };
  let captured = null, probes = 0;
  const service = new ConnectionService({
    rootDir, dataDir: path.join(rootDir, "data"), cdpPort: 62001, debugPort: 9422,
    spawnProcess: (_exe, args) => { captured = args; return child; },
    probePort: async () => ++probes >= 3,
  });
  assert.equal((await service.start({ timeoutMs: 2000 })).ok, true);
  assert.deepEqual(captured.slice(1), ["--debug-main", "--debug-frida", "--cdp-port", "62001", "--debug-port", "9422"]);
  await service.stop();
  fs.rmSync(rootDir, { recursive: true, force: true });
});
