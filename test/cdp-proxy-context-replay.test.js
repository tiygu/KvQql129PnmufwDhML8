"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { CdpProxyContextReplay } = require("../wmpf/src/cdp_proxy_context_replay");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(message) {
    this.sent.push(JSON.parse(String(message)));
  }
}

const waitForTimers = () => new Promise((resolve) => setTimeout(resolve, 10));

test("后续 CDP 客户端执行 Runtime.enable 时重放已有 execution contexts", async () => {
  const forwarded = [];
  const replay = new CdpProxyContextReplay({
    replayDelayMs: 0,
    isClientOpen: (client) => client.readyState === 1,
    forward: (message) => forwarded.push(JSON.parse(message)),
  });

  const first = new FakeSocket();
  replay.addClient(first);
  first.emit("message", Buffer.from('{"id":1,"method":"Runtime.enable","params":{}}'));
  replay.handleBackendMessage('{"method":"Runtime.executionContextCreated","params":{"context":{"id":7,"origin":"https://servicewechat.com"}}}');
  replay.handleBackendMessage('{"id":1,"result":{}}');
  replay.removeClient(first);

  const second = new FakeSocket();
  replay.addClient(second);
  second.emit("message", Buffer.from('{"id":1,"method":"Runtime.enable","params":{}}'));
  replay.handleBackendMessage('{"id":1,"result":{}}');
  await waitForTimers();

  assert.equal(forwarded.filter((message) => message.method === "Runtime.enable").length, 2);
  assert.equal(forwarded.filter((message) => message.method === "Runtime.disable").length, 1);
  assert.deepEqual(
    second.sent.filter((message) => message.method === "Runtime.executionContextCreated")
      .map((message) => message.params.context.id),
    [7],
  );
});

test("当前客户端已接收的 context 不重复重放，并同步处理销毁事件", async () => {
  const replay = new CdpProxyContextReplay({
    replayDelayMs: 0,
    isClientOpen: () => true,
    forward() {},
  });
  const client = new FakeSocket();
  replay.addClient(client);
  replay.handleBackendMessage('{"method":"Runtime.executionContextCreated","params":{"context":{"id":7}}}');
  client.emit("message", '{"id":1,"method":"Runtime.enable"}');
  await waitForTimers();
  assert.equal(client.sent.filter((message) => message.method === "Runtime.executionContextCreated").length, 1);

  replay.handleBackendMessage('{"method":"Runtime.executionContextDestroyed","params":{"executionContextId":7}}');
  replay.removeClient(client);
  const next = new FakeSocket();
  replay.addClient(next);
  next.emit("message", '{"id":2,"method":"Runtime.enable"}');
  await waitForTimers();
  assert.equal(next.sent.filter((message) => message.method === "Runtime.executionContextCreated").length, 0);
});

test("小游戏重连后首个 Runtime.enable 重新激活后端 context 发现", async () => {
  const forwarded = [];
  const replay = new CdpProxyContextReplay({
    replayDelayMs: 0,
    isClientOpen: () => true,
    forward: (message) => forwarded.push(JSON.parse(message)),
  });
  replay.resetBackend();

  const client = new FakeSocket();
  replay.addClient(client);
  client.emit("message", '{"id":1,"method":"Runtime.enable","params":{}}');

  assert.deepEqual(
    forwarded.map((message) => message.method),
    ["Runtime.disable", "Runtime.enable"],
  );
  assert.ok(forwarded[0].id < 0);

  replay.handleBackendMessage(JSON.stringify({ id: forwarded[0].id, result: {} }));
  assert.equal(client.sent.some((message) => message.id === forwarded[0].id), false);

  replay.handleBackendMessage('{"method":"Runtime.executionContextCreated","params":{"context":{"id":8,"origin":"https://servicewechat.com"}}}');
  replay.removeClient(client);

  const next = new FakeSocket();
  replay.addClient(next);
  next.emit("message", '{"id":2,"method":"Runtime.enable","params":{}}');
  await waitForTimers();
  assert.equal(next.sent.some((message) => message.params?.context?.id === 8), true);
});
