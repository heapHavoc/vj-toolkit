---
name: assess
description: >
  Assess built features with first-principles thinking. Checks requirements
  coverage, standards compliance, integration correctness, and edge cases.
  Reports findings and stops — no auto-fix. Use after /execute.
disable-model-invocation: true
context: fork
allowed-tools: Read, Write, Grep, Glob, Bash, Agent
---

# Assess — First-Principles Verification

You are entering the Assess phase. Your job is to verify that what was built is correct, complete, and follows standards. Think from first principles — don't just pattern-match against checklists. Understand WHY each requirement exists and whether the implementation actually satisfies it.

**Report findings and stop. Do not fix anything. Do not loop.**

## Input
Context or overrides: `$ARGUMENTS`

## Artifact Resolution
1. Read `.buildspace/current-feature` for the active feature name
2. If the file doesn't exist, look in `.buildspace/artifacts/` for feature folders containing `execution-log.md`
3. If one folder exists → use it
4. If multiple folders exist → ask the user which feature to assess
5. If no execution-log.md found → ask the user to run `/execute` first

Read from `.buildspace/artifacts/{feature-name}/`:
- `clarify.md` — requirements to assess against
- `plan.md` — planned approach and test cases
- `execution-log.md` — files created/modified

---

## Assessment Process

### Step 1 — Automated Checks

Run automated validation directly:

#### Shopify Theme Check
```bash
shopify theme check --path . --fail-level error
```
If not available, skip and note it.

#### Schema JSON Validation
For each section file from execution-log:
```bash
node -e "
const fs = require('fs');
const content = fs.readFileSync('{file-path}', 'utf-8');
const match = content.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
if (match) { JSON.parse(match[1]); console.log('Valid'); }
else { console.log('No schema found'); }
"
```

#### Integration

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/assess/scripts/verify-integration.mjs --feature {feature-name}
```

Reads the file list out of `execution-log.md` and confirms every section is reachable from a template, every snippet is rendered, every CSS and JS asset is loaded, and every `asset_url` reference resolves. Exits non-zero and names the problem in JSON when something is wrong.

This is the **only** place these checks run. Neither agent below repeats them, and you should not hand-grep for them either.

Report any failures.

### Step 2 — Agent Assessment

Dispatch **both agents in a single message, as two tool calls**, so they run concurrently. They are independent: one checks whether the feature works, the other whether the code is written well, and neither reads the other's output. Dispatching them in separate turns runs them serially for no reason.

First work out which file types the execution log lists — `.liquid`, section `.liquid`, `.css`, `.js` — and name them in the code-reviewer prompt so it loads only the checklists it needs.

**output-validator:**

```
Validate feature: {feature-name}

Files: [list from execution-log]
Requirements: .buildspace/artifacts/{feature-name}/clarify.md (if exists)
Plan: .buildspace/artifacts/{feature-name}/plan.md (if exists)

Check every file for:
1. Null/blank guards on every setting that outputs HTML
2. Empty collection handling in loops
3. Block rendering covers all block types declared in schema
4. Images have alt text, width, height attributes
5. Links have valid href
6. Conditional display works (blank settings hide elements)
7. Schema settings correctly wired to Liquid output

Integration is already verified by verify-integration.mjs — do NOT check template
registration, snippet wiring or asset existence.

If requirements exist: verify each requirement — Met / Partially met / Not implemented
If plan exists: run each test case — Pass / Fail with reason
```

**code-reviewer:**

```
Review these files: [list from execution-log]

File types present: [e.g. "section .liquid, .css" — load only these checklists]

Execution log: .buildspace/artifacts/{feature-name}/execution-log.md

For each file, validate against the relevant skill checklist.
Check standards compliance, readability, maintainability.
Report issues with severity: Critical / Should Fix / Nice to Have.

Cross-file concerns that are yours alone:
- Schema setting ID collisions across sections
- CSS class conflicts with existing styles
- Unused snippets created but never rendered

Do NOT check template registration or asset existence — verify-integration.mjs owns those.
```

---

### Step 3 — First-Principles Questions

Think about the built feature from first principles. Ask yourself context-appropriate questions like:

- Would this break on a store with zero products in a collection?
- Would this look correct with no image uploaded?
- Would this survive a theme editor session? (section independence, live preview)
- Does every block type render something meaningful?
- Is every schema setting actually wired to output, or are there orphans?
- Would a merchant understand these setting labels?
- Would this break if a merchant reorders blocks?

These are examples — adapt to the specific feature. The point is to think beyond checklists about whether this would actually work in production.

---

## Report

Write the assessment report to `.buildspace/artifacts/{feature-name}/assessment-report.md`.

Read the template from `${CLAUDE_SKILL_DIR}/templates/assessment-report-template.md` and fill it in with findings from all steps.

Combine the output-validator's findings into the Requirements Coverage section.
Combine the code-reviewer's findings into the Standards Compliance section.
Take the Integration section straight from `verify-integration.mjs` output — it is already structured, so quote its findings rather than restating them.
Add your own first-principles findings.

Tell the user:
- Where the report was saved
- Overall verdict
- Count of issues by severity

**Do NOT output the full report in conversation. The artifact file is the source of truth.**

---

## Auto-Capture Learnings

If verdict is **PASS**, check if something non-obvious was learned during this feature's development. Apply the filter: "If I knew this before starting, would it have made the task faster or avoided a mistake?"

If nothing non-obvious → skip. Don't force it.

If learnings exist, append to `.claude/patterns-learned.md` in the project directory:

```markdown
### {Brief Title}
**Type:** Pattern / Mistake & Fix / Convention / Codebase Context / Platform Gotcha
**Category:** Liquid / Sections / Schema / CSS / JavaScript / Architecture
**Date:** {YYYY-MM-DD}

[2-4 sentences: what was learned, why it matters, when to apply it.]
```

Before writing:
- Read existing file to avoid duplicates
- If a new learning conflicts with an existing one, update the existing entry
- Maximum 3 learnings per feature — keep it focused

---

## Next Step

After presenting the report, tell the user:

If verdict is **PASS**:
```
Pipeline complete. Feature is ready for deployment.
```
If verdict is **NEEDS WORK**:
```
→ Run /fix to resolve issues. The assessment report includes root cause analysis for each issue.
```

---

## Rules
- **Never fix issues during assessment** — only identify and report them
- **Think from first principles** — don't just check boxes. Ask "would this actually work?"
- **Be honest** — if the code works, say PASS. Don't invent issues. Don't soften real issues.
- **Root causes, not symptoms** — in the report, explain WHY something is wrong, not just WHAT
- **One pass only** — assess once, report, stop. No loops, no retries.
- **PROJECT standards override generic best practices** — use the skill checklists as authority
- **Dispatch both agents in one message** — they are independent, and separate turns run them serially
- **Never hand-grep integration** — `verify-integration.mjs` owns template registration, snippet wiring and asset existence
