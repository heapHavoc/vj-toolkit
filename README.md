# Shopify Theme Toolkit

A Claude Code plugin for orchestrated Shopify theme development. Supports feature development, bug fixing, assessment, and code understanding through an artifact-based workflow. Version 3.0.0.

**Author:** Aditya Pasikanti

## Installation

### Step 1: Add the Marketplace

Inside Claude Code, run:

```
/plugin marketplace add shopify-claude-devx/shopify-standards-marketplace
```

### Step 2: Install the Plugin

```
/plugin install shopify-theme-toolkit@shopify-standards
```

### Step 3: Verify

Restart Claude Code and type `/shopify-theme-toolkit:clarify` — if it responds, the plugin is working.

## Workflow

### Project Pipeline (Outer Loop)

```
/brainstorm → docs/roadmap-{track}/ → one PRD at a time → the feature pipeline below
```

`/brainstorm` turns a TDD into a track: a `docs/roadmap-{track}/` folder of phases, self-contained PRDs, a README with the execution order, and a `status-log.md` with every PRD at `Not Started`. Each PRD then goes through the feature pipeline on its own.

One TDD, one track. A project with a global standards doc and per-page sprint docs gets one run of `/brainstorm` per document.

### Full Pipeline (Feature Development)

```
/clickup → /figma → /clarify → /plan → /execute → /compare → /assess → /fix (if needed)
```

Start with `/clickup` when work originates from a ClickUp task (it ingests the task and routes to /clarify or /fix). Start with `/figma` when building from a Figma design. Skip both if working from text requirements only.

Run `/grill-me` between `/plan` and `/execute` when the plan looks thin or hides assumptions. It interviews you one decision at a time, dependencies first, and writes the resolved decisions back into the plan.

### Standalone Commands

```
/brainstorm  — Decompose a TDD into a roadmap of phases and PRDs (outer loop)
/clickup     : Ingest a ClickUp task (title, description, mockups, comments, subtasks) OR act on one (add comment, change status, log time) via MCP
/figma       — Extract design context from Figma (via MCP)
/grill-me    : Interrogate a plan, PRD, or spec branch by branch until shared understanding
/fix         — Bug fixing with first-principles Root Cause Analysis
/assess      — First-principles verification against requirements and standards
/compare     — Visual comparison of code vs Figma screenshots
/research    — Shopify topic research
/understand  — Deep code explanation
```

### Use Cases

| Use Case | Entry Point | Flow |
|----------|-------------|------|
| Project / page from a TDD | `/brainstorm` | /brainstorm → then the feature pipeline per PRD |
| ClickUp → Feature | `/clickup` | /clickup → /clarify → /plan → /execute → /assess |
| ClickUp → Bug | `/clickup` | /clickup → /fix → /assess |
| Figma → Feature | `/figma` | /figma → /clarify → /plan → /execute → /compare → /assess → /fix |
| Feature Development | `/clarify` | /clarify → /plan → /execute → /assess → /fix |
| Pressure-test a plan | `/grill-me` | after /plan, before /execute |
| Bug Fixing | `/fix` | standalone with first-principles RCA |
| Assessment | `/assess` | standalone or after /execute |
| Visual Comparison | `/compare` | after /execute when Figma screenshots exist |
| Research | `/research` | standalone web search |
| Understand Code | `/understand` | standalone deep trace |

## Skills

### Workflow Skills (user-invoked)

