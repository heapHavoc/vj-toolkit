# /preflight: release readiness gate

**Author:** Vishvam Joshi · **Status:** proposed for review · **Files:** `skills/preflight/`, `agents/preflight-verifier.md`

## 1. What it is
`/preflight` is a release-scoped check run before (or right after) `stage` merges into `main`. It compares the staging theme with the live theme on three layers: **code**, **performance** and **analytics**. It reports only what this release changes.

It is a **differ, not a checker**. Every check measures two states and reports the difference. Problems that exist on both sides are never reported, so the report stays short enough to act on.

It complements the feature pipeline (`/assess`, `/figma-verify`), which checks one feature in isolation. `/preflight` checks everything shipping together, against what's live.

## 2. Modes: two axes, never both at once
| Mode | Compares | Catches |
|---|---|---|
| `pre-merge` (default) | staging vs live, now | regressions introduced by this release's code |
| `baseline` | snapshot of live (never gates, never fails) | records a known-good state after a healthy release |
| `post-merge` | live now vs the last baseline | store drift that never touched code: customizer edits, app embeds switched off, Customer Events changes |

## 3. Pipeline: detect → verify → finalize
1. **Detect:** `run-preflight.mjs` runs the three checkers and writes the raw findings plus a worklist. No verdict yet; the report is a PENDING stub.
2. **Verify:** one `preflight-verifier` agent per layer with findings, all running in parallel. Each checks every candidate against the real code, measurements and screenshots, then writes `verification/<layer>.json`.
3. **Finalize:** `finalize-preflight.mjs` merges the verifier output and `config.accepted` (human sign-offs), computes the verdict and writes `preflight-report.md`.

The model never decides a verdict, and nothing is shown to the user before finalize. A verifier that fails leaves its items **unverified** at their raw priority, which is the safe default.

## 4. The checkers
**Code** (`check-code.mjs`): git plus static analysis on temporary worktrees, no browser.

| ID | Check | Priority |
|---|---|---|
| G1 | Merchant customizer edits about to be reverted (commits or editable files only on live) | P0 |
| G2 | App embeds lost (`settings_data.json` embed blocks); `G2-DRIFT` in post-merge | P0 |
| G3 | `robots.txt.liquid` modified | P0 |
| G4 | Deleted files still referenced | P0 |
| G5 | Blast radius (changed files by bucket) | info |
| S1 | Theme check delta | P0 |
| S2 | Integration | — |
| S3 | Schema ↔ settings drift | — |
| S4 | Cross-feature collisions | — |
| S5 | Secrets | — |
| S6 | Placeholder content | — |
| S7 | Standards delta | — |

S4, S6 and S7 are context-aware: rules know where the code is used, which removes most text-only false alarms.

**Performance** (`check-performance.mjs` + `lib/abtest.mjs`): an A/B experiment, not a Lighthouse score.

- **Setup:**
  - Both themes load through Shopify's preview path (`?preview_theme_id=…&pb=0`).
  - Theme identity and template are checked on every run.
  - The cache is warmed first.
- **Measuring:**
  - each load uses a fresh browser with real throttling (150 ms / 1.6 Mbps, CPU slowdown calibrated to the machine), alternating A/B
  - **timing tier** (pages whose template changed, or `key: true`): 10 runs per side, extended to 20 while a metric is unsettled. LCP, FCP, TBT and CLS are judged by Mann-Whitney U plus a bootstrap 95% CI against a practical threshold.
  - **counted tier** (every other affected page): bytes, requests, render-blocking resources and DOM size.
- **Verdicts:** REGRESSED / REGRESSED_MINOR / IMPROVED / UNCHANGED / INCONCLUSIVE. INCONCLUSIVE on LCP, TBT or CLS counts as a P0 skip, so a page that can't be decided never passes.
- **Lighthouse** runs only on pages that don't pass, for diagnosis (LCP breakdown, CLS culprits, render-blocking, document latency). It never decides a verdict.
- **Page selection** follows the theme's dependency graph (`lib/page-map.mjs`): only pages that render a changed file, plus `always` pages. A changed template with no configured page is reported as a coverage gap.

