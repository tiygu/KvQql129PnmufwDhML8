# 04 - Deliver ordered events, loss recovery, and context reconstruction

**What to build:** Update Automation Runtime state through ordered revisioned runtime events and recover from duplicate, late, temporarily missing, or gapped events, scene changes, and execution-context replacement.

**Blocked by:** 03 - Deliver deterministic merge through a semantic command.

**Status:** ready-for-agent

- [x] The bridge publishes normalized deltas through an explicit CDP Runtime binding instead of using ordinary console messages as a protocol.
- [x] Every event includes generation, revision, event type, related operation ID, and normalized delta.
- [x] The Automation Runtime applies events in revision order and ignores provable duplicates.
- [x] Late or unsafe out-of-order events trigger recovery rather than overwriting newer state.
- [x] A bounded revisioned event queue can supply events missing after the host's last applied revision.
- [x] Recovery escalates through event-queue drain, targeted semantic read, baseline read, and broad snapshot.
- [x] Commands and events from an old context generation are rejected after execution-context replacement.
- [x] Scene changes, invalid references, and resolver failures invalidate the applicable runtime caches.
- [x] Pause and stop interrupt event waits, queue recovery, targeted reads, and reconstruction.
- [x] Tests cover duplicate, late, missing, overflowed, and gapped events plus context destruction, reconnection, pause, and stop.
