"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { MAX_ACTIVE_CATALOG_SCAN_TARGETS } = require("./catalog-scan");
const { CATALOG_OBJECT_TYPES } = require("./catalog-domain");
const WebSocket = require("ws");

const WS_PATH = "/ws";
const JSON_LIMIT_BYTES = 16 * 1024 * 1024;

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
});

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT_BYTES) {
        reject(Object.assign(new Error("request body is too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        reject(Object.assign(new Error("request body must be valid JSON"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function createControlServer({ runtime, publicRoot, dataDir } = {}) {
  if (!runtime) throw new TypeError("runtime is required");
  const staticRoot = path.resolve(publicRoot || path.join(__dirname, "..", "public"));
  const diagnosticsDir = path.resolve(dataDir || path.join(__dirname, "..", "data"), "diagnostics");
  const clients = new Set();
  let dashboardPromise = null;

  function broadcast(event) {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  function dashboard() {
    if (!dashboardPromise) {
      dashboardPromise = runtime.dashboard().finally(() => {
        dashboardPromise = null;
      });
    }
    return dashboardPromise;
  }

  async function serveDiagnostic(res) {
    await fsp.mkdir(diagnosticsDir, { recursive: true });
    const fileName = `merge-garden-diagnostic-${Date.now()}.zip`;
    const filePath = path.join(diagnosticsDir, fileName);
    await runtime.exportDiagnostic(filePath);
    const stat = await fsp.stat(filePath);
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${fileName}"`,
      "content-length": stat.size,
      "content-type": "application/zip",
    });
    fs.createReadStream(filePath).pipe(res);
  }

  async function serveStatic(urlPath, res) {
    const relativePath = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
    let filePath = path.resolve(staticRoot, relativePath);
    if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${path.sep}`)) {
      writeJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    let stat = await fsp.stat(filePath).catch(() => null);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stat = await fsp.stat(filePath).catch(() => null);
    }
    if (!stat?.isFile() && !path.extname(relativePath)) {
      filePath = path.join(staticRoot, "index.html");
      stat = await fsp.stat(filePath).catch(() => null);
    }
    if (!stat?.isFile()) {
      writeJson(res, 404, { ok: false, error: "not-found", hint: "run npm run web:build" });
      return;
    }
    res.writeHead(200, {
      "cache-control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      "content-length": stat.size,
      "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      const route = `${req.method || "GET"} ${requestUrl.pathname}`;
      const iconAssetMatch = /^\/api\/catalog\/icon\/([a-f0-9]{64})$/.exec(requestUrl.pathname);
      if ((req.method || "GET") === "GET" && iconAssetMatch) {
        const asset = runtime.getCatalogIconAsset(iconAssetMatch[1]);
        const stat = asset ? await fsp.stat(asset.filePath).catch(() => null) : null;
        if (!asset || !stat?.isFile()) return writeJson(res, 404, { ok: false, error: "catalog-icon-not-found" });
        res.writeHead(200, { "cache-control": "public, max-age=31536000, immutable", "content-length": stat.size, "content-type": asset.mimeType });
        fs.createReadStream(asset.filePath).pipe(res);
        return;
      }
      if (route === "GET /api/health") return writeJson(res, 200, { ok: true, wsPath: WS_PATH });
      if (route === "GET /api/dashboard") return writeJson(res, 200, await dashboard());
      if (route === "GET /api/catalog") return writeJson(res, 200, runtime.getCatalogView());
      if (route === "GET /api/catalog/export") {
        const snapshot = runtime.exportCatalog();
        const body = JSON.stringify(snapshot, null, 2) + "\n";
        res.writeHead(200, {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="catalog-repository-${Date.now()}.json"`,
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json; charset=utf-8",
        });
        res.end(body);
        return;
      }
      if (route === "POST /api/catalog/import") {
        const result = runtime.importCatalog(await readJson(req), { sourceFile: "control-api" });
        broadcast({ type: "catalog-repository-imported", revision: result.revision, imported: result.imported, preserved: result.preserved });
        return writeJson(res, 200, result);
      }
      if (route === "POST /api/catalog/icon/acquire") {
        const body = await readJson(req);
        if (!body.objectId) return writeJson(res, 400, { ok: false, error: "catalog-item-id-required" });
        const task = runtime.acquireCatalogIcon(String(body.objectId));
        broadcast({ type: "icon-acquisition-queued", itemId: String(body.objectId), taskId: task.taskId });
        return writeJson(res, 202, task);
      }
      if (route === "GET /api/catalog/icon/task") {
        const task = runtime.getCatalogIconTask(requestUrl.searchParams.get("id"));
        return writeJson(res, task ? 200 : 404, task || { ok: false, error: "icon-task-not-found" });
      }
      if (route === "POST /api/catalog/icon/select") {
        const body = await readJson(req);
        if (!body.objectId || !Number.isInteger(Number(body.candidateId)) || !body.actor || !body.note || !Number.isInteger(Number(body.expectedRevision))) return writeJson(res, 400, { ok: false, error: "invalid-icon-selection-request" });
        const object = runtime.selectCatalogIcon(String(body.objectId), Number(body.candidateId), { actor: body.actor, note: body.note, expectedRevision: Number(body.expectedRevision) });
        broadcast({ type: "catalog-review-updated", objectType: "item-identity", objectId: String(body.objectId), revision: object.revision, reviewStatus: object.reviewStatus });
        return writeJson(res, 200, object);
      }
      if (route === "POST /api/catalog/icon/revoke") {
        const body = await readJson(req);
        if (!body.objectId || !body.actor || !body.note || !Number.isInteger(Number(body.expectedRevision))) return writeJson(res, 400, { ok: false, error: "invalid-icon-revoke-request" });
        const object = runtime.revokeCatalogIconSelection(String(body.objectId), { actor: body.actor, note: body.note, expectedRevision: Number(body.expectedRevision) });
        broadcast({ type: "catalog-review-updated", objectType: "item-identity", objectId: String(body.objectId), revision: object.revision, reviewStatus: object.reviewStatus });
        return writeJson(res, 200, object);
      }
      if (route === "POST /api/catalog/icon/upload") {
        const body = await readJson(req);
        if (!body.objectId || !body.dataBase64 || !body.mimeType || !body.actor || !body.note || !Number.isInteger(Number(body.expectedRevision))) return writeJson(res, 400, { ok: false, error: "invalid-icon-upload-request" });
        const object = await runtime.uploadCatalogIcon(String(body.objectId), body);
        broadcast({ type: "catalog-review-updated", objectType: "item-identity", objectId: String(body.objectId), revision: object.revision, reviewStatus: object.reviewStatus });
        return writeJson(res, 200, object);
      }
      if (route === "GET /api/catalog/object") {
        const objectType = requestUrl.searchParams.get("type");
        const objectId = requestUrl.searchParams.get("id");
        if (!CATALOG_OBJECT_TYPES.has(objectType) || !objectId) return writeJson(res, 400, { ok: false, error: "invalid-catalog-object-identity" });
        const object = runtime.getCatalogObject(objectType, objectId);
        return writeJson(res, object ? 200 : 404, object || { ok: false, error: "catalog-object-not-found" });
      }
      if (route === "POST /api/catalog/object/disposition") {
        const body = await readJson(req);
        if (!CATALOG_OBJECT_TYPES.has(body.objectType) || !body.objectId || !body.disposition || !body.reason || !Number.isInteger(Number(body.expectedRevision))) return writeJson(res, 400, { ok: false, error: "invalid-catalog-disposition-request" });
        const object = await runtime.setCatalogObjectDisposition(body.objectType, body.objectId, body.disposition, body.reason, Number(body.expectedRevision));
        broadcast({
          type: "catalog-review-updated",
          objectType: object.objectType,
          objectId: object.objectId,
          revision: object.revision,
          reviewStatus: object.reviewStatus,
          disposition: object.disposition,
          planningEligible: object.planningEligible,
          planningResult: object.planningResult || null,
        });
        return writeJson(res, 200, object);
      }
      if (route === "POST /api/catalog/evidence/disposition") {
        const body = await readJson(req);
        if (!CATALOG_OBJECT_TYPES.has(body.objectType) || !body.objectId || !body.evidenceId || !body.disposition || !body.reason || !Number.isInteger(Number(body.expectedRevision))) return writeJson(res, 400, { ok: false, error: "invalid-catalog-evidence-request" });
        const object = runtime.setCatalogEvidenceDisposition(body.objectType, body.objectId, body.evidenceId, body.disposition, body.reason, Number(body.expectedRevision));
        broadcast({ type: "catalog-review-updated", objectType: object.objectType, objectId: object.objectId, revision: object.revision, reviewStatus: object.reviewStatus });
        return writeJson(res, 200, object);
      }
      if (route === "POST /api/catalog/review/complete") {
        const body = await readJson(req);
        const snapshotValid = body.snapshot && typeof body.snapshot === "object" && !Array.isArray(body.snapshot);
        if (!CATALOG_OBJECT_TYPES.has(body.objectType) || !body.objectId || !["confirm", "modify"].includes(body.decision) || !snapshotValid || !body.actor || !body.requestId || !Number.isInteger(Number(body.expectedRevision))) {
          return writeJson(res, 400, { ok: false, error: "invalid-catalog-review-completion-request" });
        }
        const object = await runtime.completeCatalogReview({ ...body, expectedRevision: Number(body.expectedRevision) });
        if (!object.idempotentReplay) {
          const reviewQueue = runtime.getCatalogView({ includeRepositoryObjects: true }).repository?.reviewQueue || [];
          broadcast({
            type: "catalog-review-updated",
            objectType: object.objectType,
            objectId: object.objectId,
            revision: object.revision,
            reviewStatus: object.reviewStatus,
            planningResult: object.reviewResolution?.planningResult || null,
            reviewQueue,
          });
        }
        return writeJson(res, 200, object);
      }
      if (route === "POST /api/catalog/ruling") {
        const body = await readJson(req);
        if (!CATALOG_OBJECT_TYPES.has(body.objectType) || !body.objectId || !body.fieldPath || !["confirm", "modify"].includes(body.decision) || !body.actor || !body.note || !Number.isInteger(Number(body.expectedRevision))) {
          return writeJson(res, 400, { ok: false, error: "invalid-catalog-ruling-request" });
        }
        const object = runtime.applyCatalogRuling({ ...body, expectedRevision: Number(body.expectedRevision) });
        broadcast({ type: "catalog-review-updated", objectType: object.objectType, objectId: object.objectId, revision: object.revision, reviewStatus: object.reviewStatus });
        return writeJson(res, 200, object);
      }
      if (route === "POST /api/catalog/ruling/revoke") {
        const body = await readJson(req);
        if (!CATALOG_OBJECT_TYPES.has(body.objectType) || !body.objectId || !body.fieldPath || !body.actor || !body.note || !Number.isInteger(Number(body.expectedRevision))) {
          return writeJson(res, 400, { ok: false, error: "invalid-catalog-ruling-revoke-request" });
        }
        const object = runtime.revokeCatalogRuling({ ...body, expectedRevision: Number(body.expectedRevision) });
        broadcast({ type: "catalog-review-updated", objectType: object.objectType, objectId: object.objectId, revision: object.revision, reviewStatus: object.reviewStatus });
        return writeJson(res, 200, object);
      }
      if (route === "POST /api/catalog/refresh") return writeJson(res, 200, await runtime.refreshCatalogFromRuntime());
      if (route === "POST /api/catalog/scan") {
        const body = await readJson(req);
        if (body.itemIds != null && !Array.isArray(body.itemIds)) return writeJson(res, 400, { ok: false, error: "invalid-active-catalog-scan-request" });
        if ((body.itemIds || []).length > MAX_ACTIVE_CATALOG_SCAN_TARGETS) return writeJson(res, 400, { ok: false, error: "active-catalog-scan-target-limit", limit: MAX_ACTIVE_CATALOG_SCAN_TARGETS });
        const result = await runtime.runActiveCatalogScan({ itemIds: (body.itemIds || []).map(String) });
        broadcast({ type: "active-catalog-scan-complete", ...result });
        return writeJson(res, result.ok ? 200 : 409, result);
      }
      if (route === "GET /api/connection") return writeJson(res, 200, await runtime.connectionRouteStatus());
      if (route === "POST /api/connection/start") return writeJson(res, 200, await runtime.startConnectionRoute(await readJson(req)));
      if (route === "POST /api/connection/stop") return writeJson(res, 200, await runtime.stopConnectionRoute());
      if (route === "POST /api/automation/preview") return writeJson(res, 200, await runtime.preview(await readJson(req)));
      if (route === "POST /api/automation/start") {
        const options = await readJson(req);
        const result = options.mode === "automatic" && options.maxActions == null
          ? runtime.startIdleInBackground(options)
          : runtime.startInBackground(options);
        return writeJson(res, 202, result);
      }
      if (route === "POST /api/automation/idle/start") return writeJson(res, 202, runtime.startIdleInBackground(await readJson(req)));
      if (route === "POST /api/automation/stop") return writeJson(res, 200, runtime.stop());
      if (route === "POST /api/automation/pause") return writeJson(res, 200, runtime.pause());
      if (route === "POST /api/automation/resume") return writeJson(res, 200, runtime.resume());
      if (route === "POST /api/sale/execute") return writeJson(res, 200, await runtime.executeSaleSuggestion(await readJson(req)));
      if (route === "POST /api/map/complete") return writeJson(res, 200, await runtime.completeCurrentMapMission());
      if (route === "GET /api/settings") return writeJson(res, 200, runtime.getSettings());
      if (route === "POST /api/settings") return writeJson(res, 200, runtime.saveSettings(await readJson(req)));
      if (route === "GET /api/diagnostic") return await serveDiagnostic(res);
      if (requestUrl.pathname.startsWith("/api/")) return writeJson(res, 404, { ok: false, error: "api-not-found" });
      return await serveStatic(requestUrl.pathname, res);
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      const payload = { ok: false, error: error?.message || String(error) };
      if (error?.code) payload.code = error.code;
      if (error?.fieldPath) payload.fieldPath = error.fieldPath;
      if (error?.currentObject) payload.currentObject = error.currentObject;
      writeJson(res, error?.statusCode || 500, payload);
    }
  });

  const wss = new WebSocket.Server({ noServer: true });
  wss.on("connection", (client) => {
    clients.add(client);
    client.send(JSON.stringify({ type: "control-connected", at: new Date().toISOString() }));
    client.on("close", () => clients.delete(client));
    client.on("error", () => clients.delete(client));
  });
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname !== WS_PATH) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  });

  async function close() {
    for (const client of clients) client.close(1001, "server shutdown");
    clients.clear();
    wss.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { httpServer, broadcast, close, wsPath: WS_PATH };
}

module.exports = { createControlServer, readJson, writeJson, WS_PATH };
