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
