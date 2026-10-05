---
name: figma-rest
description: >
  Extract structured design context from Figma using only the Figma REST API
  (Personal Access Token) — no official Figma Dev Mode MCP quota. Use whenever
  the user pastes a Figma design link or the Dev Mode "Copy prompt" text
  ("Implement this design from Figma. @https://www.figma.com/design/..."),
  or asks to build/implement/extract a design from Figma. Produces Dev Mode-style
  per-section layer dumps (CSS-like props, text, variables, theme-token matches,
  variants, prototype interactions), inferred behaviour (sliders, accordions,
  swatches, inputs, states), screenshots, image assets and design tokens in
  .buildspace/artifacts/{feature}/.
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, mcp__figma-rest__get_figma_data, mcp__figma-rest__download_figma_images
---

# Figma REST — Design Context Extraction (quota-free)

You are entering the Figma phase. Extract structured design context from Figma frames using the Figma REST API, save it as artifacts, and hand off to the build. Do NOT write implementation code. Do NOT plan implementation.

**Never call the official Figma MCP tools** (`mcp__figma__*`, `mcp__figma-desktop__*`, `mcp__claude_ai_Figma__*`) — they are capped at 6 calls/month on Starter / View / Collab seats. Everything here runs on REST via the scripts in `${CLAUDE_SKILL_DIR}/scripts/`. See `references/why-rest.md`.

All raw API responses are cached under `.buildspace/artifacts/{feature}/raw/`; scripts reuse that cache, so re-runs cost no calls. Pass `--refresh` only when the design changed in Figma.

## Input
`$ARGUMENTS` — or, when invoked without arguments, the user's message that contained the Figma link(s).

Any of these forms is valid and must behave identically:
```
Implement this design from Figma.
@https://www.figma.com/design/<fileKey>/<name>?node-id=1-2&m=dev
```
```
https://www.figma.com/design/<fileKey>/<name>?node-id=1-2
```
```
Desktop: <figma-url>
Mobile: <figma-url>
```

---

## Step 1: Parse Input & Check Credentials

**MANDATORY FIRST ACTION** — run both:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/parse-figma-input.js "<the pasted text, verbatim>"
```

```bash
echo "=== Credential Check ==="
for v in FIGMA_TOKEN SHOPIFY_STORE SHOPIFY_ADMIN_TOKEN; do
  if [ -n "$(printenv "$v")" ]; then echo "$v: set (env)";
  elif [ -f .env ] && grep -q "^$v=" .env; then echo "$v: set (.env file)";
  else echo "$v: NOT FOUND"; fi
done
```

- No links found / a link without `node-id` → ask the user to select the frame in Figma and copy its link (or the Dev Mode prompt).
- `FIGMA_TOKEN` NOT FOUND → stop and tell the user:
  ```
  FIGMA_TOKEN is required.
  1. Go to: https://www.figma.com/developers/api#access-tokens
  2. Create a Personal Access Token with scopes: File content (Read), Dev resources (Read)
  3. Add it to your project's .env file: FIGMA_TOKEN="your-token-here"
  ```
- Missing Shopify credentials only disable the upload step (Step 7).

All scripts load `.env` themselves — never `source .env`.

The parser returns `desktop`, `mobile` and `unlabeled` links. Unlabeled links get their viewport from frame width in Step 3 (`--viewport auto`: < 600px → mobile).

---

## Step 2: Derive Feature Name

Derive a short kebab-case feature name from the user's intent or the frame name (e.g. `pdp`, `hero-banner`). Use `Glob('.buildspace/artifacts/*/design-context.md')`; if the name exists, confirm overwrite with the user.

```bash
mkdir -p .buildspace/artifacts/{feature}
echo "{feature}" > .buildspace/current-feature
```

---

## Step 3: Extract Section Dumps (one API call per frame)

For each link (desktop and/or mobile):

```bash
node ${CLAUDE_SKILL_DIR}/scripts/extract-figma-sections.js \
  --file-key "{fileKey}" --node-id "{nodeId}" --feature "{feature}" \
  --viewport auto
