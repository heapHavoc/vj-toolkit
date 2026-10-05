---
name: execute
description: >
  Execute a plan by building all files in-context. Reads the plan,
  loads relevant standards, and builds everything with full visibility
  across files. Use after /plan when the specification is confirmed.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Skill, TaskCreate, TaskUpdate, TaskList
---

# Execute — Build the Feature

You are the builder. Your job is to read the plan and build every file yourself, in order, with full context of what you've already created. You build directly — no agent dispatch, no isolated contexts.

## Input
Context or overrides: `$ARGUMENTS`

## Artifact Resolution
1. Read `.buildspace/current-feature` for the active feature name
2. If the file doesn't exist, look in `.buildspace/artifacts/` for feature folders containing `plan.md`
3. If one folder exists → use it
4. If multiple folders exist → ask the user which feature to build
5. If no plan.md found → ask the user to run `/plan` first

Read `.buildspace/artifacts/{feature-name}/plan.md` as your primary input.

Also read if they exist in the same folder:
- `design-context.md` — for design specifications (typography, colors, spacing, layout)
- `sections.json` — canonical section names from `/figma` (used to align selectors.json naming for `/compare`)
- `assets-manifest.json` — image assets downloaded from Figma (used to reference real images instead of placeholders)

---

## Build Process

### Step 1: Parse the Plan
Read `plan.md` and extract:
- The list of TODOs in order
- The File Spec for each TODO
- Any context from the Codebase Context section
- Dependencies between TODOs

### Step 2: Create Tasks for Progress Tracking

Use `TaskCreate` to create one task per TODO from the plan. This gives the user real-time visibility into build progress.

For each TODO:
```
TaskCreate({ subject: "TODO 1: Create sections/hero-banner.liquid", description: "..." })
```

### Step 3: Load Standards

Before building the first file of each type, load the relevant standard skill's checklist using the `Skill` tool. Skills stay loaded for the session — load each type **once**, not per TODO.

| File Type | Load These Skills |
|---|---|
| `.liquid` file | `Skill('liquid-standards')` |
| Section `.liquid` file | `Skill('section-standards')` + `Skill('liquid-standards')` |
| `.css` file | `Skill('css-standards')` |
| `.js` file | `Skill('js-standards')` |
| Template `.json` file | `Skill('theme-architecture')` |

Load the skill BEFORE building the first file of that type — understand the rules first, then write code.

### Step 4: Build TODO by TODO

For each TODO in order:

1. **Mark task as in_progress** — `TaskUpdate({ taskId: "...", status: "in_progress" })`
2. **Read existing files** that will be modified — understand what's there before changing it
3. **Build the file** following:
   - **The File Spec** for WHAT to build (settings, classes, tokens, structure)
   - **The loaded skill rules** for HOW to write it (syntax, patterns, conventions)
   - The File Spec contains all decisions — do not improvise or add features not specified
4. **Validate against checklist** — after building each file, check every item in the relevant skill checklist. Fix violations before moving on.
5. **Mark task as completed** — `TaskUpdate({ taskId: "...", status: "completed" })`
6. **Record what you built** — keep a running list of files created/modified, wrapper selectors, and any deviations from the plan.

**You build in the main context.** This means:
- You can see every file you've already created
- You can reference actual patterns and structures from files you just wrote
- CSS classes, schema IDs, and snippet interfaces will be consistent across files
- If you realize the plan needs adjustment mid-build, note the deviation

**Image assets in template JSONs:**
If `assets-manifest.json` exists, use it when building **template `.json` files**. When the template JSON references a section that has matching assets in the manifest (matched by `section` field), use the **`shopifyRef`** field as the image value in section settings. This uses Shopify's internal reference format: `shopify://shop_images/{filename}`. For example:
```json
"image": "shopify://shop_images/hero-image-1.jpg"
```
If `shopifyRef` is not present for an asset, fall back to the local file path from `figmaAssets/`.

### Step 5: Post-Build Validation

After all TODOs are complete:

1. **Run `shopify theme check`** if available:
   ```bash
   shopify theme check --path . --fail-level error
   ```
   Fix any errors before proceeding.

2. **Validate schema JSON** for any section with a `{% schema %}` block — confirm JSON is well-formed.

3. **Verify integration** — run the checker with the files you built, comma-separated:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/skills/assess/scripts/verify-integration.mjs \
     --files "sections/hero.liquid,snippets/hero-card.liquid,assets/hero.js"
   ```

   It confirms every new section is reachable from a template, every snippet is rendered somewhere, every CSS and JS asset is loaded by some Liquid file, and every `asset_url` reference resolves on disk. It exits non-zero when something is wrong and prints JSON naming it.

   Fix anything it reports before moving on. Do NOT hand-grep for these — this script is the single owner of that check, and `/assess` runs the same one.

### Step 6: Write Execution Log

Write the execution log to `.buildspace/artifacts/{feature-name}/execution-log.md`.

Read the template from `${CLAUDE_SKILL_DIR}/templates/execution-log-template.md` and fill it in with the build results.

### Step 7: Write selectors.json

Collect all wrapper selectors for section `.liquid` files you built. The wrapper selector is the CSS class on the outermost `<div>` or `<section>` element that wraps the entire section's content.

Write a JSON array to `.buildspace/artifacts/{feature-name}/selectors.json`:

```json
[
  { "name": "banner", "selector": ".loyalty-banner" },
  { "name": "tiers", "selector": ".loyalty-tiers" }
]
```

**Critical — name alignment for `/compare`:**
- If `sections.json` exists (from `/figma`), the `name` field in selectors.json **MUST match** the `name` field in sections.json for each corresponding section. This is how `/compare` pairs Figma screenshots (`figma-{name}-desktop.png`) with code screenshots (`code-{name}-desktop.png`).
- If `sections.json` does not exist, derive `name` from the section filename (kebab-case, without path or extension).

If no section files were built (e.g., only CSS/JS modifications), skip this step.

### Step 8: Report to User

Tell the user:
- Where the execution log was saved
- Count of files created/modified
- Whether theme check and schema validation passed
- Any deviations from the plan and why
- If `selectors.json` was written, mention it

**Do NOT output file contents in conversation. The code files and execution log are the source of truth.**

### Next Step
Check if Figma screenshots exist (`.buildspace/artifacts/{feature}/screenshots/figma-*.png`).

If **Figma screenshots exist**, tell the user:
```
→ Run /compare for visual comparison against the Figma design.
  Remaining: /compare → /assess
```

If **no Figma screenshots**, tell the user:
```
→ Run /assess for verification.
  Pipeline: /assess
```

**Context tip:** If your conversation is getting long, you can `/clear` before the next step — it reads from artifacts, not conversation history.

---

## Rules
- You build directly — do NOT dispatch builder agents
- Follow the plan's TODO order — you have full visibility of everything you've already built
- Load the relevant skill BEFORE building each file type — understand the rules first
- If the plan is ambiguous about something, make the best decision and note it as a deviation
- Never skip a TODO — every TODO gets built
- Every file must pass its relevant checklist before you move on
- Run `shopify theme check` ONCE at the end, not per file
- If theme check errors exist after building, fix them before reporting
