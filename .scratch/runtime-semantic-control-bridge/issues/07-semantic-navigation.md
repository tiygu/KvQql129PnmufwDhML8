# 07 - Deliver board and map navigation through semantic commands

**What to build:** Navigate to the board or map through semantic commands and confirm an explicit gameplay-area state instead of relying on a fixed settle duration. Handle cache invalidation and revision changes caused by scene transitions.

**Blocked by:** 04 - Deliver ordered events, loss recovery, and context reconstruction.

**Status:** ready-for-agent

- [x] Board and map navigation cross the Runtime Semantic Control Bridge instead of locating controllers in callers.
- [x] Requests for an already active target area return an idempotent result.
- [x] Completion uses a gameplay-area predicate, revisioned event, or targeted read rather than elapsed delay alone.
- [x] Scene transitions invalidate affected resolver caches and resolve against the new scene on demand.
- [x] Missing entrance, blocking overlay, pending scene, stale revision, and timeout have stable reasons.
- [x] Successful navigation avoids a broad snapshot unless semantic area state cannot be established.
- [x] Map mission confirmation and safety semantics remain unchanged.
- [x] Bounded and Idle Automation Sessions continue with the same normalized state after navigation.
- [x] Tests cover both directions, already-active targets, scene reconstruction, missing entrance, overlay, pause, stop, and timeout.
