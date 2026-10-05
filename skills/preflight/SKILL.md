---
name: preflight
description: >
  Release readiness gate for a stage → main merge. Diffs the staging (preview)
  theme against the live theme across code, performance, and analytics, and
  reports only what this release changes — never pre-existing conditions.
  Run before merging staging into live (pre-merge), right after merge as a
  first-hour smoke test (post-merge), or to snapshot a known-good release
  (baseline).
disable-model-invocation: true
context: fork
allowed-tools: Read, Write, Bash, Glob, Grep, Agent
---

# Preflight — Release Readiness Gate

You are entering the Preflight phase. This is release-scoped, not feature-scoped: it looks at everything that changes when `stage` merges into `main`, across every feature that shipped this sprint — not one feature's `execution-log.md`.

**This is a differ, not a checker.** Every check measures two states and reports the delta. Report regressions this release introduces. Never report a condition that already exists on both sides — that is noise the report will be ignored for.

Deterministic logic lives in the scripts under `scripts/`; judgement about whether a candidate finding is real lives in the `preflight-verifier` agents; the verdict is computed by `finalize-preflight.mjs` from their output. You orchestrate and present — you never decide a verdict yourself, and you never present findings that haven't been through finalize.

---

## The two axes (read this before picking a mode)

Preflight compares state along one of two axes, never both at once:

- **Branch axis** (`--mode pre-merge`, the default): staging vs. live, right now. Catches things this release's code changed.
- **Time axis** (`--mode baseline` then `--mode post-merge`): live now vs. live at the last known-good release. Catches store-level drift that never touched theme code at all — a pixel edited in the customizer, an app embed toggled off, a Customer Events change. These bypass the branch axis entirely because they're already live on both themes.

`--mode baseline` only ever snapshots — it never gates and never fails the run. Run it once after a release goes out and is confirmed healthy. `--mode post-merge` then diffs current live against that snapshot; it needs the baseline to already exist or it SKIPs and tells you to baseline first.

---

## Input

Context or overrides: `$ARGUMENTS` — may specify `--mode pre-merge|post-merge|baseline`, branch names, or `--live-url`/`--preview-url`. Defaults: `--mode pre-merge`, live branch `main`, staging branch `stage`.

---

## Config resolution

1. Look for `.buildspace/preflight/preflight.config.json` at the repo root.
2. If missing, copy `${CLAUDE_SKILL_DIR}/templates/preflight.config.example.json` to that path, fill in what you can infer (branch names from git, store domain if known), and tell the user what's left to fill in (fixture handles, theme IDs) before the browser-based checkers can run. `analytics.expectGTM`/`expectGA4`/`expectMetaPixel` no longer need calibrating — A1-A3 and A6 are diff-based (reference vs current) now, not gated on these flags, precisely because a hardcoded per-store assumption kept going stale the moment the config regenerated from this template and silently reintroduced false positives. The fields are kept in the schema for now (harmless, unread by pre-merge/post-merge) but don't tell the user they need to set them correctly before trusting a run.
3. `check-code.mjs` needs no config for `pre-merge`/`post-merge` (git refs alone are enough) — it only reads config for the standards-ignore list, if present. Performance needs `config.store` (the primary domain, e.g. `example-store.com`), `config.themes.preview.themeId`, `config.themes.live.themeId` (detected from the storefront if absent), and `config.pages` (one entry per page type the store uses — `{ name, path, template, liveTemplate?, view?, previewView?, always?, key? }`; `template` is what the preview side must render and `liveTemplate` what the live side must render (both are asserted on every run); `key: true` forces the full timing A/B on that page; set `template` explicitly when products/collections use an alternate template like `product.default`). Analytics needs `config.analytics.journeys` (`{ name, collection, product, productView?, productPreviewView? }`); both fall back to `config.fixtures`. When filling these in, check the live page's `<body>` class for the real template suffix rather than assuming `product`.
4. Never write `PREFLIGHT_STOREFRONT_PASSWORD` to disk. If the user gives you a password, tell them to export it as an env var instead — every browser-based script reads it from the environment only.
5. `.buildspace/preflight/preflight-baseline.json` is written by `--mode baseline` and read by `--mode post-merge`. Both config and baseline are per-project files, not part of this plugin — never commit a real client's config/baseline into the toolkit repo itself.

---

## Scope

All three checkers from the brief are wired in and complete: `check-code.mjs`, `check-performance.mjs`, `check-analytics.mjs`, each supporting all three modes. The two planned-but-not-built layers (`check-runtime.mjs`, `check-features.mjs`, brief §13) are not started — `run-preflight.mjs`'s `CHECKERS` list is where they'd be added; nothing else about the orchestrator or report changes when they land. Say so plainly in the report's **Not checked** section — do not imply broader coverage than what actually ran.

