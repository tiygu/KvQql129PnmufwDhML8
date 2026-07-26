# Separate display-icon selection from semantic snapshots

An Item Identity review commits a complete semantic snapshot, while the selected display icon remains an independently audited completeness and presentation decision. We chose this boundary because icon candidates arrive and change independently, missing icons do not block semantic validity or planning, and embedding the same selection in an identity snapshot would create two competing truths and make an abandoned identity draft appear partially committed.

## Consequences

Identity review snapshots and their meaningful differences exclude display-icon selection. The review workspace may show the current selected icon beside the semantic form, but selecting, replacing, or revoking it is recorded only as a display-icon decision and never makes the Item Identity human-verified. Semantic reviews and display-icon decisions use independent concurrency revisions, so one does not make an otherwise current draft stale; candidate ownership is still validated when a selection is committed.
