---
name: plan
description: >
  Create a detailed technical specification for a feature. Produces per-file
  decisions (settings, classes, tokens, structure) so /execute has zero
  creative decisions. Use after /clarify when requirements are confirmed.
disable-model-invocation: true
allowed-tools: Read, Write, Grep, Glob, Agent, AskUserQuestion
---

# Plan — Technical Specification

You are entering the Plan phase. Your job is to produce a specification so detailed that `/execute` is pure implementation — zero decisions, zero guessing.

**Plan produces DECISIONS, not CODE.** The plan specifies what settings, what classes, what tokens, what structure. /execute writes the actual code using those decisions + skill standards.

**Do NOT write implementation code. Pseudocode or brief snippets ONLY when referencing existing codebase patterns that must be followed.**

## Input
Context or overrides: `$ARGUMENTS`

## Artifact Resolution
1. Read `.buildspace/current-feature` for the active feature name
2. If the file doesn't exist, look in `.buildspace/artifacts/` for feature folders containing `clarify.md`
3. If one folder exists → use it
4. If multiple folders exist → ask the user which feature to plan
5. If no clarify.md found → ask the user to run `/clarify` first

Read from `.buildspace/artifacts/{feature-name}/`:
- `clarify.md` — the requirements (REQUIRED)
- `design-tokens.json` — available design tokens (if exists)
- `design-context.md` — design specs: typography, colors, spacing, layout (if exists)

---

## Process

### Step 1: Read All Inputs
Read the requirements and all available artifacts. Understand the full picture before analyzing the codebase.

### Step 2: Analyze the Codebase
Use `Glob` and `Grep` for quick context:
- `Glob('sections/*.liquid')` — existing sections
- `Glob('snippets/*.liquid')` — reusable snippets
- `Glob('assets/*.css')` + `Glob('assets/*.js')` — asset files
- `Glob('templates/*.json')` — templates
Then dispatch the **codebase-analyzer** agent:

> Analyze this Shopify theme codebase to inform planning for: [one-line task description from requirements]
>
> Read `.buildspace/artifacts/{feature-name}/clarify.md` for requirements.
> If `.buildspace/artifacts/{feature-name}/design-context.md` exists, read it for design context.
>
> Focus on:
> - Naming conventions (file names, setting IDs, CSS class prefixes)
> - Existing snippets and utilities to REUSE
> - Potential naming conflicts to AVOID
> - File locations and organization
>
> Do NOT recommend code patterns, CSS architecture, or schema structures —
> plugin standards are the authority for those. Report what EXISTS for naming
> and conflict detection only.

The agent discovers naming conventions, reusable code, and potential conflicts. Plugin standards (loaded via Skill tool during /execute) are the authority for code patterns, structure, and architecture. Use the agent's findings for naming and reuse decisions only.

### Step 3: Research (if needed)
If the requirements involve Shopify features you're not confident about after reading the codebase analysis:
- Dispatch a research subagent to search shopify.dev
- Only for genuine knowledge gaps
- Skip if the codebase analysis + requirements provide enough context

### Step 4: Design the Solution
Using the requirements + codebase analysis, make every decision:

**For each file to create/modify, decide:**

1. **File path** — following codebase naming conventions discovered by agent
2. **Schema settings** — exact IDs, types, labels, groups (following section-standards skill rules, with ID prefixes from codebase conventions)
3. **CSS classes** — exact BEM class names (following css-standards skill rules, with naming prefix from codebase conventions)
4. **Block types** — if section has repeatable content, exact block type names and their settings
5. **Null checks** — which settings need blank/empty guards
6. **Design values** — exact colors, font sizes, spacing, and layout from design-context.md
7. **CSS loading strategy** — preload (above fold) or lazy load (below fold)
8. **JS approach** — none, DOMContentLoaded, or Web Component (and why)
9. **Existing code to reuse** — snippets, patterns, utilities found by agent

**When the plan references an existing codebase pattern:** Include a brief note like "Follow wrapper pattern from testimonials.liquid — uses `data-section-id` attribute." This is pointing to a reference, not writing code.

### Step 5: Write the Specification

Write the plan to `.buildspace/artifacts/{feature-name}/plan.md`.

Read the template structure from `${CLAUDE_SKILL_DIR}/templates/plan-template.md` and fill it in with the feature's specification. Every file must have a complete File Spec — no file is just a "TODO" without details.

### Step 6: Present and Confirm
Save the plan to the artifact file. Then tell the user:
- Where the plan was saved
- A 2-3 line summary of the approach

Use `AskUserQuestion` to confirm:
- **Approve plan** — proceed to /execute
- **Request changes** — user provides feedback to revise the plan

**Do NOT output the full plan in conversation. The artifact file is the source of truth.**

### Next Step
Once the user confirms the plan, tell them:
```
→ Run /execute to implement the plan.
  Remaining: /execute → /compare (if built from Figma) → /assess
```

**Context tip:** If your conversation is getting long, you can `/clear` before running `/execute` — it reads from artifacts, not conversation history.

---

## Rules
- Zero creative decisions for /execute — if /execute has to decide, the plan failed
- Reference design-context.md for exact design values — never guess colors, sizes, or spacing when the design context specifies them
- Standards skills are the AUTHORITY for how code should be written — always follow them
- Codebase analyzer informs naming conventions (file names, setting ID prefixes, CSS class prefixes) and identifies reusable code — but never overrides standards for code patterns, structure, or architecture
- If the existing codebase violates standards, the new code STILL follows standards — do not replicate bad patterns
- If the task is too large (>8 files), suggest breaking into smaller plans
- Test cases must be specific and verifiable — "works correctly" is not a test case
