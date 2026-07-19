"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { GenericAdapter } = require("./adapters/generic-adapter");
const { CocosInspectorAdapter } = require("./adapters/cocos-inspector-adapter");

function loadCustomAdapters(directory = path.join(__dirname, "adapters", "custom")) {
  if (!fs.existsSync(directory)) return [];
  const adapters = [];
  for (const filename of fs.readdirSync(directory).filter((name) => name.endsWith(".js"))) {
    const exported = require(path.join(directory, filename));
    const value = exported.adapter || exported.default || exported;
    if (value && typeof value.match === "function") adapters.push(value);
  }
  return adapters;
}

function createAdapterRegistry() {
  return [...loadCustomAdapters(), new CocosInspectorAdapter(), new GenericAdapter()];
}

function selectAdapter(adapters, probeResult) {
  return adapters
    .map((adapter) => ({ adapter, score: Number(adapter.match(probeResult)) || 0 }))
    .sort((a, b) => b.score - a.score)[0] || null;
}

module.exports = { loadCustomAdapters, createAdapterRegistry, selectAdapter };