```

Options: `--viewport desktop|mobile` to force; `--mode page|section` to override auto-detection (page = the frame's children are the sections; section = the frame itself is one section); `--include-chrome` to keep header/footer.

It writes, per viewport:
- `figma-dumps/{viewport}/NN-{name}.md` — one per section: **Behaviour signals** + a Dev Mode-style **layer tree** (`{ css }` per layer, `»` text content, `run` mixed-style text, `⚡` prototype interactions, `↻` repeated siblings, `/* var … */` Figma variables, `/* theme … */` matching theme settings from `config/settings_data.json`, `(hidden: …)` hidden layers, component variants)
- `figma-dumps/{viewport}-tokens.md` — variables with resolved values and usage, colors, type scale, shared styles
- `figma-dumps/{viewport}-index.json` — section list (also printed)

### 3a: Only one link given

Find the other viewport's frame:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/find-figma-frames.js --file-key "{fileKey}" --node-id "{nodeId}" --feature "{feature}"
```
Present the top candidates with `AskUserQuestion` (include "No other viewport — proceed with one"). Never pick silently. If confirmed, run Step 3 for it.

### 3b: Read the output

Read the index(es), the tokens file(s) and **every section dump**. Section names from the extractor are suggestions — layers named "Frame 13" are named from their largest text. You will rename and group them in Step 5.

**Check the section split** in the index before moving on:
- `skippedHelpers` — pixel grids, device status/URL bars and oversized overlays are dropped automatically; make sure nothing real was skipped.
- `mode` — `page` (children are sections; generic wrappers like "Content" are unwrapped; sections are sorted by visual position) or `section`. If wrong, re-run with `--mode page|section` (free — cached).
- `pageSignals` / `columnGroups` — side-by-side columns (e.g. gallery + buy box) and a short column beside a tall one (likely sticky). Carry these into Step 6.

### 3c: Shared styles

Style **names and values** used in the frame already come from the nodes response: they appear as `/* style "…" */` in the dumps and in the tokens file's "Shared styles" table — use them as token names. Only run the styles script if you need the file's other published styles:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/save-figma-styles.js --file-key "{fileKey}" --feature "{feature}"
```

> **Variables:** names come only from the Variables API (Enterprise plans). Otherwise they appear as IDs (`var 17221:20484`) with resolved values — still useful: the same ID means the same token everywhere, so map each ID to one theme token / Tailwind class consistently.

> **Fallback:** if the extractor fails on a node (e.g. response too large), call `mcp__figma-rest__get_figma_data` with that `fileKey`/`nodeId` (narrow to a child node) and record that the section came from Framelink (no interactions, no variable IDs).

---

## Step 4: Screenshots (section by section)

```bash
node ${CLAUDE_SKILL_DIR}/scripts/save-figma-screenshots.js \
  --file-key "{fileKey}" --feature "{feature}" --scale 2 --from-index desktop
