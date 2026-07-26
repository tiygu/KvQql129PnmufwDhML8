#!/usr/bin/env node
"use strict";

const util = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const { getConfig } = require("./config");
const { AdapterLab } = require("./lab");
const { scaffoldAdapter } = require("./scaffold");
const { summarizeSnapshot } = require("../scripts/summarize-target-snapshot.cjs");
const { buildStatusReport, printStatusReport } = require("./status-report");
const { BOARD_SCAN_EXPRESSION, printBoardScan, buildBoardMergeExpression, printBoardMerge } = require("./board-automation");
const { BoardAutomationRunner, printBoardRunnerResult } = require("./board-runner");
const { buildOptimizationPlan, printOptimizationPlan } = require("./order-optimizer");
const { buildGameState } = require("./game-state");
const { OrderSubmitter } = require("./order-actions");
const { MapMissionCompleter } = require("./map-actions");
const { WarehouseActionExecutor } = require("./warehouse-actions");
const { OrderCoinLoop } = require("./order-coin-loop");
const { SceneNavigator } = require("./scene-navigation");
const { FullAutomationLoop } = require("./full-automation-loop");
const { AutomationDatabase } = require("./automation-database");
const { migrateLegacyCatalog } = require("./catalog-migration");

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) result._.push(value);
    else {
      const [key, inline] = value.slice(2).split("=", 2);
      result[key] = inline === undefined ? argv[++i] : inline;
    }
  }
  return result;
}

function printHelp() {
  console.log(`Mini Game Adapter Lab

Usage:
  node src/cli.js inspect [--url ws://127.0.0.1:62000] [--json true]
  node src/cli.js snapshot [--url URL] [--out snapshot.json]
  node src/cli.js status [--url URL] [--json true] [--out status.json]
  node src/cli.js game-state [--url URL] [--out game-state.json]
  node src/cli.js board-scan [--url URL] [--json true] [--out board-scan.json]
  node src/cli.js board-merge --from INDEX --to INDEX [--execute true] [--json true]
  node src/cli.js board-auto [--producer INDEX] [--max-actions 10] [--delay-ms 1200] [--execute true]
  node src/cli.js order-submit --slot SLOT [--execute true] [--json true]
  node src/cli.js map-complete [--execute true] [--json true]
  node src/cli.js warehouse-open [--execute true] [--json true]
  node src/cli.js warehouse-store --index INDEX [--execute true] [--json true]
  node src/cli.js orders-auto [--max-actions N] [--execute true] [--json true]
  node src/cli.js auto-loop [--max-actions N] [--auto-map-upgrade true] [--execute true]
  node src/cli.js db-init [--db data/automation.db]
  node src/cli.js catalog-import [--catalog captures/item-catalog.json] [--db data/automation.db]
  node src/cli.js catalog-export [--db data/automation.db] [--out catalog-repository.json]
  node src/cli.js plan [--db data/automation.db] [--json true] [--out plan.json]
  node src/cli.js eval --context ID --expression "1 + 1" [--expression-file FILE] [--url URL]
  node src/cli.js watch [--url URL]
  node src/cli.js scaffold --name game-id --engine cocos
`);
}

function summarizeProbe(item) {
  return {
    id: item.context.id,
    name: item.context.name || "",
    origin: item.context.origin || "",
    score: item.score,
    engines: item.detectedEngines.map((engine) => engine.label).join(", ") || "unknown",
    wx: !!item.data?.environment?.hasWx,
    gameGlobal: !!item.data?.environment?.hasGameGlobal,
    canvas: !!item.data?.environment?.hasCanvas,
    error: item.error || "",
  };
}

async function withLab(args, action) {
  const lab = new AdapterLab(getConfig({ url: args.url }));
  try {
    return await action(lab);
  } finally {
    await lab.close();
  }
}

