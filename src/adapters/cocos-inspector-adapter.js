"use strict";

const { BaseAdapter } = require("./base-adapter");

class CocosInspectorAdapter extends BaseAdapter {
  constructor() {
    super({ id: "cocos-inspector", label: "Generic Cocos Inspector", engine: "cocos" });
  }

  match(probeResult) {
    return probeResult.data?.engines?.cocos?.present ? 50 : 0;
  }

  async snapshot(client, context, _probe = null, options = {}) {
    return client.evaluate(`(() => {
      const cc = globalThis.cc || globalThis.GameGlobal?.cc;
      const scene = cc?.director?.getScene?.();
      const walk = (node, depth = 0) => {
        if (!node || depth > 3) return null;
        const children = Array.isArray(node.children) ? node.children.slice(0, 30) : [];
        return {
          name: node.name || null,
          active: node.active,
          componentTypes: Array.isArray(node._components)
            ? node._components.map((item) => item?.constructor?.name || "unknown")
            : [],
          children: children.map((child) => walk(child, depth + 1)).filter(Boolean)
        };
      };
      return {
        adapter: "cocos-inspector",
        version: cc?.ENGINE_VERSION || cc?.VERSION || null,
        scene: walk(scene)
      };
    })()`, context.id, options);
  }
}

module.exports = { CocosInspectorAdapter };
