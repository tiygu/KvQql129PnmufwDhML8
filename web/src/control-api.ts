declare const catalogCursorBrand: unique symbol;
declare const catalogQueryRevisionBrand: unique symbol;
export type CatalogCursor = string & { readonly [catalogCursorBrand]: true };
export type CatalogQueryRevision = string & { readonly [catalogQueryRevisionBrand]: true };
export type ControlEvent = {
  type: string;
  catalogQueryRevision?: CatalogQueryRevision;
  [name: string]: any;
};
type ControlEventListener = (event: ControlEvent) => void;
export type CatalogItemFilterName =
  | "status"
  | "disposition"
  | "reviewAction"
  | "iconFreshness"
  | "mergeChainId"
  | "level"
  | "itemType";
export type CatalogItemFilters = Partial<Record<CatalogItemFilterName, string[]>>;
export type CatalogItemSort = "relevance" | "display-title" | "chain-level" | "updated-at";
export type CatalogItemSortDirection = "asc" | "desc";
export type CatalogItemQueryInput = {
  query?: string;
  scope?: "all" | "pending";
  pageSize?: number;
  cursor?: CatalogCursor | null;
  sort?: CatalogItemSort;
  direction?: CatalogItemSortDirection;
  filters?: CatalogItemFilters;
  loadedCount?: number;
  selectedItemId?: string | null;
};

export type CatalogItemQueryPage = {
  catalogQueryRevision: CatalogQueryRevision;
  total: number;
  returnedCount: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: CatalogCursor | null;
  items: any[];
  selectionInResults?: boolean;
};

async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
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
  return payload as T;
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
  getCatalogItems: (input: CatalogItemQueryInput = {}) => {
    const search = new URLSearchParams();
    if (input.query) search.set("q", input.query);
    if (input.scope) search.set("scope", input.scope);
    if (input.pageSize != null) search.set("pageSize", String(input.pageSize));
    if (input.cursor) search.set("cursor", input.cursor);
    if (input.sort) search.set("sort", input.sort);
    if (input.direction) search.set("direction", input.direction);
    if (input.loadedCount) search.set("loadedCount", String(input.loadedCount));
    if (input.selectedItemId) search.set("selectedItemId", input.selectedItemId);
    for (const [name, values] of Object.entries(input.filters || {})) {
      for (const value of values || []) search.append(name, value);
    }
    return request<CatalogItemQueryPage>(`/api/catalog/items?${search.toString()}`);
  },
  getCatalogItem: (itemId: string) => request(`/api/catalog/items/${encodeURIComponent(itemId)}`),
  getCatalogObject: (objectType: string, objectId: string) => request(`/api/catalog/object?type=${encodeURIComponent(objectType)}&id=${encodeURIComponent(objectId)}`),
  previewCatalogReview: (input: any) => post("/api/catalog/review/preview", input),
  skipCatalogReview: (input: any) => post("/api/catalog/review/skip", input),
  completeCatalogReview: (input: any) => post("/api/catalog/review/complete", input),
  applyCatalogRuling: (input: any) => post("/api/catalog/ruling", input),
  revokeCatalogRuling: (input: any) => post("/api/catalog/ruling/revoke", input),
  setCatalogObjectDisposition: (input: any) => post("/api/catalog/object/disposition", input),
  setCatalogEvidenceDisposition: (input: any) => post("/api/catalog/evidence/disposition", input),
  refreshCatalog: () => post("/api/catalog/refresh"),
  runActiveCatalogScan: (itemIds: string[] = []) => post("/api/catalog/scan", { itemIds }),
  exportCatalog,
  importCatalog: (snapshot: any) => post("/api/catalog/import", snapshot),
  acquireCatalogIcon: (objectId: string) => post("/api/catalog/icon/acquire", { objectId }),
  getCatalogIconTask: (taskId: number) => request(`/api/catalog/icon/task?id=${encodeURIComponent(taskId)}`),
  selectCatalogIcon: (input: any) => post("/api/catalog/icon/select", input),
  revokeCatalogIcon: (input: any) => post("/api/catalog/icon/revoke", input),
  uploadCatalogIcon: (input: any) => post("/api/catalog/icon/upload", input),
  getConnectionStatus: () => request("/api/connection"),
  startConnection: (options?: any) => post("/api/connection/start", options || {}),
  stopConnection: () => post("/api/connection/stop"),
  preview: (options: any) => post("/api/automation/preview", options),
  start: (options: any) => post("/api/automation/start", options),
  startIdle: (options: any) => post("/api/automation/idle/start", options),
  stop: () => post("/api/automation/stop"),
  pause: () => post("/api/automation/pause"),
  resume: () => post("/api/automation/resume"),
  executeSale: (suggestion: any) => post("/api/sale/execute", { ...suggestion, confirmed: true }),
  completeMapMission: () => post("/api/map/complete"),
  getSettings: () => request("/api/settings"),
  saveSettings: (settings: any) => post("/api/settings", settings),
  exportDiagnostic,
  onEvent,
};