async function resolveEvalExpression(args) {
  return args["expression-file"]
    ? fs.readFile(path.resolve(String(args["expression-file"])), "utf8")
    : args.expression;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  if (command === "help" || command === "--help") return printHelp();

  if (command === "scaffold") {
    const target = await scaffoldAdapter(args.name, args.engine || "unknown");
    console.log(target);
    return;
  }

  if (command === "db-init" || command === "catalog-import" || command === "catalog-export") {
    const database = new AutomationDatabase(args.db || "data/automation.db");
    try {
      if (command === "db-init") {
        console.log(`Database initialized: ${database.filePath}`);
        console.log(JSON.stringify(database.getCatalogStats(), null, 2));
      } else if (command === "catalog-import") {
        const catalogPath = path.resolve(String(args.catalog || "captures/item-catalog.json"));
        const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
        const stats = catalog.source?.type === "sqlite-catalog-repository"
          ? database.importCatalogSnapshot(catalog, { sourceFile: catalogPath })
          : migrateLegacyCatalog(database, catalog, { sourceFile: catalogPath, historicActions: database.listAttributableProductionActions() });
        console.log(`Catalog imported: ${database.filePath}`);
        console.log(JSON.stringify(stats, null, 2));
      } else {
        const target = path.resolve(String(args.out || "catalog-repository.json"));
        await fs.writeFile(target, JSON.stringify(database.exportCatalogSnapshot(), null, 2) + "\n", "utf8");
        console.log(`Catalog exported: ${target}`);
      }
    } finally { database.close(); }
    return;
  }

  await withLab(args, async (lab) => {
    if (command === "eval") {
      const expression = await resolveEvalExpression(args);
      if (!args.context || !expression) throw new Error("eval requires --context and --expression or --expression-file");
      await lab.client.connect();
      const value = await lab.client.evaluate(expression, Number(args.context));
      console.log(util.inspect(value, { depth: 8, colors: true }));
      return;
    }

    const probes = await lab.connectAndDiscover();
    if (command === "inspect") {
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(probes, null, 2));
      else console.table(probes.map(summarizeProbe));
      const selected = lab.select(probes);
      if (selected.probe) {
        console.log(`Selected context: ${selected.probe.context.id} (${selected.probe.context.name || "unnamed"})`);
        console.log(`Selected adapter: ${selected.adapter.label} (score=${selected.adapterScore})`);
      }
      return;
    }

    if (command === "snapshot") {
      const selection = lab.select(probes);
      const payload = JSON.stringify(await lab.snapshot(selection), null, 2) + "\n";
      if (args.out) {
        const target = path.resolve(String(args.out));
        await fs.writeFile(target, payload, "utf8");
        console.log(`Snapshot written: ${target}`);
      } else {
        console.log(payload.trimEnd());
      }
      return;
    }

    if (command === "status" || command === "game-state") {
      const selection = lab.select(probes);
      const snapshot = await lab.snapshot(selection);
      if (snapshot?.adapter !== "target-game") throw new Error("status requires the Target Farm Game Inspector adapter");
      let boardState = null;
      try {
        boardState = await lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id);
      } catch (_) {
        // A map/scene transition may temporarily make the board runtime unavailable.
      }
      const gameState = buildGameState({ state: summarizeSnapshot(snapshot), boardState });
      if (command === "game-state") {
        const payload = JSON.stringify(gameState, null, 2) + "\n";
        if (args.out) {
          const target = path.resolve(String(args.out));
          await fs.writeFile(target, payload, "utf8");
          console.log(`Game state written: ${target}`);
        } else console.log(payload.trimEnd());
        return;
      }
      const report = buildStatusReport(gameState);
      if (args.out) {
        const target = path.resolve(String(args.out));
        await fs.writeFile(target, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.log(`Status written: ${target}`);
      }
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(report, null, 2));
      else printStatusReport(report);
      return;
    }

    if (command === "board-scan") {
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error("board-scan requires a selected execution context");
      const scan = await lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id);
      if (args.out) {
        const target = path.resolve(String(args.out));
        await fs.writeFile(target, JSON.stringify(scan, null, 2) + "\n", "utf8");
        console.log(`Board scan written: ${target}`);
      }
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(scan, null, 2));
      else printBoardScan(scan);
      return;
    }

    if (command === "board-merge") {
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error("board-merge requires a selected execution context");
      const execute = String(args.execute).toLowerCase() === "true";
      const expression = buildBoardMergeExpression(args.from, args.to, execute);
      const result = await lab.client.evaluate(expression, selection.probe.context.id);
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(result, null, 2));
      else printBoardMerge(result);
      return;
    }

    if (command === "board-auto") {
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error("board-auto requires a selected execution context");
      const maxActions = args["max-actions"];
      const delayMs = args["delay-ms"];
      const runner = new BoardAutomationRunner({
        client: lab.client,
        contextId: selection.probe.context.id,
        delayMs,
        evaluateTimeoutMs: args["timeout-ms"],
      });
      const result = await runner.run({
        producer: args.producer,
        maxActions,
        execute: String(args.execute).toLowerCase() === "true",
      });
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(result, null, 2));
      else printBoardRunnerResult(result);
      return;
    }

    if (command === "order-submit") {
      if (!args.slot) throw new Error("order-submit requires --slot");
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error("order-submit requires a selected execution context");
      const collectState = async () => {
        const snapshot = await lab.snapshot(selection);
        const boardState = await lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id);
        return buildGameState({ state: summarizeSnapshot(snapshot), boardState });
      };
      const submitter = new OrderSubmitter({ client: lab.client, contextId: selection.probe.context.id, collectState, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const result = await submitter.submit(args.slot, { execute: String(args.execute).toLowerCase() === "true" });
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(result, null, 2));
      else if (!result.executed) console.log(result.ok ? `订单 ${args.slot} 已满足；加入 --execute true 后提交。` : `订单提交预检停止：${result.reason}`);
      else console.log(result.ok ? `订单提交成功：金币 ${result.coinsBefore} → ${result.coinsAfter}` : `订单提交后验证未通过：${result.reason}`);
      return;
    }

    if (command === "map-complete") {
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error("map-complete requires a selected execution context");
      const collectState = async () => {
        const snapshot = await lab.snapshot(selection);
        let boardState = null;
        try { boardState = await lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id); } catch (_) {}
        return buildGameState({ state: summarizeSnapshot(snapshot), boardState });
      };
      const completer = new MapMissionCompleter({ client: lab.client, contextId: selection.probe.context.id, collectState, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const result = await completer.complete({ execute: String(args.execute).toLowerCase() === "true" });
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(result, null, 2));
      else if (!result.executed) console.log(result.ok ? `地图任务 ${result.before.mapMission.id} 已满足；加入 --execute true 后升级。` : `地图任务预检停止：${result.reason}`);
      else console.log(result.ok ? `地图任务完成：${result.missionBefore.id} → ${result.missionAfter?.id || "-"}，金币 ${result.coinsBefore} → ${result.coinsAfter}` : `地图任务执行后验证未通过：${result.reason}`);
      return;
    }

    if (command === "warehouse-open" || command === "warehouse-store") {
      if (command === "warehouse-store" && args.index == null) throw new Error("warehouse-store requires --index");
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error(`${command} requires a selected execution context`);
      const collectState = async () => {
        const snapshot = await lab.snapshot(selection);
        let boardState = null;
        try { boardState = await lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id); } catch (_) {}
        return buildGameState({ state: summarizeSnapshot(snapshot), boardState });
      };
      const executor = new WarehouseActionExecutor({ client: lab.client, contextId: selection.probe.context.id, collectState, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const execute = String(args.execute).toLowerCase() === "true";
      const result = command === "warehouse-open" ? await executor.open({ execute }) : await executor.move(args.index, { execute });
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(result, null, 2));
      else console.log(`${command}: ${result.reason}`);
      return;
    }

    if (command === "orders-auto") {
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error("orders-auto requires a selected execution context");
      const database = new AutomationDatabase(args.db || "data/automation.db");
      const catalog = database.getCatalogProjection();
      if (!catalog.items.length) { database.close(); throw new Error("SQLite Catalog Repository has no Active planning knowledge; run catalog-import first"); }
      const collectState = async () => {
        const snapshot = await lab.snapshot(selection);
        const boardState = await lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id);
        return buildGameState({ state: summarizeSnapshot(snapshot), boardState });
      };
      const runner = new BoardAutomationRunner({ client: lab.client, contextId: selection.probe.context.id, delayMs: args["delay-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const submitter = new OrderSubmitter({ client: lab.client, contextId: selection.probe.context.id, collectState, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const warehouse = new WarehouseActionExecutor({ client: lab.client, contextId: selection.probe.context.id, collectState, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const loop = new OrderCoinLoop({
        collectState,
        planOrders: async (state) => buildOptimizationPlan({ catalog: database.getCatalogProjection(), state }),
        runBoardAction: ({ producer, signal }) => runner.run({ producer, maxActions: 1, execute: true, signal }),
        submitOrder: (slot, { signal }) => submitter.submit(slot, { execute: true, signal }),
        storeBoardItem: (index, { signal }) => warehouse.move(index, { execute: true, signal }),
      });
      try {
        const result = await loop.run({ execute: String(args.execute).toLowerCase() === "true", maxActions: args["max-actions"] ?? null });
        if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(result, null, 2));
        else if (!result.executed) console.log(`订单闭环预检：目标 ${result.targetSlot || "-"}，下一步 ${result.nextAction?.type || result.reason}`);
        else console.log(`订单闭环停止：${result.reason}，已执行 ${result.actions.length} 个原子步骤。`);
      } finally { database.close(); }
      return;
    }

    if (command === "auto-loop") {
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error("auto-loop requires a selected execution context");
      const database = new AutomationDatabase(args.db || "data/automation.db");
      const catalog = database.getCatalogProjection();
      if (!catalog.items.length) { database.close(); throw new Error("SQLite Catalog Repository has no Active planning knowledge; run catalog-import first"); }
      const collectState = async () => {
        const snapshot = await lab.snapshot(selection);
        let boardState = null;
        try { boardState = await lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id); } catch (_) {}
        return buildGameState({ state: summarizeSnapshot(snapshot), boardState });
      };
      const runner = new BoardAutomationRunner({ client: lab.client, contextId: selection.probe.context.id, delayMs: args["delay-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const submitter = new OrderSubmitter({ client: lab.client, contextId: selection.probe.context.id, collectState, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const warehouse = new WarehouseActionExecutor({ client: lab.client, contextId: selection.probe.context.id, collectState, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const orderLoop = new OrderCoinLoop({ collectState, planOrders: async (state) => buildOptimizationPlan({ catalog: database.getCatalogProjection(), state }), runBoardAction: ({ producer, signal }) => runner.run({ producer, maxActions: 1, execute: true, signal }), submitOrder: (slot, { signal }) => submitter.submit(slot, { execute: true, signal }), storeBoardItem: (index, { signal }) => warehouse.move(index, { execute: true, signal }) });
      const navigator = new SceneNavigator({ client: lab.client, contextId: selection.probe.context.id, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const mapCompleter = new MapMissionCompleter({ client: lab.client, contextId: selection.probe.context.id, collectState, settleMs: args["settle-ms"], evaluateTimeoutMs: args["timeout-ms"] });
      const execute = String(args.execute).toLowerCase() === "true";
      const sessionId = database.startSession(execute ? "automatic" : "observe", { maxActions: args["max-actions"] ?? null, stopBoundary: "order-completed-or-energy-depleted", autoMapUpgrade: String(args["auto-map-upgrade"]).toLowerCase() === "true" });
      let sequence = 0;
      try {
        const loop = new FullAutomationLoop({ collectState, autoMapUpgrade: String(args["auto-map-upgrade"]).toLowerCase() === "true", navigate: (target, { signal }) => navigator.go(target, { execute: true, signal }), runOrderCycle: (options) => orderLoop.run(options), completeMapMission: ({ signal }) => mapCompleter.complete({ execute: true, signal }), onEvent: (event) => database.logAction({ sessionId, sequence: ++sequence, type: event.type, reason: event.reason, ok: event.ok, details: event }) });
        const result = await loop.run({ execute, maxActions: args["max-actions"] ?? null });
        if (!result.actions?.length) database.logAction({ sessionId, sequence: ++sequence, type: "boundary", reason: result.reason, ok: result.ok, details: { nextAction: result.nextAction || null } });
        database.endSession(sessionId, result.ok ? "complete" : "failed");
        if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(result, null, 2));
        else if (!result.executed) console.log(`总闭环预检：下一步 ${result.nextAction?.type || result.reason}${result.nextAction?.target ? ` → ${result.nextAction.target}` : ""}`);
        else console.log(`总闭环停止：${result.reason}，已执行 ${result.actions.length} 个步骤。`);
      } catch (error) {
        database.endSession(sessionId, "error");
        throw error;
      } finally { database.close(); }
      return;
    }

    if (command === "plan") {
      const selection = lab.select(probes);
      if (!selection.probe) throw new Error("plan requires a selected execution context");
      const snapshot = await lab.snapshot(selection);
      const boardScan = await lab.client.evaluate(BOARD_SCAN_EXPRESSION, selection.probe.context.id);
      const database = new AutomationDatabase(args.db || "data/automation.db");
      const catalog = database.getCatalogProjection({ includeProvisional: String(args.provisional).toLowerCase() === "true" });
      if (!catalog.items.length) { database.close(); throw new Error("SQLite Catalog Repository has no planning knowledge; run catalog-import first"); }
      const gameState = buildGameState({ state: summarizeSnapshot(snapshot), boardState: boardScan });
      const report = buildOptimizationPlan({ catalog, state: gameState });
      if (args.out) {
        const target = path.resolve(String(args.out));
        await fs.writeFile(target, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.log(`Optimization plan written: ${target}`);
      }
      if (String(args.json).toLowerCase() === "true") console.log(JSON.stringify(report, null, 2));
      else printOptimizationPlan(report);
      database.close();
      return;
    }

    if (command === "watch") {
      console.table(probes.map(summarizeProbe));
      console.log("Watching CDP runtime events. Press Ctrl+C to stop.");
      lab.client.on("event", (event) => console.log(new Date().toISOString(), event.method));
      await new Promise((resolve) => process.once("SIGINT", resolve));
      return;
    }

    printHelp();
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[adapter-lab] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, resolveEvalExpression };
