"use strict";

function messageToText(message) {
  if (Buffer.isBuffer(message)) return message.toString("utf8");
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString("utf8");
  return typeof message === "string" ? message : String(message);
}

function parseMessage(message) {
  try {
    return JSON.parse(messageToText(message));
  } catch (_) {
    return null;
  }
}

/**
 * 微信调试桥的 CDP Runtime 状态由所有代理连接共享。Runtime 已启用时，后续
 * 客户端再次发送 Runtime.enable 只会得到响应，不会再次收到已有 context 事件。
 * 此对象缓存后端事件，并只向尚未见过这些 context 的客户端重放。
 */
class CdpProxyContextReplay {
  constructor(options) {
    this.forward = options.forward;
    this.isClientOpen = options.isClientOpen;
    this.replayDelayMs = options.replayDelayMs ?? 100;
    this.runtimeRefreshCooldownMs = options.runtimeRefreshCooldownMs ?? 1000;
    this.contexts = new Map();
    this.clients = new Map();
    this.runtimeRefreshIssuedAt = 0;
    this.nextInternalId = -1;
    this.internalCommandIds = new Set();
  }

  addClient(client) {
    if (this.clients.has(client)) return;
    const state = { seenContextIds: new Set(), timers: new Set(), onMessage: null };
    state.onMessage = (message) => {
      const text = messageToText(message);
      const parsed = parseMessage(text);
      if (parsed?.method === "Runtime.enable" && this._shouldRefreshRuntime()) {
        // WMPF keeps Runtime enabled across miniapp reconnects, so a plain enable
        // returns successfully without re-emitting the new execution contexts.
        const id = this.nextInternalId--;
        this.internalCommandIds.add(id);
        this.runtimeRefreshIssuedAt = Date.now();
        this.forward(JSON.stringify({ id, method: "Runtime.disable", params: {} }));
      }
      this.forward(text);
      if (parsed?.method === "Runtime.enable") this._scheduleReplay(client, state);
    };
    this.clients.set(client, state);
    client.on("message", state.onMessage);
  }

  removeClient(client) {
    const state = this.clients.get(client);
    if (!state) return;
    client.off("message", state.onMessage);
    for (const timer of state.timers) clearTimeout(timer);
    this.clients.delete(client);
  }

  _shouldRefreshRuntime() {
    return this.contexts.size === 0 &&
      Date.now() - this.runtimeRefreshIssuedAt >= this.runtimeRefreshCooldownMs;
  }

  resetBackend() {
    this.contexts.clear();
    this.runtimeRefreshIssuedAt = 0;
    const cleared = JSON.stringify({
      method: "Runtime.executionContextsCleared",
      params: {},
    });
    for (const [client, state] of this.clients) {
      state.seenContextIds.clear();
      if (this.isClientOpen(client)) client.send(cleared);
    }
  }

  _scheduleReplay(client, state) {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      if (!this.clients.has(client) || !this.isClientOpen(client)) return;
      for (const [contextId, message] of this.contexts) {
        if (state.seenContextIds.has(contextId)) continue;
        client.send(JSON.stringify(message));
        state.seenContextIds.add(contextId);
      }
    }, this.replayDelayMs);
    state.timers.add(timer);
  }

  handleBackendMessage(message) {
    const parsed = parseMessage(message);
    if (typeof parsed?.id === "number" && this.internalCommandIds.delete(parsed.id)) return;
    const method = parsed?.method;
    const createdId = method === "Runtime.executionContextCreated"
      ? parsed?.params?.context?.id
      : null;
    const destroyedId = method === "Runtime.executionContextDestroyed"
      ? parsed?.params?.executionContextId
      : null;

    if (typeof createdId === "number") this.contexts.set(createdId, parsed);
    else if (typeof destroyedId === "number") this.contexts.delete(destroyedId);
    else if (method === "Runtime.executionContextsCleared") this.contexts.clear();

    for (const [client, state] of this.clients) {
      if (!this.isClientOpen(client)) continue;
      client.send(message);
      if (typeof createdId === "number") state.seenContextIds.add(createdId);
      else if (typeof destroyedId === "number") state.seenContextIds.delete(destroyedId);
      else if (method === "Runtime.executionContextsCleared") state.seenContextIds.clear();
    }
  }
}

module.exports = { CdpProxyContextReplay, messageToText };
