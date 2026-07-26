"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { guardStream, installBrokenPipeGuards } = require("../src/process-stream-guards");

test("Node控制服务输出管道关闭时忽略EPIPE且安装保持幂等", () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  installBrokenPipeGuards({ stdout, stderr });
  installBrokenPipeGuards({ stdout, stderr });
  assert.equal(stdout.listenerCount("error"), 1);
  assert.equal(stderr.listenerCount("error"), 1);
  assert.doesNotThrow(() => stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
  assert.doesNotThrow(() => stderr.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
});

test("无效输出对象不会影响主进程启动", () => {
  assert.doesNotThrow(() => guardStream(null));
  assert.doesNotThrow(() => guardStream({}));
});
