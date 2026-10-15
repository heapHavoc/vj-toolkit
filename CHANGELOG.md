# Changelog

## 3.6.0 (proposed, vj-toolkit, on top of 3.5.0)

Full write-up: [docs/improvements.md](docs/improvements.md). Preflight: [docs/preflight.md](docs/preflight.md). Next proposal: [docs/proposals/learnings.md](docs/proposals/learnings.md).

### Added
- **`/figma-rest`**: Figma extraction over the REST API with a personal access token. No MCP quota. A pasted link and a Dev Mode prompt give the same result. Per-section Dev Mode-style dumps and `.json` specs, resolved prototype interactions, behaviour signals, per-section screenshots, and assets.
- **`/figma-verify`**: browser verification on the dev server with Playwright:
  - exact measured match at the Figma frame widths
  - an 11-width layout sweep
  - interaction tests
  - one approval gate, then an automatic fix loop (max 5 rounds, stops on no progress or regression)
  - a mandatory "Unfixed mismatches" list
  - a `check-only` mode
  - shares `preview-url.txt` with `/compare`
- **`/preflight`** + `preflight-verifier` agent: a release readiness gate for stage → main.
- **Preflight run log**: every run (finalized, baseline, or never finalized) is archived to `.buildspace/preflight/runs/` and sent, scrubbed, to a shared Supabase project, with an optional "did preflight miss anything?" answer. Includes the schema and analysis views (`telemetry/supabase-setup.sql`), `record-feedback.mjs`, `analyze-runs.mjs`, a retry queue, and an off switch (`PREFLIGHT_TELEMETRY=0` or per project).
- **Performance audit and documentation skills** (`/perf-scan`, `/perf-client-audit`, `/perf-apps-audit`, `/perf-report`), ported from personal skills and fixed: details in [docs/perf.md](docs/perf.md).
  - One Node scan engine: median of 3 runs per device, one folder per site / theme / **page** (scans of different pages no longer overwrite each other's "latest"), API key from `PAGESPEED_API_KEY` or `.buildspace/.psi-key` and never printed, retries.
  - Reads Lighthouse 12/13 insight audits with older ids as fallback, and says when a section isn't reported instead of showing an empty table. No Time to Interactive and no lab INP.
  - The Core Web Vitals verdict comes from real-user field data (page, else origin), never from lab metrics; desktop gets desktop thresholds.
  - Reports are written as .md and exported to .docx in the house document style (`md-to-docx.mjs`); names include site, page and date.
  - Apps audit traces each script to theme code, an app embed, an app block or the platform, with a known-apps reference instead of client-specific lists.
  - Regression tests: `skills/perf-scan/scripts/__tests__/perf.test.mjs`.
- **Preflight dependencies install themselves**: Playwright, Lighthouse and Chromium are installed once into a per-user folder that survives plugin updates. Previously the plugin shipped without them and browser checks were SKIPPED.
- **UserPromptSubmit hook**: routes Figma links to `/figma-rest`.

### Changed
- **`/plan`**:
  - reads the figma-rest dumps and specs
  - writes per-frame-width design values mapped to tokens
  - decides each section's name and wrapper selector
  - lists interactions as test cases
  - adds a **Deviations from Figma** section
  - follows project `CLAUDE.md` conventions
- **`/execute`**:
  - builds from the section specs
  - uses Figma copy for content
  - flags Figma contradictions
  - rebuilds compiled CSS
  - writes `hooks` in `selectors.json`
  - logs deviations from Figma
  - hands off to `/figma-verify`
- **`/compare`**: hands mismatches to `/fix` instead of invoking it. `/fix` is user-invoked (`disable-model-invocation`) and stops for approval, so the auto-invoke from a forked context can't complete.
- **`/assess`**:
  - project `CLAUDE.md` conventions override generic standards in the code-reviewer prompt (no false positives for Tailwind projects)
  - a Design Fidelity step copied from `verify-report.md` / `comparison-report.md`
- **`/fix`**: suggests `/figma-verify check-only` after design-affecting fixes.
- **README**:
  - new pipeline and skills
  - plugin hooks load automatically, so don't copy them into project settings (that runs them twice)

### Unchanged
`/figma`, `/clarify`, `/grill-me`, `/brainstorm`, `/docs-viewer`, `/clickup`, `/understand`, `/research`, standards skills, agents, `verify-integration.mjs`.

### Merge note
Bump `shopify-theme-toolkit` in the marketplace's `.claude-plugin/marketplace.json` to 3.6.0 as well.
