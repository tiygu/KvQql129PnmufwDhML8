# Catalog directory and icon harvesting release runbook

This runbook releases the complete Item Identity directory and Icon Harvest Job
lifecycle through three ordered gates. The output is a reviewable directory plus
a sibling ZIP archive containing command logs, database summaries, performance
measurements, screenshots, runtime task/evidence records, rollback commands, and
known limitations.

> **ADR note:** the 250 ms query and 2 s projection-rebuild thresholds are an
> issue-specific release gate from #33/#44. They deliberately override
> ADR-0002's preference against fixed numerical release gates for this rollout;
> they are not a permanent product SLO.

## Prepare

1. Copy `docs/catalog-release.example.json` to a local config and replace:
   - `releaseId`
   - `decisionOwner`
   - `knownLimitations`
   - `TARGET_CHAIN_ID`
   - `TARGET_SERVICE_SWITCH`, `PREVIOUS_SERVICE_VERSION`,
     `TARGET_BACKUP_RESTORE`, and `BACKUP_PATH`
2. Create `.release-inputs/catalog-rollback-observations.json` from the
   compatibility, revision-isolation, SQLite fault-injection, and human-decision
   preservation checks. Use the trigger field names listed under
   **Rollback decision**, with boolean or numeric observations.
3. Confirm the chain has at least 20 frozen members.
4. Build the console once with `npm run web:build`.
5. For the real-runtime stage, follow the reliable connection order:
   start `npm run wx:cdp:debug`, then open the game, then start the control
   service. Pause action execution before icon harvesting.

Run the release:

```powershell
npm run release:catalog:verify -- `
  --config docs/catalog-release.local.json `
  --evidence-dir .release-evidence/catalog-icons-YYYY-MM-DD
```

The runner never enters a later gate after an earlier failure. A blocked run
still produces its manifest, summary, logs, and ZIP so the failure is reviewable.
Before Gate 1, `entryModeGuard` switches the service to `legacy-advanced` and
reads the control endpoint back. A failed guard leaves the recorded mode
`unknown` and skips every release gate. The verifier also requires a non-empty
release ID, decision owner, and the complete command-ID set shown in the example
configuration; a shortened validation plan is blocked.

## Gate 1: compatible migration

Entry mode remains `legacy-advanced`.

`release:catalog:rehearse` creates three disposable database fixtures:

- `fresh`
- `sanitized-legacy` with identities, human rulings, and icon evidence
- `boundary` with stale automatic selection, protected manual selection,
  missing provenance/asset, duplicate evidence, and unfinished work

Each fixture is physically downgraded by removing the v4 evidence-currency
tables and columns before it starts twice. Both starts must point to the same readable pre-v4
backup and preserve or increase identity, ruling, evidence, and audit counts.
The rehearsal also imports and reads a legacy catalog projection, toggles and
restores the old entry mode, verifies every boundary condition, and restores a
copy of the backup into a separate database before comparing counts.

The gate also runs the existing migration and compatibility contracts. Any
identity, ruling, evidence, or audit reduction blocks the read-only gate.

## Gate 2: read-only catalog API and console

Icon writes remain disabled.

The API contracts cover stable error codes, cursor/query binding, Catalog Query
Revision conflicts, REST recovery, and no-store behavior. The release
performance runner builds the configured realistic catalog and records three
warmed list, search, and detail runs plus three cold projection rebuilds.
Every recorded query run must be at most 250 ms and every rebuild at most 2 s.

The Playwright suite covers:

- complete-directory search, filters, deterministic server order, and paging
- Item Identity deep links and stable not-found state
- relationship navigation and return-context restoration
- Display Icon Selection management
- non-blocking Icon Harvest Job monitoring
- two-console revision convergence
- keyboard navigation and horizontal fit at the supported 1000 x 700 viewport

When `CATALOG_RELEASE_SCREENSHOT_DIR` is set, the suite writes named screenshots
for the directory detail, icon-evidence grouping, and minimum viewport. All
configured screenshots must exist before this gate passes.

## Gate 3: icon-write lifecycle

Run the job contract, repository check, web build, and package-file check before
the live request. The package check requires the Node entry points, built
console, WMPF route, and `wmpf/frida/**/*`.

The real-runtime collector:

1. reads the complete directory without mutation;
2. runs one explicitly selected single-item Icon Harvest Job;
3. obtains and confirms one frozen Merge-Chain Icon Harvest preflight;
4. waits for authoritative terminal snapshots;
5. compares dashboard actions before and after;
6. replays the same idempotent merge-chain request and verifies that it returns
   the same job;
7. retains every child task and verifies every successful result against a
   persisted candidate ID, available asset, and provenance record.

The configured chain must contain at least 20 unique members. The manifest
records and enforces minimum success, maximum deferred, and maximum failed
and maximum cancelled counts. The example requires at least 15 successes,
allows at most 5 deferred members, and allows no failed or cancelled members.
The deferred and cancelled limits must be finite. Any game action generated
during the harvest blocks the gate.

After a successful third gate, the runner executes and verifies the configured
activation command. Only that verified command sets the recorded active entry
mode to `full-snapshot`.

## Rollback decision

The following observations immediately disable the icon-write entry:

- Item Identity loss (`identityLoss`)
- human ruling loss (`humanRulingLoss`)
- human Display Icon Selection loss (`humanSelectionLoss`)
- cross-identity write (`crossIdentityWrite`)
- duplicate work from an idempotent request (`duplicateIdempotentWork`)
- Catalog Query Revision isolation failure (`revisionIsolationFailure`)
- success reported after SQLite failure (`falseSuccessAfterSqliteFailure`)
- old-entry incompatibility (`oldEntryIncompatibility`)

Deferred resources, queue-full admission, operator cancellation, unloaded
resources, and explainable individual quality rejection are recorded but do not
independently trigger rollback.

When a fatal observation is present, the runner executes the first two rollback
steps immediately, stores their stdout/stderr logs, and keeps the active entry
mode at `legacy-advanced`. Rollback order:

1. execute `rollback.switchEntryMode`;
2. execute `rollback.switchServiceVersion`;
3. preserve the forward-migrated database, committed evidence, human decisions,
   and audit history.

Use `rollback.restoreBackup` only when the service is stopped and the database is
damaged or unbootable. Record the decision owner, active entry mode, backup
location, executed command, and result in the evidence package.

## Evidence layout

```text
.release-evidence/catalog-icons-YYYY-MM-DD/
|-- manifest.json
|-- SUMMARY.md
|-- artifacts/
|   |-- catalog-migration.json
|   |-- catalog-performance.json
|   |-- catalog-runtime-smoke.json
|   `-- *.png
`-- commands/
    `-- *.log
.release-evidence/catalog-icons-YYYY-MM-DD.zip
```

`manifest.json` is authoritative for gate order and status. Every copied
artifact carries a SHA-256 checksum and byte count. `SUMMARY.md` is the
human-readable handoff; the JSON artifacts retain the full measurements and
task/evidence records.
