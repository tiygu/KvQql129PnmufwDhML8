"use strict";

const { CdpClient } = require("./cdp-client");
const { probeContext } = require("./runtime-probe");
const { detectEngines, scoreContext } = require("./engine-detectors");
const { createAdapterRegistry, selectAdapter } = require("./adapter-registry");
const { waitForDelay } = require("./abortable-delay");

class AdapterLab {
  constructor(config) {
    this.config = config;
    this.client = new CdpClient(config);
    this.adapters = createAdapterRegistry();
  }

  async connectAndDiscover(signal = null) {
    await this.client.connect(signal);
    await this.client.enableRuntime(signal);
    if (!await waitForDelay(this.config.discoveryMs, signal)) throw Object.assign(new Error("CDP discovery aborted"), { name: "AbortError" });
    const contexts = this.client.getContexts();
    const probes = [];
    for (const context of contexts) probes.push(await probeContext(this.client, context, signal));
    return probes.map((probe) => ({
      ...probe,
      score: scoreContext(probe),
      detectedEngines: detectEngines(probe.data),
    })).sort((a, b) => b.score - a.score);
  }

  select(probes) {
    const selectedProbe = probes.find((probe) => probe.ok) || null;
    if (!selectedProbe) return { probe: null, adapter: null, adapterScore: 0 };
    const selection = selectAdapter(this.adapters, selectedProbe);
    return {
      probe: selectedProbe,
      adapter: selection && selection.adapter,
      adapterScore: selection && selection.score,
    };
  }

  async snapshot(selection, options = {}) {
    if (!selection.probe || !selection.adapter) throw new Error("No usable game context/adapter selected");
    return selection.adapter.snapshot(this.client, selection.probe.context, selection.probe, options);
  }

  close() {
    return this.client.close();
  }
}

module.exports = { AdapterLab };
