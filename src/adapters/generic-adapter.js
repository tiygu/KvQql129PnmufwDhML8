"use strict";

const { BaseAdapter } = require("./base-adapter");

class GenericAdapter extends BaseAdapter {
  constructor() {
    super({ id: "generic", label: "Generic JavaScript Runtime", engine: "unknown" });
  }

  match(probeResult) {
    return probeResult.ok ? 1 : 0;
  }

  async snapshot(client, context, _probe = null, options = {}) {
    return client.evaluate(`(() => ({
      adapter: "generic",
      contextId: ${Number(context.id)},
      title: globalThis.document && globalThis.document.title || null,
      globals: Object.getOwnPropertyNames(globalThis).slice(0, 200)
    }))()`, context.id, options);
  }
}

module.exports = { GenericAdapter };
