"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

function portOpen(port = 62000, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

class ConnectionService {
  constructor({ rootDir, dataDir, executable = process.execPath, spawnProcess = spawn, probePort = portOpen, onEvent = null, stdout = process.stdout, stderr = process.stderr, cdpPort = 62000, debugPort = 9421 } = {}) {
    this.rootDir = path.resolve(rootDir || path.join(__dirname, ".."));
    this.dataDir = path.resolve(dataDir || path.join(this.rootDir, "data"));
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.probePort = probePort;
    this.onEvent = onEvent;
    this.stdout = stdout;
    this.stderr = stderr;
    this.cdpPort = cdpPort;
    this.debugPort = debugPort;
    this.child = null;
    this.startedAt = null;
    this.lastError = null;
    this.startPromise = null;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.logPath = path.join(this.dataDir, "wmpf-cdp.log");
  }

  emit(state) { this.onEvent?.({ type: "connection-route", at: new Date().toISOString(), ...state }); }

  async status() {
    const listening = await this.probePort(this.cdpPort);
    return { listening, managed: !!this.child, starting: !!this.startPromise && !listening, debug: true, pid: this.child?.pid ?? null, cdpPort: this.cdpPort, debugPort: this.debugPort, startedAt: this.startedAt, lastError: this.lastError, logPath: this.logPath };
  }

  start(options = {}) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startRoute(options).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async startRoute({ timeoutMs = 15000 } = {}) {
    if (await this.probePort(this.cdpPort)) return { ok: true, reason: this.child ? "already-running" : "external-route-detected", ...(await this.status()) };
    if (this.child) await this.stop();
    const script = path.join(this.rootDir, "wmpf", "src", "index.js");
    if (!fs.existsSync(script)) return { ok: false, reason: "wmpf-entry-not-found", script };
    // 默认端口时与 `npm run wx:cdp:debug` 保持逐参数一致；这两个标志缺一不可。
    const args = [script, "--debug-main", "--debug-frida"];
    if (this.cdpPort !== 62000) args.push("--cdp-port", String(this.cdpPort));
    if (this.debugPort !== 9421) args.push("--debug-port", String(this.debugPort));
    const log = fs.createWriteStream(this.logPath, { flags: "a" });
    this.lastError = null;
    this.child = this.spawnProcess(this.executable, args, {
      cwd: this.rootDir,
      windowsHide: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.startedAt = new Date().toISOString();
    this.child.stdout?.pipe(log, { end: false });
    this.child.stderr?.pipe(log, { end: false });
    if (this.stdout) this.child.stdout?.pipe(this.stdout, { end: false });
    if (this.stderr) this.child.stderr?.pipe(this.stderr, { end: false });
    this.child.once("error", (error) => { this.lastError = error.message; this.emit({ running: false, error: error.message }); });
    this.child.once("exit", (code, signal) => { this.child = null; this.emit({ running: false, code, signal }); log.end(); });
    this.emit({ running: true, pid: this.child.pid });
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs));
    while (Date.now() < deadline) {
      if (await this.probePort(this.cdpPort)) return { ok: true, reason: "route-started", ...(await this.status()) };
      if (!this.child) break;
      await delay(250);
    }
    const error = this.lastError;
    await this.stop();
    return { ok: false, reason: error ? "route-process-error" : "route-start-timeout", error, logPath: this.logPath };
  }

  async stop() {
    const child = this.child;
    if (!child) return { ok: true, reason: "not-managed", ...(await this.status()) };
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      child.once("exit", finish);
      child.kill("SIGTERM");
      setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 2500);
      setTimeout(finish, 3500);
    });
    this.child = null;
    this.startedAt = null;
    return { ok: true, reason: "route-stopped", ...(await this.status()) };
  }
}

module.exports = { ConnectionService, portOpen };
