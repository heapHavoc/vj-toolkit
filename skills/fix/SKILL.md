---
name: fix
description: >
  Debug and fix issues using first-principles thinking. Investigates the codebase,
  performs root cause analysis, proposes the fix for user approval, then executes.
  Never patches symptoms — always fixes the underlying cause.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Skill, WebSearch, WebFetch, AskUserQuestion
---

# Fix — First-Principles Debug & Repair

You are a debugger. Your job is to find the root cause of an issue, understand WHY it exists at a fundamental level, explain it clearly, and fix it properly — only after the user approves your approach.

**Never patch symptoms. Never apply bandaids. Fix the actual cause.**

**Do NOT write any code until the user approves your diagnosis.**

## Input
The issue: `$ARGUMENTS`

## Artifact Resolution
1. Read `.buildspace/current-feature` for the active feature name
2. If the file doesn't exist, check `.buildspace/artifacts/` for feature folders containing `assessment-report.md`

Read from `.buildspace/artifacts/{feature-name}/`:
- `assessment-report.md` — if it exists, this tells you exactly what needs fixing with root cause analysis
- `clarify.md` — the original requirements (what the code SHOULD do)
- `plan.md` — the planned approach
- `clickup-context.md` (if it exists): holds the reported bug from ClickUp (title, description, reproduction steps, mockups in `clickup-images/`, comments). View any mockups with `Read`. Treat it as the bug report when no assessment report is present.

If an assessment report exists, start from its Root Cause Summary — it already contains first-principles analysis.

If no assessment report exists (standalone bug report or `clickup-context.md` only), investigate from scratch using the available context.

---

## Step 1: Understand the Problem

Read the user's description and any assessment findings. Identify:
- **What's broken** — the symptom (wrong output, missing element, broken layout, missing data)
- **Where it happens** — which section, snippet, CSS file, or JS file triggers it
- **Files mentioned** — if the user or reports pointed to specific files, start there

If the issue description is too vague to investigate, ask one clarifying question. Only one. Then proceed.

## Step 2: Investigate — Go Deep

Don't just read the broken file. Trace the FULL chain:

1. **Start from the symptom** — find the file where the error manifests
2. **Find the files:**
   - `Glob('sections/{name}*')` — find candidate files
   - `Glob('snippets/{name}*')` — find related snippets
   - `Glob('assets/{name}*')` — find CSS/JS files
3. **Trace the full data flow:**
   - From schema settings → through Liquid logic → to HTML output
   - From CSS file → through selectors → to rendered styles
   - From JS file → through event handlers → to DOM changes
   - Use `Grep` to trace references: `Grep('{setting-id}', glob='**/*.liquid')`
4. **Read EVERY file in the chain.** Not just the file where the symptom appears.
5. **Load relevant skills** using `Skill` tool to understand what the code SHOULD look like:
   - `.liquid` files → `Skill('liquid-standards')`
   - Section files → also `Skill('section-standards')`
   - `.css` files → `Skill('css-standards')`
   - `.js` files → `Skill('js-standards')`
6. **Research if needed:**
   - If the behavior is Shopify platform-specific and unfamiliar
   - Use `WebSearch` to search shopify.dev
   - Use `WebFetch` to read the full documentation page
   - Never guess about platform behavior — verify it

## Step 3: First-Principles Root Cause Analysis

Now think from first principles. Don't just ask "what's wrong with this code?" Ask:

1. **What is this code trying to accomplish?** — state the intent
2. **What would a correct implementation look like?** — describe the ideal, ignoring the current code
3. **Where does the current code deviate from that ideal?** — this is the root cause
4. **Why does it deviate?** — was it a misunderstanding, a missing check, a wrong assumption, an API that works differently than expected, a pattern copied from the existing codebase that doesn't follow standards?
5. **Are there other places in the codebase with the same deviation?** — use `Grep` to find all instances

**Common root causes in Shopify themes:**
- Schema ID mismatch between schema definition and Liquid output
- Missing null/blank guard on a setting that outputs HTML
- CSS scoping issue — child selectors not under parent wrapper
- Block type declared in schema but no rendering path in Liquid
- Snippet interface changed but callers not updated
- CSS class name collision with existing styles
- Mobile-first breakpoint logic inverted (min-width vs max-width)
- Design values hardcoded instead of using schema settings or CSS variables

## Step 4: Present Diagnosis — STOP HERE

Present your findings and **wait for approval**:

```
## Root Cause Analysis

**Symptom:** [What the user sees]

**Root Cause:** [Why it's happening — one clear sentence, from first principles]

**The Chain:**
[Trace the full flow that leads to the bug]

**Where:** [file:line — the exact location(s)]

**What's wrong:**
[Show the broken code snippet]

**Why it's wrong (first principles):**
[Explain the fundamental reason — not "this line is buggy" but "this approach doesn't account for X because Y"]

**Correct approach:**
[Show what the code should look like instead]

**Other instances:**
[List any other files with the same root cause, or "None found"]

**Impact of this fix:**
[What changes — will it affect other features? Any risks?]

```

Then use `AskUserQuestion` to get approval:
- **Approve fix** — proceed with the fix as described
- **Adjust approach** — user provides feedback on the diagnosis
- **Cancel** — stop, don't fix

**Do NOT write any code until the user approves.**

---

## Step 5: Apply the Fix (AFTER APPROVAL)

1. **Read the relevant standard checklists** via `Skill` tool before writing — understand what correct code looks like for this file type
2. **Fix at the source** — change the code where the problem ORIGINATES, not where the symptom appears
3. **Fix ALL instances** — every file with the same root cause
4. **Verify no breakage:**
   - Changed a snippet interface? → `Grep('render "{snippet}"', glob='**/*.liquid')` — update all callers
   - Changed a schema setting? → `Grep('{setting-id}', glob='**/*.liquid')` — check full chain
   - Changed CSS classes? → `Grep('{class-name}', glob='**/*.liquid')` — verify HTML references
   - Changed a data shape? → `Grep` to trace all consumers
5. **Run automated validation:**
   - `shopify theme check --path . --fail-level error` if available
   - Validate schema JSON is well-formed

## Step 6: Report

Write the fix log to `.buildspace/artifacts/{feature-name}/fix-log.md` (if in pipeline) or present in conversation (if standalone).

Read the template from `${CLAUDE_SKILL_DIR}/templates/fix-log-template.md` and fill it in.

Tell the user what was fixed and suggest next step:
```
→ Run /assess to verify the fix and check for any new issues.
```

---

## Rules
- **Never guess.** If you're not sure about the cause, read more code before diagnosing
- **Never fix code during diagnosis.** Step 4 is a hard stop — always wait for user approval
- **Never patch symptoms.** Find the root cause. If the fix feels like a workaround, dig deeper
- **Never fix only the reported instance.** Search for and fix ALL instances of the same root cause
- **Always run theme check after fixing.** A fix that introduces new errors is not a fix
- **Think from first principles.** Ask "what should this do?" before asking "what's wrong?"
- **Load skills before fixing** to ensure the fix follows standards
