"use strict";

class BaseAdapter {
  constructor(options = {}) {
    this.id = options.id || "base";
    this.label = options.label || this.id;
    this.engine = options.engine || "unknown";
  }

  match() {
    return 0;
  }

  async snapshot(client, context, _probe = null, options = {}) {
    return client.evaluate("({ ok: true, note: 'base adapter' })", context.id, options);
  }
}

module.exports = { BaseAdapter };
