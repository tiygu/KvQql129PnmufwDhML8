"use strict";

const RUNTIME_PROBE_EXPRESSION = `(() => {
  const G = globalThis;
  const GG = G.GameGlobal || {};
  const cc = G.cc || GG.cc;
  const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };
  const scene = safe(() => cc && cc.director && cc.director.getScene && cc.director.getScene());
  const names = safe(() => Object.getOwnPropertyNames(G), []);
  const findName = (pattern) => names.filter((name) => pattern.test(name)).slice(0, 30);
  const findChild = (node, name) => safe(() =>
    node?.getChildByName?.(name) || node?.children?.find?.((child) => child?.name === name), null);
  const hasScenePath = (segments) => {
    let node = scene;
    for (const segment of segments) {
      node = findChild(node, segment);
      if (!node) return false;
    }
    return true;
  };
  return {
    environment: {
      hasWx: !!G.wx,
      hasGameGlobal: !!G.GameGlobal,
      hasCanvas: !!(G.canvas || GG.canvas || (cc && cc.game && cc.game.canvas)),
      hasDocument: !!(G.document || GG.document),
      href: safe(() => G.location && G.location.href),
      userAgent: safe(() => G.navigator && G.navigator.userAgent)
    },
    engines: {
      cocos: { present: !!cc, version: safe(() => cc.ENGINE_VERSION || cc.VERSION), scene: scene && scene.name },
      laya: { present: !!(G.Laya || GG.Laya), version: safe(() => (G.Laya || GG.Laya).version) },
      egret: { present: !!(G.egret || GG.egret), version: safe(() => (G.egret || GG.egret).Capabilities.engineVersion) },
      pixi: { present: !!(G.PIXI || GG.PIXI), version: safe(() => (G.PIXI || GG.PIXI).VERSION) },
      three: { present: !!(G.THREE || GG.THREE), version: safe(() => (G.THREE || GG.THREE).REVISION) },
      unity: {
        present: !!(G.unityInstance || GG.unityInstance || G.Module || GG.Module),
        hasWasm: typeof G.WebAssembly !== "undefined"
      }
    },
    capabilities: {
      evaluate: true,
      timers: typeof G.setTimeout === "function",
      animationFrame: typeof G.requestAnimationFrame === "function",
      webAssembly: typeof G.WebAssembly !== "undefined",
      webgl: !!safe(() => {
        const canvas = G.canvas || GG.canvas || (G.document && G.document.querySelector && G.document.querySelector("canvas"));
        return canvas && (canvas.getContext("webgl2") || canvas.getContext("webgl"));
      }, false)
    },
    hints: {
      globalCount: names.length,
      engineLikeGlobals: findName(/cc|laya|egret|pixi|three|unity|game|engine|stage|scene|director/i),
      globalSample: names.slice(0, 120),
      sceneMarkers: {
        entryAudio: hasScenePath(["Entry", "AudioManager"]),
        mapPanel: hasScenePath(["Canvas", "ui", "root", "map_panel"]),
        farmArea: hasScenePath(["Canvas", "ui", "root", "map_panel", "scale_root", "map", "map_root", "AreaThumb_Area_Farms"]),
        taskBoard: hasScenePath(["Canvas", "ui", "content", "board_view", "board", "task_view"])
      }
    }
  };
})()`;

async function probeContext(client, context, signal = null) {
  try {
    const data = await client.evaluate(RUNTIME_PROBE_EXPRESSION, context.id, { signal });
    return { ok: true, context, data, error: null };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { ok: false, context, data: null, error: error.message };
  }
}

module.exports = { RUNTIME_PROBE_EXPRESSION, probeContext };
