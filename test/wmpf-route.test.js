"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

test("微信/CDP 路线包含代理、协议和当前 WMPF 配置", () => {
  for (const relativePath of [
    "wmpf/src/index.js",
    "wmpf/src/cdp_automation.js",
    "wmpf/src/third-party/WARemoteDebugProtobuf.js",
    "wmpf/frida/hook.js",
    "wmpf/frida/config/addresses.20089.json",
  ]) {
    assert.equal(fs.existsSync(path.join(projectRoot, relativePath)), true, `${relativePath} missing`);
  }

  const config = require(path.join(projectRoot, "wmpf/frida/config/addresses.20089.json"));
  assert.equal(config.Version, 20089);
  assert.ok(Array.isArray(config.CDPFilterHooks));
  assert.ok(config.CDPFilterHooks.length > 0);
});

test("Frida hook 仅在指纹匹配时写入补丁并可恢复原字节", () => {
  const source = fs.readFileSync(path.join(projectRoot, "wmpf/frida/hook.js"), "utf8")
    .replace(/main\(\);\s*$/, "globalThis.__hookTest = { patchConditionalBranch, restoreRuntimePatches };");
  let currentBytes = [0x0f, 0x84, 0x0d, 0x01, 0x00, 0x00];
  const address = {
    readByteArray(length) { return Uint8Array.from(currentBytes.slice(0, length)).buffer; },
    toString() { return "0x2000"; },
  };
  const context = {
    Process: { findModuleByName() { return null; } },
    Interceptor: { attach() {} },
    Memory: {
      patchCode(_address, _size, writer) {
        writer({ writeByteArray(bytes) { currentBytes = [...bytes]; } });
      },
    },
    send() {},
  };

  vm.runInNewContext(source, context);
  const expectedBytes = [...currentBytes];
  assert.equal(context.__hookTest.patchConditionalBranch(address, expectedBytes, "fixture"), true);
  assert.deepEqual(currentBytes, [0x90, 0x90, 0x90, 0x90, 0x90, 0x90]);
  assert.equal(
    context.__hookTest.patchConditionalBranch(address, expectedBytes, "fixture-restart"),
    true,
  );
  assert.equal(context.__hookTest.restoreRuntimePatches(), true);
  assert.deepEqual(currentBytes, [0x0f, 0x84, 0x0d, 0x01, 0x00, 0x00]);
});

test("Node 控制台交付保留 CDP 路线和浏览器构建产物", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.start, "node run.cjs");
  assert.equal(packageJson.scripts.console, "node run.cjs --external-cdp --no-open");
  assert.equal(packageJson.build, undefined);
  assert.ok(fs.existsSync(path.join(projectRoot, "public", "index.html")));
  assert.ok(fs.existsSync(path.join(projectRoot, "wmpf", "frida", "hook.js")));
  assert.ok(fs.existsSync(path.join(projectRoot, "wmpf", "frida", "config", "addresses.20089.json")));
});