"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function normalizeId(value) {
  const id = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Adapter name must contain letters or numbers");
  return id;
}

async function scaffoldAdapter(name, engine = "unknown") {
  const id = normalizeId(name);
  const targetDir = path.join(__dirname, "adapters", "custom");
  const target = path.join(targetDir, `${id}.js`);
  await fs.mkdir(targetDir, { recursive: true });
  const source = `"use strict";

const { BaseAdapter } = require("../base-adapter");

class GameAdapter extends BaseAdapter {
  constructor() {
    super({ id: ${JSON.stringify(id)}, label: ${JSON.stringify(id)}, engine: ${JSON.stringify(engine)} });
  }

  match(probeResult) {
    // Add stable game fingerprints here: global markers, scene names or app-specific managers.
    const engineMatched = this.engine === "unknown" || probeResult.data?.engines?.[this.engine]?.present;
    return engineMatched ? 10 : 0;
  }

  async snapshot(client, context) {
    return client.evaluate(\`(() => ({
      adapter: ${JSON.stringify(id)},
      ready: true,
      // Replace this with read-only discovery of the target game's stable objects.
      globals: Object.getOwnPropertyNames(globalThis).slice(0, 200)
    }))()\`, context.id);
  }
}

module.exports = { adapter: new GameAdapter() };
`;
  await fs.writeFile(target, source, { encoding: "utf8", flag: "wx" });
  return target;
}

module.exports = { normalizeId, scaffoldAdapter };
