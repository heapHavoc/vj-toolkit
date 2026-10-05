# shopify-theme-toolkit 3.6.0: Figma pipeline improvements

**Author:** Vishvam Joshi · **Status:** proposed for review · **Base:** shopify-theme-toolkit 3.5.0 (`devx-shopify/shopify-standards-marketplace@93eca1a`)

## 1. Summary

The Figma path of the toolkit had three weak points:
- Reading the design depends on the official Figma MCP, which is quota-limited.
- `/compare` triages by pixel diff and judges by eye, only at fixed 1440/390, and can't run its own fix loop.
- `/plan` and `/execute` never see the exact design numbers.

3.6.0 replaces that path end to end and leaves the decision-making steps (`/clarify`, `/plan` approval) where they are:

```
Before: /figma → /clarify → /plan → /execute → /compare → /assess → /fix
After:  /figma-rest → /clarify → /plan → /execute → /figma-verify → /assess → /fix
```

| Area | Before | After |
|---|---|---|
| Figma access | Official MCP: 6 calls/month on Starter/View/Collab seats | REST API with a personal access token: per-minute rate limit, no monthly cap, results cached |
| Input | `Desktop: <url>` / `Mobile: <url>` only | Any paste: links, labelled or not, or the Dev Mode "Implement this design from Figma. @link" prompt, which a hook routes automatically |
| Design data | MCP code output for the frame | Per-section Dev Mode-style dumps plus machine-readable `.json` specs, interactions, behaviour signals, tokens |
| Plan and execute | Read `design-context.md` | Read the per-section specs: exact values per frame width, interactions, selectors, deviations from Figma |
| Verification | Dimensions + pixelmatch triage (5% threshold), then eyeball MATCH/MINOR/MISMATCH, at fixed 1440/390 | Measured match at the actual Figma frame widths, an 11-width sweep and interaction tests |
| Fix loop | Auto-invokes `/fix`, which can't run from there, so it stalls | One approval gate, then automatic fix and re-verify, max 5 rounds |
| Leftovers | Not tracked | Mandatory "Unfixed mismatches" list, 1–2 lines each |

`/figma`, `/compare` and every other skill still ship and still work. The new skills are additions. 3.5.0's `/grill-me` fits between `/plan` and `/execute` unchanged, and can question the plan's new Deviations from Figma section.

## 2. From `/figma` to `/figma-rest`

### 2.1 Why `/figma-rest` exists
`/figma` calls `mcp__figma__get_design_context` / `get_metadata` / `get_screenshot`. On Starter plans and View/Collab seats the official MCP allows **6 calls per month**, and one page uses that up. `/figma` already needed a personal access token (PAT) for its screenshot and asset scripts, so the REST API was already available. Only the design reading went through MCP.

### 2.2 figma-rest v1 (before this round)
A copy of `/figma` with the design reading swapped out:
- **Design data:** Framelink (`figma-developer-mcp`, a community MCP that runs on the same PAT) through `get_figma_data`.
- **Shared styles:** a new `save-figma-styles.js` that reads the file's published styles over REST.
- **Unchanged from `/figma`:** the screenshot, asset and upload scripts (byte-identical).

What developers saw: dk-toolkit "reads Figma better, including interactions". The cause was the data source:

| | Framelink (v1) | Dev Mode MCP (dk-toolkit) |
|---|---|---|
| Node tree | Simplified and pruned for LLMs | Full design context per node |
| Prototype interactions | Dropped | Included |
| Mixed-style text (`characterStyleOverrides`) | Lost | Included |
| Variables and theme values | Not resolved | Resolved |
| Sections | Direct children of the frame, by hand | By hand |

A pasted Dev Mode prompt isn't special in itself. It is just a link, and dk-toolkit got better results because of the MCP behind it.

### 2.3 figma-rest v2 (this round)
Everything is read from the raw REST `GET /v1/files/:key/nodes` JSON. It is a superset of what Framelink returns and includes prototype data. One call is made per frame and the response is cached under `raw/`, so re-runs are free.

**Input and routing**
- `parse-figma-input.js` accepts any paste: links, `Desktop:`/`Mobile:` labels, unlabelled links (the viewport comes from the frame width), and the Dev Mode prompt. It also normalises node ids, branch keys and duplicates.
- A **UserPromptSubmit hook** (`hooks/figma-link-hook.js`) spots Figma links in any prompt and routes them to `/figma-rest`, never to the official MCP. So pasting a link and pasting the Dev Mode prompt now behave the same.

**Section detection** (`extract-figma-sections.js`)
- skips helper layers (annotations, redlines, "guide"/"spec" frames) without dropping real sections such as "Size & Value Guide"
- unwraps stack wrappers and sorts sections in visual order
- groups side-by-side columns and infers sticky columns
- detects site chrome (header, footer, announcement) by name, or by a logo row under 200px

