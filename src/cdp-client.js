"use strict";

const { EventEmitter } = require("node:events");
const WebSocket = require("ws");

class CdpClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url || "ws://127.0.0.1:62000";
    this.timeoutMs = options.timeoutMs || 10_000;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.contexts = new Map();
  }

  async connect(signal = null) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    if (signal?.aborted) throw Object.assign(new Error("CDP connection aborted"), { name: "AbortError" });
    const socket = new WebSocket(this.url);
    this.socket = socket;

    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const onAbort = () => {
        cleanup();
        if (this.socket === socket) this.socket = null;
        socket.close();
        reject(Object.assign(new Error("CDP connection aborted"), { name: "AbortError" }));
      };
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        signal?.removeEventListener?.("abort", onAbort);
      };
      socket.on("open", onOpen);
      socket.on("error", onError);
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });

    socket.on("message", (data) => this._handleMessage(data));
    socket.on("close", () => this._handleClose());
    socket.on("error", (error) => this.emit("socketError", error));
  }

  _handleMessage(data) {
    let message;
    try {
      message = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch (_) {
      return;
    }

    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener?.("abort", pending.abort);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }

    if (message.method === "Runtime.executionContextCreated") {
      const context = message.params && message.params.context;
      if (context && typeof context.id === "number") this.contexts.set(context.id, context);
    } else if (message.method === "Runtime.executionContextDestroyed") {
      this.contexts.delete(message.params && message.params.executionContextId);
    } else if (message.method === "Runtime.executionContextsCleared") {
      this.contexts.clear();
    }

    if (message.method) this.emit("event", message);
  }

  _handleClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener?.("abort", pending.abort);
      pending.reject(new Error("CDP WebSocket closed"));
    }
    this.pending.clear();
    this.emit("close");
  }

  send(method, params = {}, timeoutMs = this.timeoutMs, signal = null) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP WebSocket is not connected"));
    }
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("CDP command aborted"), { name: "AbortError" }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        signal?.removeEventListener?.("abort", pending.abort);
        this.pending.delete(id);
      };
      const abort = () => {
        cleanup();
        reject(Object.assign(new Error("CDP command aborted"), { name: "AbortError" }));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`CDP timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, abort, signal });
      signal?.addEventListener?.("abort", abort, { once: true });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async enableRuntime(signal = null) {
    return this.send("Runtime.enable", {}, this.timeoutMs, signal);
  }

  getContexts() {
    return [...this.contexts.values()];
  }

  async evaluate(expression, contextId, options = {}) {
    const params = {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: true,
    };
    if (contextId != null) params.contextId = Number(contextId);
    const result = await this.send("Runtime.evaluate", params, options.timeoutMs || this.timeoutMs, options.signal);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || "Runtime.evaluate failed");
    }
    return result.result && Object.prototype.hasOwnProperty.call(result.result, "value")
      ? result.result.value
      : undefined;
  }

  async close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.close();
      setTimeout(resolve, 500).unref();
    });
  }
}

module.exports = { CdpClient };
