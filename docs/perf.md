# Performance audit and documentation skills

**Author:** Vishvam Joshi · **Status:** proposed for review · **Files:** `skills/perf-scan/`, `skills/perf-client-audit/`, `skills/perf-apps-audit/`, `skills/perf-report/`

## 1. What they are
Four skills that turn PageSpeed Insights data into client documents:

| Skill | Was | Produces |
|---|---|---|
| `/perf-scan` | `/psi-scan` | The data: PageSpeed mobile + desktop, median of 3 runs, saved per page (`scan.md`, `summary.json`, raw JSON) |
| `/perf-client-audit` | `/audit` | A plain-English audit for a non-technical client (.md + .docx) |
| `/perf-apps-audit` | `/third-party-audit` | Which apps slow the page, how each is loaded, priority and actions (.md + .docx) |
| `/perf-report` | `/performance-report` | A before / after optimisation report from two scans and the git diff (.md + .docx) |

They were personal skills in `~/.claude/skills`. This change moves them into the toolkit in its standard form, and fixes the problems found in review.

## 2. Flow

```
/perf-scan <home> <collection> <product>
   ├─ /perf-client-audit <url>     audit for the client
   ├─ /perf-apps-audit <url>       app-by-app impact
   └─ /perf-report <before> <after>   after an optimisation, with the two branches
```

The three report skills reuse a scan when one exists (asking first), or run one. All files live under `.buildspace/artifacts/perf/` and are never committed:
- scans: `scans/<site>/<theme>/<page>/<YYYY-MM-DD-HHMM>/`
- reports: `reports/<site>/<kind>-<page>-<YYYY-MM-DD>.md` and `.docx`

## 3. What changed and why

### Moved into the toolkit's standard shape
| Toolkit convention | Before | Now |
|---|---|---|
| Frontmatter (`disable-model-invocation`, `allowed-tools`, multi-line description) | Plain `name` / `description` / `version` | Same frontmatter as the other workflow skills |
| Logic in scripts under `scripts/`, called through `${CLAUDE_SKILL_DIR}` | About 20 inline `jq` commands the model ran by hand | `perf-scan/scripts/psi-scan.mjs` (Node 18+, no dependencies) |
| Layouts in `templates/` | Report structures embedded in each SKILL.md | `templates/*-template.md` per skill |
| References in `references/` | Vendor names hardcoded into instructions | `perf-scan/references/thresholds.md`, `perf-apps-audit/references/known-apps.md` |
| Next-step hand-offs | None | Each skill ends with the next command |
| Regression tests | None | `perf-scan/scripts/__tests__/perf.test.mjs` (12 tests, fixture responses in both Lighthouse 11 and 12 shapes) |
| No client names or secrets | A client's domain, preview id and app list | Generic; known apps in a reference file |

### Bugs fixed
| Problem | Effect | Fix |
|---|---|---|
| Scan folders keyed on site + theme only | Home, product and collection scans shared one folder, so a report could read the wrong page's "latest" | One folder per site / theme / **page** |
| Reads audits Lighthouse 12/13 removed or renamed | Empty tables shown as if there were no issues; null LCP element | Insight audit ids first, older ids as fallback; missing sections are labelled "Not reported by this Lighthouse version" |
| Time to Interactive and lab INP | TTI no longer exists; INP has no lab value | Removed; INP is reported from field data only, with TBT as its lab stand-in |
| Core Web Vitals pass / fail with no field data read | A verdict without evidence | Verdict only from real-user (CrUX) data: page, else whole origin (labelled), else "not enough data" |
| One PageSpeed run per device | Before / after claims within run-to-run noise (±5–10 points) | Median of 3 runs, with the range; details from the median run |
| Mobile thresholds applied to desktop | Desktop rated too generously | Device-specific thresholds (`thresholds.md`) |
| CLS rating cut-off at 0.75 | Inconsistent with every other metric | One rule for all: Good ≥ 0.9, Needs improvement ≥ 0.5 |
| Third-party "share of TBT" from main-thread time | Different measures mixed | Share of TBT only from blocking time; otherwise shown as main-thread time |
| Shared `/tmp/psi-*.json` files | Two scans at once overwrite each other | Responses saved in the scan's own folder |
| Report names `Audit.md`, `Audit-2.md` | Reports for different sites and pages collide | `<kind>-<page>-<date>.md` per site |
| Inconsistent column order | Mobile / Desktop in some tables, Desktop / Mobile in others | Mobile first everywhere |
| Preview URL not checked | A preview that redirects to live measures the live theme | Redirect warning in every scan; `/perf-report` confirms each URL shows the intended branch |
| API key in a shell command | Key visible in shell history | Read by the script from `PAGESPEED_API_KEY` or `.buildspace/.psi-key`; never printed, stripped from errors |
| Markdown only | Client documents had to be reformatted by hand | Every report also exported to .docx in the house document style |

### Improved
- **Apps audit traces how each script arrives**: theme code (file and line), app embed (`config/settings_data.json`), app block (template JSON), or platform (`content_for_header`, Customer Events). Recommendations match: a code change, a theme-editor or app setting, or a business decision.
- **Before / after report** checks that both scans are the same page and taken the same way, and only describes changes that exist in the git diff.
- **Field data lag is explained**: real-visitor results reflect 28 days, so the report says when to re-check.

## 4. The scan engine
`perf-scan/scripts/psi-scan.mjs`:
- **Runs:** PageSpeed v5 for mobile and desktop in parallel, `--runs` times each (default 3), with retries on 429/5xx and a 2-minute timeout per run.
- **Extracts** (`lib/extract.mjs`):
  - category scores, lab metrics (FCP, LCP, TBT, CLS, SI)
  - field data (LCP, INP, CLS, FCP, TTFB) with the Core Web Vitals verdict
  - LCP element and phases
  - failing insights by estimated savings
  - render-blocking, images, third parties (entity and resource), JS execution, main-thread work, unused JS/CSS, caching, layout shifts, fonts, page weight, DOM size, duplicated/legacy JS, server response
  - accessibility / best-practices / SEO failures
- **Combines:** median scores and metrics with ranges; details from the median run.
- **Writes:** `summary.json` for the report skills and `scan.md` for people.

`perf-scan/scripts/md-to-docx.mjs` exports any report to .docx (Manrope, navy headings, bordered tables with a light header row, no em dashes). It installs the `docx` package once into a per-user folder that survives plugin updates.

## 5. Requirements
- Node 18+.
- A free PageSpeed Insights API key as `PAGESPEED_API_KEY` (or in `.buildspace/.psi-key`, gitignored). Without one the API allows only a few requests.
- `/perf-apps-audit` and `/perf-report` run from the theme repo root; `/perf-report` needs both branches locally.

## 6. Status and limits
- Unit-tested against fixture responses. Not yet run against a live store, so treat the first real runs as a check that every section fills in on the current Lighthouse version.
- Lab results are a controlled test, not real visitors. Reports say so.
- The original personal copies in `~/.claude/skills` (`psi-scan`, `audit`, `third-party-audit`, `performance-report`) should be moved aside once the plugin version is installed, so each command exists once.

## 7. Summary
- Four performance skills now follow the toolkit's conventions: scripts, templates, references, tests, hand-offs.
- One scan engine replaces hand-run `jq`: median of 3 runs, one folder per page, current Lighthouse audits, key never printed.
- Core Web Vitals verdicts come from real-visitor data only; desktop and mobile each use their own thresholds.
- Every client document is produced as .md and .docx in the house style.
- The apps audit shows how each app is loaded, so each recommendation is something someone can actually do.