Both browser-based checkers need Chromium via Playwright (performance also uses `lighthouse` + `chrome-launcher`, for diagnosis only). Missing dependencies, an unresolvable URL, or a broken page degrade to `SKIPPED`/`FAIL` with a reason — never a fabricated pass. This was verified in development: an early version of `check-performance.mjs` let a completely broken preview page's `null` metrics coerce to `0` in the delta math, reporting total breakage as a "speed improvement" — fixed, and now any invalid measurement is an explicit P0. `check-analytics.mjs` similarly had a bug where multi-page journey state was wiped by every `page.goto()` navigation, silently losing every event fired before the last page — fixed by pulling and merging captured state after each step, not just once at the end.

Neither browser checker has been run against a real live Shopify store end-to-end — only exercised against local test servers/pages that simulate GTM/GA4/Meta pixel and Lighthouse-measurable pages. Confirm with the user before treating a real client run's output as fully trustworthy on first use, per the brief's "expect a calibration period" note (§6) — this applies especially to `check-analytics.mjs`'s A6 (network beacons) and A7 (consent banner heuristic), and to `check-performance.mjs`'s preview-bar exclusion patterns, which are a best guess pending verification against a real client preview URL.

---

## The pipeline: detect → verify → finalize

A checker FAIL is a **candidate**, not a verdict — the checkers pattern-match and measure, and both produce false alarms (a raw `{{ x.price }}` in a `data-price` attribute, a scoped CSS override, one bad Lighthouse run). The verdict comes only from verified findings:

1. **Detect** — `run-preflight.mjs` runs the checkers, writes raw findings + a worklist. No verdict, no real report (it writes a PENDING stub).
2. **Verify** — one `preflight-verifier` agent per layer that has worklist items checks each finding against the real code / runs / screenshots and writes `verification/<layer>.json`.
3. **Finalize** — `finalize-preflight.mjs` merges verifier output + `config.accepted`, computes the verdict, writes `preflight-report.md`.

Never present a verdict, a RED/YELLOW/GREEN, or a findings list to the user before step 3 has run.

## Step 1 — Detect

```bash
node ${CLAUDE_SKILL_DIR}/scripts/run-preflight.mjs \
  --live-branch <live-branch> \
  --staging-branch <staging-branch> \
  --root . \
  --mode <mode> \
  --config .buildspace/preflight/preflight.config.json
```

- Unknown flags are rejected (exit 2) and `--help` prints usage — never guess a flag; run `--help` if unsure. The first line on stderr names the exact refs and SHAs being compared; if that isn't the comparison the user asked for, stop and say so.
- **Pages** (pre-merge): by default the script tests every `config.pages` entry whose template renders a file this diff changed, plus `always: true` pages (a layout/global change selects every page). `--pages a,b` narrows, `--all-pages` widens, explicit `--live-url/--preview-url` (repeatable, `--page-name` per pair) overrides. A changed template with no configured page becomes a `PERF-COVERAGE-*` SKIPPED check — P0 if the template file itself changed, P1 if it only renders changed files.
- **Journeys** (analytics): every `config.analytics.journeys` entry runs on both sides; preview params (`preview_theme_id`, `pb`, `productPreviewView`) are carried on every step. Each step records whether it really happened (add-to-cart confirmed via `/cart.js`, checkout intent observed) with a screenshot on failure; events whose step didn't run on both sides are SKIPPED, not passed.
- **Performance** compares the **live theme vs the preview theme, both loaded through Shopify's preview path** (`?preview_theme_id=<id>&pb=0`). The live theme id comes from `config.themes.live.themeId`, or is detected from the storefront's `server-timing` header.
  - **Setup per page:** the theme id and template are checked before measuring and on every run (`server-timing` theme, `<body>` template class). Then unmeasured warm-up loads run until Shopify's render cache is warm.
  - **Measuring:** each load uses a fresh browser with real throttling (150 ms / 1.6 Mbps, CPU slowdown calibrated to the machine), alternating A/B.
  - **Two tiers.** **timing** pages, whose template this diff changed or that are marked `key: true`, run 10 runs per side, extended to 20 while any metric is unsettled. That takes about 15–25 min per page, judged per metric by Mann-Whitney U plus a bootstrap 95% CI against a practical threshold. **counted** pages (every other affected page) take about 1 min and are judged on bytes, requests, render-blocking resources and DOM size only.
  - **Verdicts:** REGRESSED, REGRESSED_MINOR, IMPROVED, UNCHANGED, or INCONCLUSIVE. INCONCLUSIVE is SKIPPED, and P0 for LCP/TBT/CLS, so the layer can't go GREEN on an undecided page.
  - **Lighthouse** runs once per side, only on non-passing pages, to supply insights (`lcp-breakdown`, `cls-culprits`, `render-blocking`, `document-latency`). It never decides a verdict.
  - **Why:** Lighthouse's simulated throttling and the live-URL-vs-preview comparison were proven unreliable on real stores. They flipped verdicts, produced a false CLS P0, and missed a 21% LCP improvement. See README rule 15.