**Analytics** (`check-analytics.mjs`): Playwright runs the configured journeys (collection → product → add to cart → checkout intent) on both themes.

| ID | Check |
|---|---|
| A1–A3 | GTM container, GA4 tag and Meta pixel present (diff-based, not per-store flags) |
| A4 | Event parity: events that fire on live but not on staging (P0) |
| A5 | Event payload keys preserved (P1) |
| A6 | Network beacons reach GA/Meta endpoints (P1) |
| A7 | Cookie consent banner renders on first load (P1) |
| A8 | Journey steps complete on both sides |
| A-THEME | The journey ran on the intended themes |

Each step records whether it really happened (e.g. add-to-cart confirmed through `/cart.js`). Events whose step didn't run on both sides are SKIPPED, never passed.

## 5. Verdict model
It is computed per layer and never blended. The overall verdict is the worst layer:
- **RED:** any P0 confirmed or unverified
- **INCOMPLETE:** a checker crashed, a P0 check was skipped, or nothing on the layer was tested. Never read as a pass.
- **YELLOW:** any P1 confirmed or unverified, not covered by `config.accepted`
- **GREEN:** none of the above. P2 items are notes only.

Shipping past YELLOW needs a `config.accepted` entry (check, reason, by, date) and a re-run of finalize, not a chat message.

## 6. Per-project files
These live in `.buildspace/preflight/` in the theme repo, never in the toolkit:
- `preflight.config.json`: store, theme ids, pages, journeys, fixtures, thresholds, accepted. Created from `templates/preflight.config.example.json`.
- `preflight-baseline.json`: written by `--mode baseline`.
- generated: `preflight-raw.json`, `verification-worklist.json`, `verification/<layer>.json`, `preflight-final.json`, `preflight-report.md`, `artifacts/`

The storefront password is read only from `PREFLIGHT_STOREFRONT_PASSWORD` in the environment. It is never written to disk.

## 7. Correctness rules built in
`skills/preflight/README.md` lists 15 regression-tested rules. The main ones:
- A missing metric is never coerced to 0. An early version reported a broken page as a speed improvement.
- Multi-page journeys merge their captured state after every navigation.
- An empty comparison, or a layer where nothing ran, is INCOMPLETE, never GREEN.
- Unknown flags are rejected, and the compared refs and SHAs are printed first.
- Performance is an A/B experiment through the preview path. Lighthouse-only and live-URL-vs-preview comparisons flipped verdicts on real stores.

`scripts/__tests__/regression.test.mjs` covers these. Run it after any change.

## 8. Usage
```
/preflight                       # pre-merge: stage vs main
/preflight --mode baseline       # after a healthy release
/preflight --mode post-merge     # first-hour smoke test / drift check
```

Requirements:
- Node 18+
- Playwright Chromium, used by both browser checkers
- `lighthouse` and `chrome-launcher` (`scripts/package.json`), for performance diagnosis
- Shopify CLI, for theme check
- `gh`, only for `--post-pr`

## 9. Status and limits
- All three checkers support all three modes.
- Two layers are planned but not built: `check-runtime.mjs` (Liquid errors, missing translations, console and HTTP errors) and `check-features.mjs` (committed Playwright specs). The report's **Not checked** section says so.
- **Expect a calibration period.** Analytics A6/A7 and the preview-bar exclusions were built against simulated stores, so confirm results by hand on the first real client runs.
- Preflight is not in the published toolkit (3.5.0); it existed only in a local marketplace checkout. This change adds it to the plugin.

## 10. Summary
- Release-scoped gate for stage → main covering code, performance and analytics, reporting only what the release changes.
- Detect → verify → finalize: scripts measure, verifier agents confirm, and a script computes the verdict.
- Performance is a statistical A/B through Shopify's preview path. Lighthouse is diagnosis only.
- Verdicts are per layer (RED / INCOMPLETE / YELLOW / GREEN), and sign-offs are recorded in config.
- Treat the first real client runs as calibration.