**Per-section output**
- `figma-dumps/{viewport}/NN-{name}.md`: a Dev Mode-style layer tree with:
  - `{ css }` per layer, text content, mixed-style runs
  - repeated-sibling compression that keeps a "selected" variant visible
  - Figma variables (`/* var */`) and matching theme settings from `settings_data.json` (`/* theme */`)
  - hidden layers and component variants
- **Prototype interactions** with resolved destinations (names, not raw ids) and timeouts in ms.
- **Behaviour signals:** carousel/slider, accordion, tabs, sticky, marquee, states, forms. They use word-boundary matching and geometry checks to avoid false positives (e.g. "performs" no longer means "form", and star ratings are no longer read as carousel dots).
- `NN-{name}.json` spec: the exact text runs with their effective style, image rectangles clipped to the frame, and section render vs visible bounds. `/figma-verify` measures against this.
- `{viewport}-tokens.md` (variables, colours, type scale, shared styles) and `{viewport}-index.json` (sections plus the frame width).

**Assets and screenshots**
- Screenshots per section (`--from-index`). Sections without their own background export as JPG on white, not black PNGs.
- The asset manifest is built per section and per viewport, and merges across runs.
- Shared styles are merged per file key.

**Artifacts are unchanged** (`.buildspace/artifacts/{feature}/`). `sections.json` gains `figmaNodes`, `dumps` and `behaviour` per section, and `design-context.md` points to each section's dump.

**Tested on three real files:**
- Store A homepage, from the Dev Mode prompt
- a sampling page (desktop and mobile frames, pasted as labelled links)
- a Store B page (desktop and mobile frames on separate nodes)

The findings from those runs became the fixes above: whole desktop treated as one section, helper layers included, a real section dropped, raw interaction ids, false behaviour signals, hidden selected states, and black transparent exports.

## 3. `/figma-verify` (new)
This runs on the local `shopify theme dev` server with the project's Playwright. It never starts the server and never uninstalls Playwright.

| Check | How |
|---|---|
| **Exact match at Figma widths** | The frame widths come from `{viewport}-index.json` (e.g. 402 / 1440), not fixed 1440/390. `capture.js` makes side-by-side images at 2x, cropping the Figma side to what the frame actually shows. `measure.js` matches text by content and compares font family, size, weight, line height, letter spacing, colour, case, decoration and position. It also compares section boxes and visible image rectangles. Tolerances: font ±0.5px, line height ±1px, position ±2px, colour ±3/255. |
| **Layout health** | `sweep.js` at 320, 375, 390, 414, 768, 820, 1024, 1280, 1440, 1920 and 2560: horizontal overflow, content outside the viewport, clipped text, broken images, console errors (Shopify platform noise filtered out). |
| **Behaviour** | `behaviour.js`, a JSON test format. Steps: click, hover, focus, press, fill, scroll, swipe, wait, snapshot. Checks: visible, hidden, count, attr, style, text, changed/unchanged, stuck, moving. Tests are written **only from evidence**: prototype data, behaviour signals, Figma geometry and `clarify.md`. |

**Flow**
- One `AskUserQuestion` gate, then an automatic loop: fix, log to `fix-log.md`, rebuild CSS if needed, re-verify the touched sections.
- It stops when:
  - everything passes
  - a round makes no progress
  - a regression appears (that change is reverted)
  - 5 rounds are reached
- The last round always runs the full sweep and all behaviour tests.

**Guardrails**
- **Edit scope:** only the files in `execution-log.md`, plus snippets rendered only by them.
- **Decision check before fixing:** every planned fix is checked against later decisions:
  - plan and execution-log deviations
  - `git log` on the responsible lines
  - other features' fix logs and QA batches

  Deliberate changes are reported, never reverted.
- **Unfixed mismatches:** every remaining difference is listed in 1–2 lines, with what differs, why it wasn't fixed and the user's options. It goes into the final message and `verify-report.md`. A run is never called resolved while the list has entries.
- **`check-only` mode** re-checks after `/fix` without editing.

**Evidence (Store A homepage, collection-banner scope, 1440 / 390):**
- **Round 1:** 3/8 sections pass. It found:
  - CTA letter-spacing 0.16px vs Figma 0.32px
  - CTA icon 16px vs 10/12px
  - desktop CTA inset 0 vs 120px
  - carousel label copy differs
- **Final:** all four banners pass at both widths, the sweep is clean at all 11 widths, and behaviour tests pass 4/4.
- **Unfixed:** the remaining items were listed as decisions, including a desktop-vs-mobile copy contradiction in Figma.
- **A review caught one misclassification:** a mobile-only QA fix had been treated as a desktop decision. This led to the "Unfixed mismatches" rule and the explicit Deviations from Figma section below.

## 4. Changes to existing skills

### `/plan`
- Reads `sections.json`, the per-section dumps and specs, tokens and the frame widths, the asset manifest and the project `CLAUDE.md`.
- File specs now include:
  - the Figma source
  - a **design values table per frame width**, with each value mapped to a token. Values with no token are put to the user to decide.
  - **interactions**, which become test cases
  - the section's `sections.json` name and **wrapper selector**, decided up front
  - content
