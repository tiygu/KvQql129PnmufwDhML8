type ControlEventListener = (event: any) => void;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: options.body ? { "content-type": "application/json", ...options.headers } : options.headers,
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = Object.assign(new Error(payload?.error || `HTTP ${response.status}`), { status: response.status, payload });
    throw error;
  }
  return payload;
}

function post(path: string, body: any = {}) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

function onEvent(listener: ControlEventListener) {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;

  const connect = () => {
    if (stopped) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.onmessage = (message) => {
      try { listener(JSON.parse(String(message.data))); } catch (_) {}
    };
    socket.onclose = () => {
      if (!stopped) reconnectTimer = window.setTimeout(connect, 1500);
    };
    socket.onerror = () => socket?.close();
  };
  connect();
  return () => {
    stopped = true;
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}

async function exportDiagnostic() {
  const response = await fetch("/api/diagnostic", { cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  const disposition = response.headers.get("content-disposition") || "";
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] || `merge-garden-diagnostic-${Date.now()}.zip`;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return { ok: true, fileName };
}

async function exportCatalog() {
  const response = await fetch("/api/catalog/export", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const disposition = response.headers.get("content-disposition") || "";
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] || `catalog-repository-${Date.now()}.json`;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return { ok: true, fileName };
}

export const controlApi = {
  getDashboard: () => request("/api/dashboard"),
  getCatalog: () => request("/api/catalog"),
  getCatalogObject: (objectType: string, objectId: string) => request(`/api/catalog/object?type=${encodeURIComponent(objectType)}&id=${encodeURIComponent(objectId)}`),
  applyCatalogRuling: (input: any) => post("/api/catalog/ruling", input),
  revokeCatalogRuling: (input: any) => post("/api/catalog/ruling/revoke", input),
  setCatalogObjectDisposition: (input: any) => post("/api/catalog/object/disposition", input),
  refreshCatalog: () => post("/api/catalog/refresh"),
  exportCatalog,
  importCatalog: (snapshot: any) => post("/api/catalog/import", snapshot),
  acquireCatalogIcon: (objectId: string) => post("/api/catalog/icon/acquire", { objectId }),
  getCatalogIconTask: (taskId: number) => request(`/api/catalog/icon/task?id=${encodeURIComponent(taskId)}`),
  getConnectionStatus: () => request("/api/connection"),
  startConnection: (options?: any) => post("/api/connection/start", options || {}),
  stopConnection: () => post("/api/connection/stop"),
  preview: (options: any) => post("/api/automation/preview", options),
  start: (options: any) => post("/api/automation/start", options),
  stop: () => post("/api/automation/stop"),
  pause: () => post("/api/automation/pause"),
  resume: () => post("/api/automation/resume"),
  completeMapMission: () => post("/api/map/complete"),
  getSettings: () => request("/api/settings"),
  saveSettings: (settings: any) => post("/api/settings", settings),
  exportDiagnostic,
  onEvent,
};