For `--mode baseline`, `--staging-branch` is irrelevant and the script writes `.buildspace/preflight/preflight-baseline.json` — there is no verify/finalize step and no verdict. For `--mode post-merge`, add `--baseline-file <path>` only if the baseline isn't at the default path.

The script prints a JSON summary: `worklist.byLayer` tells you which layers need a verifier.

## Step 2 — Verify (one agent per layer, in parallel)

For each layer with `worklist.byLayer[layer] > 0`, dispatch a verifier — **all of them in one message** so they run concurrently:

- `subagent_type: "shopify-theme-toolkit:preflight-verifier"` if available; otherwise `general-purpose` with the full contents of `${CLAUDE_SKILL_DIR}/../../agents/preflight-verifier.md` pasted as its instructions.
- Prompt: the `layer`, the repo `root`, the config path, the scripts dir `${CLAUDE_SKILL_DIR}/scripts`, and a scratch dir for any re-measurement. Nothing else — the worklist and raw files carry the evidence.
- Each writes `.buildspace/preflight/verification/<layer>.json`. You do not write verifier output yourself and you do not edit it.

If a verifier fails or times out, do not re-verify its items yourself in chat — its items stay `unverified` and keep their raw priority, which is the safe outcome. Tell the user which layer went unverified.

## Step 3 — Finalize

```bash
node ${CLAUDE_SKILL_DIR}/scripts/finalize-preflight.mjs --root . --config .buildspace/preflight/preflight.config.json
```

Append `--post-pr` only for `--mode pre-merge`, and only if the user confirmed a PR exists and they want the report posted there. Otherwise `.buildspace/preflight/preflight-report.md` is the deliverable. The finalize summary JSON gives the verdict per layer and the item counts (confirmed / unverified / false alarm / accepted).

Status model (per layer, never blended; overall = worst):
- **RED** — any P0 finding confirmed or unverified.
- **INCOMPLETE** — a checker crashed, a P0 check was SKIPPED (e.g. an event that couldn't be tested, an empty diff, a changed template with no page), or nothing on the layer was tested. Never read as a pass.
- **YELLOW** — any P1 finding confirmed or unverified.
- **GREEN** — none of the above. P2 findings (e.g. CSS comments) are listed as notes and never gate.

A human sign-off on a YELLOW is an entry in `config.accepted` (`check`, optional `file`/`rule`/`match`, required `reason`, `by`, `date`) followed by a re-run of finalize — not a chat message.

## Step 4 — Present

From the finalized report only. Tell the user:
- The overall verdict and per-layer status (and the raw pre-verification status, so they can see what verification changed).
- Every P0, in full, with the verifier's evidence; P1s and that shipping past YELLOW needs a `config.accepted` entry.
- What verification dismissed and why (one line each) — dismissals are where a verifier can be wrong.
- Anything INCOMPLETE and exactly what would make it testable (a page to add, a selector to configure).
- The report path and the **Not checked** list.

## Rules

- Never fail the run on a tooling error. Missing CLI, unreachable ref/URL, missing baseline, or a script crash is `SKIPPED` with a reason — never a silent pass, never a fabricated red. A skipped P0 makes its layer INCOMPLETE.
- Never write, edit, or "fix up" a verifier's output file, and never present a raw (pre-finalize) status as the verdict.
- Never post to a PR unless the user explicitly asked, mode is `pre-merge`, and `gh` confirms one exists for the staging branch.
- Never invent a new status value, a new config key, or a fourth checker without asking first.
- Do not re-implement a check that already exists in `code-reviewer`/`output-validator` at feature scope — `check-code.mjs` owns the release-scoped version of the same rules; keep it that way if you extend it.
- A metric or event that returns no value (null) is never coerced into a delta calculation — it's `SKIPPED` for that one metric, or the whole check FAILs if it means the page itself is broken. This is a hard-won rule (see Scope above) — do not "simplify" it away when extending these scripts.