```
Repeat with `--from-index mobile` (and that frame's file key). Output: `screenshots/figma-{name}-{viewport}.png`, or `.jpg` for sections without their own background (flattened onto white so they don't render black). Batches of 3 avoid render timeouts. Never capture a full page.

Open every screenshot with `Read` and look at it next to its dump. If a node fails to export, retry once, then fall back to `mcp__figma-rest__download_figma_images`.

---

## Step 5: Define Sections & Write sections.json

Figma's top-level children are not always build sections. Using dumps + screenshots:
1. **Group** fragments that belong together (e.g. a 2px progress track directly under an image gallery belongs to that gallery; a "You May Also Like" title strip belongs with the product row below it).
2. **Rename** to meaningful kebab-case names (`product-gallery`, `size-selector`, `pdp-accordions`), not `frame-321`.
3. **Pair** desktop ↔ mobile by content (heading text, repeated structures, order) — not by Figma names or position alone.
4. Omit header/footer unless the user asked for them.

Write `.buildspace/artifacts/{feature}/sections.json` — the **single source of truth** for section names across the pipeline (`/plan`, `/execute`, `/compare`):

```json
[
  {
    "name": "size-selector",
    "figmaNodeId": "17429:86948",
    "figmaName": "Frame 48",
    "figmaNodes": { "desktop": ["17429:86200"], "mobile": ["17429:86948"] },
    "screenshots": {
      "desktop": "screenshots/figma-size-l-desktop.png",
      "mobile": "screenshots/figma-size-l-mobile.png"
    },
    "dumps": {
      "desktop": ["figma-dumps/desktop/05-size-l.md"],
      "mobile": ["figma-dumps/mobile/07-size-l.md"]
    },
    "behaviour": "Size buttons (single select). Selected = 1px #0F0F0F border + 500 weight; low-stock = 4px red dot. Static, no prototype interactions."
  }
]
```

- `name`, `figmaNodeId` (primary/desktop node), `figmaName`, `screenshots.desktop`, `screenshots.mobile` keep their existing meaning for downstream skills. Omit `mobile` keys when there is no mobile frame.
- `figmaNodes` / `dumps` list every Figma node grouped into the section.
- `behaviour` — one-line summary of Step 6.

---

## Step 6: Behaviour & Responsive Analysis (per section)

This is what makes the build read the design correctly. For each section combine:
- **Explicit** — `⚡` prototype interactions (click/hover/after-timeout → navigate/swap/change-to variant — destinations are resolved to variant names like `State=Hover` / `Property 1=Collapse`), scroll containers, sticky/fixed layers.
- **Page layout** — `pageSignals` from the index (side-by-side columns, likely-sticky column).
- **Inferred** — the dump's Behaviour signals (clipped horizontal overflow → slider; pagination dots / progress track → slider indicator; repeated rows with trailing icon → accordion; swatches; placeholder text → input; hidden layers → alternate states), variant names, layer names, and what the screenshot shows (arrows, active tab underline, open vs closed rows).
- **States visible in the design** — the signal "item X looks different from its N siblings → selected/active state", plus any sibling shown in full instead of `↻` (compression only happens when siblings look identical): selected / active / disabled / sold-out / low-stock.
- **Desktop vs mobile** — compare the two dumps: column counts, grid → horizontal scroll, stacked vs side-by-side, elements hidden on one viewport, font-size and spacing changes.

Label each conclusion **explicit** (prototype data) or **inferred** (with its evidence). If behaviour cannot be determined (e.g. auto-play vs manual, which accordion is open by default), list it under **Open questions** — never guess.

---

## Step 7: Image Assets

### 7a: Download

```bash
node ${CLAUDE_SKILL_DIR}/scripts/save-figma-assets.js \
  --file-key "{fileKey}" --feature "{feature}" --node-id "{top-level nodeId}" --viewport desktop
```
Repeat for mobile with its node (and file key) and `--viewport mobile`. The node tree comes from the Step 3 cache, names match the extractor's section names, and images already in the manifest (same `imageRef`) are skipped — both runs merge into `assets-manifest.json` automatically. Zero images is not an error.

Report how many images were downloaded, grouped by section. Rename asset `section` values to the final Step 5 names in the manifest if they changed.

### 7b: Upload to Shopify (optional)

Skip if Shopify credentials are missing (tell the user how to add them — Settings > Apps and sales channels > Develop apps, scopes `write_files` + `read_files`, then `SHOPIFY_STORE` / `SHOPIFY_ADMIN_TOKEN` in `.env`) or the manifest is empty.

Otherwise show each asset (name, section, path, thumbnail via `Read`) and ask:
```
These [N] image assets will be uploaded to your Shopify store's Files (Settings > Files).
Confirm to proceed, or let me know if you'd like to exclude any.
```
- Excluded assets → remove them from `assets-manifest.json` first. Declined → skip to Step 8.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/upload-shopify-assets.js --feature "{feature}"
```
The script skips entries that already have `shopifyUrl`, uploads via staged uploads → `fileCreate`, polls until READY, and **updates `assets-manifest.json` in place** with `shopifyUrl`, `shopifyFileId` and `shopifyRef` (`shopify://shop_images/…`, for template JSON `image` values). Report successes, failures, and any still-processing `shopifyFileId`s.

