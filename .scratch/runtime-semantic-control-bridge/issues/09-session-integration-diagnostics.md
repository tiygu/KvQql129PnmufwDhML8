# 09 - Complete full-order Automation Session integration and diagnostics

**What to build:** Complete an order using semantic state, stochastic production, deterministic merge, order submission, and navigation while unmigrated warehouse, sale, map-mission, Production Mode, catalog, and icon operations continue through the Legacy Adapter. Preserve all session semantics and expose development diagnostics for the hot path.

**Blocked by:** 05 - Deliver stochastic production through a semantic command; 06 - Deliver order submission through a semantic command; 07 - Deliver board and map navigation through semantic commands; 08 - Deliver button diagnostics and tiered fallback.

**Status:** completed

- [x] An end-to-end order scenario completes through semantic baseline, production, merge, submission, and required navigation.
- [x] The planner still replans after each action, but successful semantic actions avoid redundant broad snapshots and unconditional fixed waits.
- [x] Warehouse Retrieval, storage, sale execution, map-mission completion, Production Mode switching, catalog scans, and icon acquisition remain functional through the Legacy Adapter.
- [x] Every capability independently selects semantic or Legacy behavior, so one degraded capability does not disable all automation.
- [x] Bounded Automation Session completion and waiting boundaries remain unchanged.
- [x] Idle Automation Session wake-up checks generation and revision and reconciles before mutation when needed.
- [x] Pause and stop interrupt semantic commands, event waits, fallback, reconciliation, and Legacy operations.
- [x] Runtime status exposes readiness, versions, game fingerprint, generation, revision, capabilities, fallback state, and the latest recovery reason.
- [x] Exported diagnostics count CDP round trips, serialized request and result sizes, runtime events, targeted reads, baseline reads, broad snapshots, fallbacks, resyncs, and confirmation paths.
- [x] Diagnostics remain development and troubleshooting data rather than a separate operator-facing performance product.
- [x] Semantic action deltas continue into action history and Catalog Evidence while catalog enrichment remains off the action critical path.
- [x] Tests show fewer broad snapshots and active confirmation reads than the Legacy baseline without relying on wall-clock performance assertions.
- [x] Targeted regression tests and the full repository check pass.

## Comments

Implemented through the Runtime Semantic Control Bridge seam with an in-memory full-order scenario, per-capability Legacy fallback diagnostics, idle wake reconciliation, transport byte counters, and exported runtime-control status. Validation is recorded in the implementation commit.