- A new **Deviations from Figma** section lists every intentional difference with its reason. Figma contradictions go to the user instead of being picked silently.
- Class decisions follow the project's styling convention (e.g. Tailwind) instead of always using BEM.

### `/execute`
- Opens each section's dump, spec and screenshot before writing it, and uses Figma copy for the template JSON content.
- Flags Figma contradictions instead of choosing one, and rebuilds compiled CSS (e.g. `npm run build`) when new utility classes appear.
- `selectors.json` uses the planned names and selectors, plus `hooks` for interactive `data-*` elements.
- The execution log gains **Deviations from Figma** and **CSS build**.
- Hands off to `/figma-verify` when figma-rest artifacts exist, otherwise to `/compare`.

### `/compare`
- **Root cause of the stall:** it auto-invoked `/fix` through the Skill tool, from a forked context. But `/fix` is `disable-model-invocation: true` and stops for approval, so the call can't complete. It now hands off: run `/fix` with the report, then re-run `/compare`.
- Everything else in 3.5.0's compare (pixelmatch triage, 2x capture, `preview-url.txt`, the capture script owning Playwright) is kept. `/figma-verify` reuses the same `preview-url.txt`.

### `/assess`
- Still checks what a browser can't see: null and empty states, settings wiring, schema, requirements coverage, integration (3.5.0's `verify-integration.mjs`) and standards (both agents in parallel).
- **Project `CLAUDE.md` conventions override generic standards.** In a Tailwind project, code-reviewer flags a missing per-section stylesheet, BEM naming, toolkit breakpoints and `-javascript.js` names as violations. With this change, the code-reviewer prompt carries `CLAUDE.md`, and those conflicts are listed once as an observation, not reported as violations.
- A new **Design Fidelity** step copies the result and unfixed mismatches from `verify-report.md` / `comparison-report.md`. It doesn't re-judge visuals.
- After `/fix` changes markup, it suggests `/figma-verify check-only`.

### `/fix`
Suggests `/figma-verify check-only` when the feature has a verify report and the fix changed markup or classes.

### Hooks and README
- `hooks/hooks.json` keeps 3.5.0's gated linters and gains the Figma link hook (UserPromptSubmit, `${CLAUDE_PLUGIN_ROOT}` path).
- The README still tells users to *copy* `hooks.json` into the project's `.claude/settings.json`. Plugin hooks already load automatically when the plugin is enabled, so a copy runs every hook twice. Older copies are also stale: one project still has the removed per-file theme-check hook, reading `$CLAUDE_TOOL_INPUT`, which doesn't exist. The instruction now says not to copy.
- New prerequisites: `FIGMA_TOKEN`, and Playwright + Chromium.

## 5. Also added: `/preflight`
A stage → main release gate, plus the `preflight-verifier` agent. It is separate from the Figma work and documented in [preflight.md](preflight.md).

## 6. Not in this change
- **Learnings:** `/assess` writes `.claude/patterns-learned.md`, but no skill reads it back. The proposal is in [proposals/learnings.md](proposals/learnings.md).
- **Standards skills:** the generic rules (BEM, per-section stylesheets, breakpoints) are untouched. Projects override them through `CLAUDE.md`, and `/assess` respects that.
- **Not yet installed or tested as a plugin.** The skills were developed and run as user-level skills on a client theme. The plugin packaging changes (namespaced skill name in the hook, `${CLAUDE_PLUGIN_ROOT}` paths, the selector `hooks` field) still need one end-to-end run after install.

## 7. Migration
1. Add `FIGMA_TOKEN` to the project `.env`, and optionally `SHOPIFY_STORE` / `SHOPIFY_ADMIN_TOKEN` for asset upload.
2. Make sure Playwright is available: the project's `@playwright/test` or `playwright`, plus `npx playwright install chromium`.
3. Remove any toolkit hooks copied into the project's `.claude/settings.json`.
4. When merging, also bump `shopify-theme-toolkit` to 3.6.0 in the marketplace's `marketplace.json`.
5. Existing `/figma` features keep working with `/compare`. New features use `/figma-rest` → … → `/figma-verify`.

## 8. Summary
- Figma is read over REST with no MCP quota, and a pasted link and a Dev Mode prompt behave the same.
- Plan and execute build from exact per-section specs and record every intentional deviation from Figma.
- `/figma-verify` measures the build at the real Figma widths, sweeps 11 breakpoints, tests interactions, and fixes automatically after one approval.
- `/compare`'s stalled fix loop is fixed. `/assess` respects project conventions and reports design fidelity.
- Built on 3.5.0: its compare triage, integration script, parallel assess and `/grill-me` are kept as they are.
- Next: one end-to-end run as an installed plugin, then the learnings proposal.
