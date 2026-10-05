---
name: docs-viewer
description: Serve the project's docs/ folder as a beautiful editorial board and reader in the browser. Use when the user asks to view docs, see the roadmap board, read PRDs/specs in the browser, or start the docs viewer.
---

# Docs Viewer

Serves the current project's `docs/` folder as a local web app: an editorial
"publication cover" board (progress panel, core-document shelf, phases as
numbered chapter columns, specification cards) and a paper-sheet reader page
per markdown document. Read-only; it never modifies project files.

## How to run

1. Confirm a `docs/` folder exists at the project root. If not, tell the user
   and stop.
2. Pick a port: default `4488`. If busy (`lsof -nP -iTCP:4488 -sTCP:LISTEN`),
   use the next free one (4489, 4490, ...). If the busy port is already this
   viewer for this same project (check the output of `curl -s
   localhost:<port>/api/state` for the matching `projectName`), just give the
   user the URL — do not start a second server.
3. Start it in the background from the project root (cwd matters — the server
   reads `<cwd>/docs`):

   ```bash
   DOCS_VIEWER_PORT=4488 node .claude/skills/docs-viewer/assets/server.mjs
   ```

   Or simply `npm run docs:view` in this project.

4. Verify with `curl -s http://localhost:<port>/api/state` (expect JSON with
   `projectName` and `stats`), then give the user the URL.

`DOCS_DIR=/path/to/docs` overrides the docs location if a project keeps docs
elsewhere. `ROADMAP_DIR=roadmap-pdp` points the board at a different track —
see Tracks below.

No dependencies are installed — the markdown renderer is bundled inside this
skill (`assets/vendor/marked.umd.js`). Fonts load from Google Fonts and fall
back to system fonts offline.

This skill lives in the repo's `.claude/skills/` and travels with the project.
To use it in another project, copy the `docs-viewer/` folder into that repo's
`.claude/skills/` (it is self-contained).

## Conventions the viewer understands

Everything below is optional; the viewer degrades gracefully (no roadmap →
documents-only view; no status log → everything shows "Not started").

- `docs/*.md` — core documents (shelf in the hero panel). Titles come from
  well-known names (prd.md, tdd.md, api-contract.md), else the file's first
  `# heading`, else the filename.
- `docs/<roadmap>/phase-<N>-<slug>/` — one board column per phase, ordered by N.
  `<roadmap>` is `roadmap` by default, or whatever `ROADMAP_DIR` names.
  - `overview.md` — phase title from its `# Phase N: Title` heading.
  - `<N>.<M>-<slug>.md` — one card per specification. Card metadata is read
    from a leading `# PRD: N.M — Title` heading and `**Priority:** /
    **Depends on:** / **Estimated scope:**` lines when present.
- `docs/<roadmap>/status-log.md` — the single source of truth for delivery
  status. A spec is "Delivered" iff the log contains an entry heading of the
  exact form:

  ```
  ## YYYY-MM-DD — N.M Title — ✅ Complete
  ```

  The entry's body is shown in the reader under a "Status log" tab on that
  spec's page.

The page polls every 5 seconds and reads files fresh from disk on every
request, so edits to any doc or the status log appear without restarting.

## Tracks

A project with more than one roadmap keeps each in its own sibling folder, named
`roadmap-<track>` — this is what `/brainstorm` produces:

```
docs/
  tdds/
  roadmap-homepage/
  roadmap-navigation/
```

The viewer shows **one track at a time**. Run an instance per track, each on its
own port:

```bash
ROADMAP_DIR=roadmap-homepage   DOCS_VIEWER_PORT=4488 node <path>/server.mjs
ROADMAP_DIR=roadmap-navigation DOCS_VIEWER_PORT=4489 node <path>/server.mjs
```

A single board listing every track is not built yet.

> **Status vocabulary.** This server reads delivery status from per-spec
> `## YYYY-MM-DD — N.M Title — ✅ Complete` headings, giving two states:
> delivered or not. `/brainstorm` scaffolds a `## PRD Tracker` table instead,
> which supports `Not Started` / `In Progress` / `Blocked` / `Done` /
> `Done with deviations` — **this server cannot read that format** and will show
> every spec as "Not started". Until the table parser is merged in, either keep
> the heading format in `status-log.md` or run a fork that parses the table.

## If a project's docs layout differs

Do not edit the skill's assets to fit one project. If the structure deviates
only slightly (e.g. different status-log heading punctuation), suggest
aligning the docs with the convention above. For a genuinely different layout,
copy `assets/` into the project (e.g. `scripts/docs-viewer/`) and adapt the
copy's parsing there.
