#!/usr/bin/env node
"use strict";

require("./load-env.cjs").loadEnvFiles(__dirname);

const { execFile } = require("node:child_process");
const path = require("node:path");
const { AutomationRuntime } = require("./src/automation-runtime");
const { createControlServer } = require("./src/control-server");
const { installBrokenPipeGuards } = require("./src/process-stream-guards");

installBrokenPipeGuards();

const args = new Set(process.argv.slice(2));
const manageConnectionRoute = !args.has("--external-cdp");
const openOnReady = !args.has("--no-open");
const host = process.env.CONTROL_HOST || process.env.FARM_GATEWAY_HOST || "127.0.0.1";
const port = Number(process.env.CONTROL_PORT || process.env.FARM_GATEWAY_PORT || 8787);
const dataDir = path.join(__dirname, "data");
let publishEvent = () => {};
let shuttingDown = false;
let connectionMaintenanceTimer = null;

const terminalEventTypes = new Set([
  "action-result",
  "automation-action",
  "automation-complete",
  "automation-error",
  "automation-status",
  "catalog-passive-evidence-error",
  "connection-route",
  "connection-route-error",
  "connection-route-ready",
  "decision",
  "icon-acquisition-error",
  "target-order-changed",
  "target-order-locked",
  "target-order-released",
  "warehouse-inventory-invalidated",
]);

function logRuntimeEvent(event) {
  const type = event?.type;
  if (!terminalEventTypes.has(type)) return;
  let detail = "";
  try {
    detail = JSON.stringify(event);
  } catch {
    detail = String(event);
  }
  if (detail.length > 1600) detail = `${detail.slice(0, 1600)}...`;
  console.log(`[runtime] ${detail}`);
}

const runtime = new AutomationRuntime({
  rootDir: __dirname,
  dataDir,
  manageConnectionRoute,
  onEvent: (event) => {
    logRuntimeEvent(event);
    publishEvent(event);
  },
});
const server = createControlServer({
  runtime,
  publicRoot: path.join(__dirname, "public"),
  dataDir,
});
publishEvent = server.broadcast;

function openBrowser(url) {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const commandArgs = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = execFile(command, commandArgs, { windowsHide: true }, () => {});
  child.unref();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (connectionMaintenanceTimer) clearInterval(connectionMaintenanceTimer);
  console.log(`[control] shutting down (${signal})`);
  await server.close().catch(() => {});
  await runtime.close().catch(() => {});
}

server.httpServer.listen(port, host, () => {
  const url = `http://${host}:${port}/`;
  console.log(`[control] console: ${url}`);
  console.log(`[control] websocket: ws://${host}:${port}${server.wsPath}`);
  console.log(`[control] CDP route: ${manageConnectionRoute ? "managed when absent" : "external"}`);
  if (openOnReady) openBrowser(url);
  if (manageConnectionRoute) {
    runtime.ensureConnectionRoute().catch((error) => {
      runtime.emit("connection-route-error", { error: error?.message || String(error) });
    });
    connectionMaintenanceTimer = setInterval(async () => {
      if (shuttingDown || !runtime.connectionAutoStartEnabled) return;
      const status = await runtime.connectionRouteStatus().catch(() => null);
      if (!status || status.listening || status.starting) return;
      runtime.ensureConnectionRoute().catch((error) => {
        runtime.emit("connection-route-error", { error: error?.message || String(error) });
      });
    }, 10000);
  }
});

server.httpServer.on("error", (error) => {
  console.error(`[control] server error: ${error.stack || error.message}`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown(signal).finally(() => process.exit(process.exitCode || 0)));
}
process.on("uncaughtException", (error) => {
  console.error(`[control] uncaughtException: ${error.stack || error.message}`);
  process.exitCode = 1;
  shutdown("uncaughtException").finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`[control] unhandledRejection: ${error.stack || error.message}`);
  process.exitCode = 1;
  shutdown("unhandledRejection").finally(() => process.exit(1));
});
