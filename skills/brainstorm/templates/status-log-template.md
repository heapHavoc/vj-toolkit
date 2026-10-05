# Status Log — {Track Name}

**Created:** {YYYY-MM-DD}
**Tracks:** {N} PRDs across {M} phases
**Gate:** `DEFINITION-OF-DONE.md`

Living document. Update it as each PRD moves, not in a batch at the end — the value
here is the record of what actually happened, which nobody can reconstruct afterwards.

---

## PRD Tracker

One section per phase, one row per PRD. **Status must be one of:**
`Not Started` · `In Progress` · `Blocked` · `Done` · `Done with deviations`

Any other value renders as "Not started" on the docs board.

### Phase {N} — {Phase Name}

| # | PRD | Depends on | Status | Date | Notes |
|---|-----|-----------|--------|------|-------|
| 1 | {N.1} {kebab-slug} | — | Not Started | — | — |
| 2 | {N.2} {kebab-slug} | {N.1} | Not Started | — | — |

[Repeat one `###` section per phase, numbered in execution order.]

---

## Deviations & Decisions Log

Rows are keyed by PRD number so the docs board can assemble each spec's tab from
every table that names it. Add rows as they happen; leave the table empty until then.

| PRD | Deviation or decision | Why |
|-----|----------------------|-----|

---

## Blocker Log

| PRD | Blocked by | Owner | Raised | Cleared |
|-----|-----------|-------|--------|---------|
