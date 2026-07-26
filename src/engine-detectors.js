"use strict";

const ENGINE_LABELS = {
  cocos: "Cocos Creator",
  laya: "LayaAir",
  egret: "Egret",
  pixi: "PixiJS",
  three: "Three.js",
  unity: "Unity/WebAssembly",
};

function detectEngines(probeData) {
  if (!probeData || !probeData.engines) return [];
  return Object.entries(probeData.engines)
    .filter(([, detail]) => detail && detail.present)
    .map(([id, detail]) => ({ id, label: ENGINE_LABELS[id] || id, ...detail }));
}

function scoreContext(probeResult) {
  if (!probeResult.ok || !probeResult.data) return -1000;
  const env = probeResult.data.environment || {};
  const caps = probeResult.data.capabilities || {};
  const engines = detectEngines(probeResult.data);
  const contextName = String(probeResult.context.name || "").toLowerCase();
  let score = 0;
  if (env.hasGameGlobal) score += 40;
  if (env.hasWx) score += 20;
  if (env.hasCanvas) score += 25;
  if (caps.webgl) score += 15;
  if (engines.length) score += 80;
  if (/game|main|app/.test(contextName)) score += 15;
  if (/worker|service/.test(contextName)) score -= 10;
  return score;
}

module.exports = { ENGINE_LABELS, detectEngines, scoreContext };