| Skill | Purpose | Input Artifact | Output Artifact |
|-------|---------|----------------|-----------------|
| `/brainstorm` | Decompose a TDD into phases and self-contained PRDs | TDD / project brief | `docs/roadmap-{track}/` — PRDs, `README.md`, `status-log.md` |
| `/clickup` | Ingest a ClickUp task (route to /clarify or /fix), or act on one (comment, status, time) via MCP | ClickUp task ID / URL, or an instruction | `clickup-context.md` + `clickup-images/` (ingest), or a ClickUp write (action) |
| `/figma` | Extract design context from Figma via MCP | Figma URL(s) | `design-context.md` + screenshots |
| `/clarify` | Define requirements, research, challenge user | User request | `clarify.md` |
| `/plan` | Technical specification with per-file decisions | `clarify.md` | `plan.md` |
| `/grill-me` | Interrogate a plan decision by decision, dependencies first, until shared understanding | `plan.md` / `clarify.md` / a roadmap PRD | `grill-log.md` + amendments to the target |
| `/execute` | Build all files in-context with full visibility | `plan.md` | code files + `execution-log.md` |
| `/compare` | Visual comparison of code vs Figma screenshots | `selectors.json` + Figma screenshots | `comparison-report.md` |
| `/assess` | First-principles verification (requirements + standards + integration) | `execution-log.md` + `clarify.md` | `assessment-report.md` |
| `/fix` | First-principles RCA + fix all instances (waits for approval) | `assessment-report.md` or bug report | `fix-log.md` |
| `/understand` | Deep code explanation | file/section/feature name | conversation output |
| `/research` | Shopify topic research | topic query | conversation output |

### Standard Skills (auto-triggered by Claude)

| Skill | Triggers On |
|-------|------------|
| `liquid-standards` | Any `.liquid` file |
| `section-standards` | Section `.liquid` files and `{% schema %}` blocks |
| `css-standards` | Any `.css` file |
| `js-standards` | Any `.js` file |
| `theme-architecture` | File creation and organization |

## Agents

| Agent | Dispatched By | Model | Role |
|-------|--------------|-------|------|
| `codebase-analyzer` | `/plan` | sonnet | Discovers naming conventions, reusable code, potential conflicts |
| `output-validator` | `/assess` | sonnet | Validates requirements coverage, edge cases, integration |
| `code-reviewer` | `/assess` | sonnet | Reviews code quality against skill checklists |

**Direct build pattern:** `/execute` builds all files directly in the main context with full visibility across files. No agent dispatch during execution — standards are loaded via the Skill tool before each file type.

**Agent-assisted assessment:** `/assess` dispatches `output-validator` and `code-reviewer` **in a single message so they run concurrently** — they are independent and neither reads the other's output. Verbose agent output stays in forked contexts. `code-reviewer` loads only the standards skills for the file types present, rather than all five.

