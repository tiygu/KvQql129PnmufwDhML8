"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PauseGate } = require("../src/pause-gate");

test("暂停门只在原子动作之间阻塞并可继续", async () => {
  const gate = new PauseGate();
  gate.pause();
  let passed = false;
  const waiting = gate.wait().then(() => { passed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(passed, false);
  gate.resume();
  await waiting;
  assert.equal(passed, true);
});

test("停止信号可以解除暂停等待", async () => {
  const gate = new PauseGate();
  const controller = new AbortController();
  gate.pause();
  const waiting = gate.wait(controller.signal);
  controller.abort();
  await waiting;
  assert.equal(gate.paused, true);
});

test("active scan waits until paused automation reaches an atomic boundary", async () => {
  const gate = new PauseGate();
  gate.pause();
  let reached = false;
  const boundary = gate.waitForBoundary().then(() => { reached = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reached, false);
  const waiting = gate.wait();
  await boundary;
  assert.equal(gate.boundaryReached, true);
  gate.resume();
  await waiting;
});