---

## Step 8: Write design-context.md

`.buildspace/artifacts/{feature}/design-context.md` is the overview. **The section dumps + screenshots are the source of truth** — say so at the top, and link them for every section so the build step reads them, not just these tables.

```markdown
# Design Context: {feature}

> Source of truth for implementation: each section's dump(s) in `figma-dumps/` + screenshots.
> This file summarises them; when in doubt, read the dump.

## Source
- Desktop: {url} ({rootName}, {size})
- Mobile: {url or "None"}
- Extracted: {timestamp} · Method: Figma REST (raw nodes) · Variables: {names | IDs only}

## Design Tokens
| Figma token (var ID / style) | Value | Used as | Theme setting / Tailwind |
|---|---|---|---|

## Type Scale
| Role | Font | Size / Line height | Weight | Letter spacing | Case |
|---|---|---|---|---|---|

## Sections

### {name}
- Figma: {figmaName} ({node ids}) · Dumps: `figma-dumps/...` · Screenshots: `screenshots/...`

**Behaviour:**
- {explicit/inferred conclusion} — evidence: {signal / prototype / screenshot}

**States:** {selected/active/hover/disabled… as drawn, or "none"}

**Responsive (desktop → mobile):**
- {layout / visibility / size changes}

**Layout:** direction, alignment, gap, padding, max width, sizing (fill/hug/fixed)

**Typography:**
| Element | Font | Size | Weight | Line Height | Color |

**Colors:**
| Role | Value | Token |

**Spacing:**
| Property | Desktop | Mobile |

**Elements:**
{hierarchy with key visual properties and text content}

**Open questions:**
- {anything not determinable from the design}

## Image Assets
| Asset | Section | File | Shopify URL |
```

Fill everything from the dumps, tokens files and `figma-styles.json`. Never leave placeholders; omit rows whose values are not in the data. Omit Image Assets if the manifest is empty.

---

## Step 9: Present & Hand Off

Show the user:
1. Sections found (with final names) and how desktop/mobile were paired
2. Each section screenshot
3. Behaviour per section (explicit vs inferred) and the open questions
4. Key tokens (colors, fonts) and their theme-token matches
5. Image assets downloaded / uploaded

Then:
```
Design context extracted and saved.
- .buildspace/artifacts/{feature}/design-context.md — overview, behaviour, responsive notes
- .buildspace/artifacts/{feature}/sections.json — canonical sections (+ dumps, behaviour)
- .buildspace/artifacts/{feature}/figma-dumps/ — Dev Mode-style per-section layer dumps (source of truth)
- .buildspace/artifacts/{feature}/screenshots/ — section screenshots
- .buildspace/artifacts/{feature}/assets-manifest.json — image assets (+ Shopify CDN refs)
- .buildspace/artifacts/{feature}/raw/ — cached API responses (re-runs are free)
```

### Next Step
```
→ Run /clarify to define requirements for this feature (answers the open questions above).
  Remaining: /clarify → /plan → /execute → /compare → /assess
```
Whoever builds a section must open that section's dump(s) and screenshots from `sections.json` — not only `design-context.md`.

**Context tip:** You can `/clear` before the next step — all data is in artifacts.

---

## Rules
- Never write implementation code — this skill only extracts design context.
- Never use the official Figma MCP tools; Framelink (`mcp__figma-rest__*`) only as a per-node fallback.
- Never guess design values — only record what the REST data, dumps or screenshots show. Behaviour that is inferred must be labelled inferred with its evidence.
- Reuse the raw cache; use `--refresh` only when the user says the design changed.
- If Figma returns 403/429 errors that mention plan limits, explain that Figma limits REST calls per seat/plan of the file's team and suggest checking the seat type — the scripts already back off and retry on 429.
- Overwrite existing artifacts when re-running for the same feature (after confirming in Step 2).