**Deterministic checks:** integration is verified by a script, not by greps scattered across skills and agents.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/assess/scripts/verify-integration.mjs --feature {name}
```

It reads the file list from `execution-log.md` and confirms every section is reachable from a template, every snippet is rendered, every CSS and JS asset is loaded, and every `asset_url` reference resolves. Exits non-zero and names the failure in JSON. `/execute` runs it as a build smoke test with `--files`, `/assess` runs it in Step 1. Nothing else should hand-grep these.

**Numeric visual comparison:** `/compare` captures at 2x to match Figma's export scale, reloads the page per viewport, then compares each section in two tiers — dimensions first, then a `pixelmatch` diff. Verdicts land in `capture-manifest.json`, and the model reads image pairs only for sections marked `REVIEW`. The diff threshold defaults to 5% and needs calibrating per project with `--diff-threshold`.

## Artifact Structure

```
.buildspace/
  artifacts/
    {feature-name}/
      clickup-context.md     <- /clickup output (task title, description, comments, subtasks)
      clickup-images/        <- /clickup output (downloaded mockups from the task)
      design-context.md      <- /figma output (structured design specs)
      clarify.md             <- /clarify output
      plan.md                <- /plan output
      grill-log.md           <- /grill-me output (resolved decisions, open questions)
      execution-log.md       <- /execute output
      selectors.json         <- /execute output (section->CSS selector map)
      sections.json          <- /figma output (canonical section names + node IDs)
      assets-manifest.json   <- /figma output (downloaded images + shopify:// refs)
      preview-url.txt        <- /compare output (reused on later runs)
      screenshots/           <- /figma + /compare output
        figma-{section}-desktop.png
        figma-{section}-mobile.png
        code-{section}-desktop.png
        code-{section}-mobile.png
        diff-{section}-{viewport}.png   <- /compare, only when a section is flagged
        capture-manifest.json           <- /compare verdicts per section
      comparison-report.md   <- /compare output
      assessment-report.md   <- /assess output
      fix-log.md             <- /fix output
```

Add `.buildspace/` to your project's `.gitignore` — artifacts are working files, not source code.

## Context & Cost Efficiency

This plugin is designed to minimize token usage and API costs:

### Token Optimization
- **Direct build in /execute.** No agent dispatch overhead. Standards loaded once per file type via Skill tool, not per-agent.
- **Single assessment pass.** /assess replaces separate /test + /code-review — one command, one report, no duplicate file reads.
- **Agent-assisted assessment.** output-validator and code-reviewer run in forked contexts. Verbose output stays localized.
- **Externalized artifact templates.** Markdown output templates live in `skills/{name}/templates/` and are loaded via Read on demand.
- **Artifacts replace conversation.** Each stage reads a small, structured artifact file. You can `/clear` between stages.

### Cost Optimization
- **Context fork on /assess, /research.** Verbose agent output and WebFetch results stay in forked context. Only summaries return.
- **disable-model-invocation on workflow skills.** Skill descriptions not loaded for auto-trigger, saving context budget.
- **allowed-tools restriction.** Each skill has only the tools it needs, preventing off-track tool calls.
- **Session boundary guidance.** Each pipeline stage reminds users they can `/clear` between stages since artifacts are the handoff mechanism.

### Standards Authority
- **Plugin standards are the authority** for code patterns, structure, and architecture.
- **Codebase analyzer informs naming only** — file names, setting ID prefixes, CSS class prefixes. Never overrides standards.
- **New code follows standards** even if the existing codebase doesn't. Bad patterns are not replicated.

## Skills & Enforcement

Plugin skill descriptions are loaded into Claude's context, and Claude auto-invokes skills it deems relevant. To guarantee skills are invoked every time, add the following to your project's `CLAUDE.md`:

```markdown
## Project Standards — MANDATORY

Coding standards are provided as **plugin skills** from the `shopify-theme-toolkit` plugin.
They must be invoked using the **Skill tool** before writing any code.

**Before writing or modifying any file, invoke the relevant skill(s):**
- **`.liquid` files** -> invoke `shopify-theme-toolkit:liquid-standards`
- **`.js` files** -> invoke `shopify-theme-toolkit:js-standards`
- **CSS / styling** -> invoke `shopify-theme-toolkit:css-standards`
- **Section files** -> invoke `shopify-theme-toolkit:section-standards`
- **New files / architecture decisions** -> invoke `shopify-theme-toolkit:theme-architecture`

Do not skip this step. The plugin skills have detailed rules and checklists that must be followed.
```

## Hooks

Copy `hooks/hooks.json` into your theme project's `.claude/settings.json` to enable the optional PostToolUse linters. Both are gated on the tool being installed locally, so they no-op silently in projects that don't use them:

| File type | Runs | Requires |
|---|---|---|
| `.css` | `stylelint` | `stylelint` in the project's `node_modules` |
| `.js` | `eslint` | `eslint` in the project's `node_modules` |

**There is no per-file theme check hook.** The Shopify CLI's `theme check` accepts only `--path`, and passing a single file crashes it, so per-file checking is not possible. A whole-theme run takes about 3 seconds, and `/execute` runs one at the end of the build while `/assess` runs one as the verification gate. That covers it without a check on every edit.

Requires Shopify CLI installed (`npm install -g @shopify/cli`) for `/execute` and `/assess`.

## Prerequisites

| What | Required? | Install |
|---|---|---|
| Claude Code | Yes | `npm install -g @anthropic-ai/claude-code` |
| ClickUp MCP Server | For /clickup skill | Connect ClickUp via your Claude integrations / `claude mcp add` |
| Figma MCP Server | For /figma skill | `claude mcp add --transport http figma https://mcp.figma.com/mcp` |
| Figma Pro+ plan | For /figma skill | Free plan = 6 calls/month; Pro = 200/day |
| Shopify CLI | For theme check hook | `npm install -g @shopify/cli` |
| Node.js 18+ | For screenshot capture | nodejs.org |
