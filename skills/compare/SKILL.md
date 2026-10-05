---
name: compare
description: >
  Visual comparison of developed page against Figma design. Captures
  section-level screenshots via Playwright, then compares each section
  against the Figma screenshots. Auto-triggers /fix on mismatch.
  Use after /execute when building from a Figma design.
disable-model-invocation: true
model: claude-opus-5
context: fork
allowed-tools: Read, Write, Bash, Glob, Grep, Agent, AskUserQuestion, Skill
---

# Compare — Visual Design Comparison

You are entering the Compare phase. Your job is to capture screenshots of the developed page section-by-section and compare them against the original Figma screenshots. If mismatches are found, trigger /fix and re-compare. Maximum 2 comparison-fix iterations.

---

## Input

Context or overrides: `$ARGUMENTS`

---

## Artifact Resolution

1. Read `.buildspace/current-feature` for the active feature name
2. If the file doesn't exist, check `.buildspace/artifacts/` for feature folders containing both `design-context.md` (from /figma) and `selectors.json` (from /execute)
3. If one folder exists → use it
4. If multiple → ask the user which feature to compare
5. If `design-context.md` is missing → tell user to run `/figma` first
6. If `selectors.json` is missing → tell user to run `/execute` first (it generates the selector mapping)

Read from `.buildspace/artifacts/{feature-name}/`:
- `sections.json` — canonical section names from `/figma` (the naming authority)
- `selectors.json` — section-to-CSS-selector mapping (names must match sections.json)
- `design-context.md` — for design specifications
- `execution-log.md` — for list of files built (context for /fix)

---

## Step 1: Determine Comparison Scope

Read `sections.json`, `selectors.json`, and `design-context.md` to determine which sections to compare.

**Matching logic:** For each entry in `selectors.json`, find the matching entry in `sections.json` by `name`. This gives you:
- The CSS selector (from selectors.json) → used to capture the code screenshot
- The Figma screenshot paths (from sections.json) → the reference to compare against

If a name in selectors.json has no match in sections.json, flag it as a naming mismatch and skip.

**Full page build:** Compare all sections listed in selectors.json that have matching Figma screenshots.

**Single section build:** If only one section was built (one entry in selectors.json), compare only that section.

For each matched section, verify that Figma screenshots exist on disk:
- `.buildspace/artifacts/{feature-name}/screenshots/figma-{name}-desktop.png`
- `.buildspace/artifacts/{feature-name}/screenshots/figma-{name}-mobile.png` (if mobile was captured)

If a Figma screenshot file is missing for a section, skip that section and note it.

---

## Step 2: Get the Preview URL

Read `.buildspace/artifacts/{feature-name}/preview-url.txt` if it exists and use that.

Otherwise ask the user for the Shopify preview URL (e.g. `http://127.0.0.1:9292`) and storefront password if any, then **write the URL to that file** so later runs and later features don't ask again. If the user supplied a URL in `$ARGUMENTS`, that wins over both.

Never store the password on disk.

---

## Step 3: Capture and Compare

Run the capture script. It resolves Playwright itself — installing it if absent — so there is nothing to set up or tear down:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/capture-sections.js \
  --url "<preview-url>" \
  --feature "<feature-name>" \
  --selectors ".buildspace/artifacts/{feature-name}/selectors.json" \
  --password "<password-if-any>"
```

For each section in `selectors.json` this captures `code-{section}-desktop.png` at 1440px and `code-{section}-mobile.png` at 390px, both at 2x to match the Figma exports, reloading the page for each viewport.

It then compares each capture against its `figma-{section}-{viewport}.png` reference in two tiers and writes the verdicts to `capture-manifest.json`:

| Verdict | Meaning | Action |
|---|---|---|
| `PASS` | Dimensions match and pixel diff is under threshold | No review needed |
| `REVIEW` | Dimensions differ, or pixel diff exceeds threshold | Read the images in Step 4 |
| `DIMENSIONS_ONLY` | Dimensions match; pixel diff could not run | Read the images in Step 4 |
| `NO_FIGMA_REFERENCE` | No Figma screenshot for this section | Skip and note it |
| `NO_CODE_IMAGE` | Capture failed | Report as an issue |

A section that fails the pixel tier also gets a `diff-{section}-{viewport}.png` highlighting where.

**Threshold.** The default is 5%. A browser and Figma rasterise text differently, so a correct section never scores zero — this number is a triage signal, not a verdict. If it is flagging sections you know are right, or missing ones you know are wrong, recalibrate it against a known-good section and pass `--diff-threshold <n>`.

If a section selector is not found or not visible, note it as a potential issue.

---

## Step 4: Review the Flagged Sections

Read `capture-manifest.json` first. **Only read image files for sections whose verdict is `REVIEW` or `DIMENSIONS_ONLY`.** Sections marked `PASS` are done — do not open them.

For each flagged section, read the Figma screenshot, the code screenshot, and the diff image where one exists. The diff localises the problem, so read it first.

Compare across these dimensions:

| Dimension | What to check |
|-----------|--------------|
| Layout | Element positions, proportions, column counts, content stacking order |
| Spacing | Margins, padding, gaps between elements |
| Typography | Font sizes (relative), weights, alignment, line spacing |
| Colors | Background colors, text colors, border colors, accent colors |
| Images & Media | Sizing, aspect ratio, positioning, cropping |
| Interactive Elements | Button styles, link appearance, form elements |
| Content Structure | Does the section contain all the elements shown in the Figma design? |

For mobile, additionally check that the layout reflows (horizontal to vertical stacking), elements are resized appropriately, and anything meant to be hidden or shown at that breakpoint behaves.

### Verdicts per section

- **MATCH** — faithfully represents the design. Minor rendering differences do NOT count as mismatches.
- **MINOR** — small deviations that don't affect the overall look. Note them; do not trigger a fix.
- **MISMATCH** — a difference a user would notice. Describe exactly what's wrong.

Every section the manifest marked `PASS` is recorded as **MATCH** without you opening it.

**Not mismatches:** font rendering and anti-aliasing, sub-pixel rounding, scrollbar presence, browser-specific form styling, hover or focus states absent from Figma.

---

## Step 5: Generate the Comparison Report

Read the template from `${CLAUDE_SKILL_DIR}/templates/comparison-report-template.md`, fill it in, and write it to `.buildspace/artifacts/{feature-name}/comparison-report.md`.

Include the manifest's dimension delta and pixel-diff percentage for each section — they are the evidence behind the verdict, and they make the next run comparable to this one.

---

## Step 6: Handle Results

### All MATCH or MINOR

```
Visual comparison passed. All sections match the Figma design.
Report saved to .buildspace/artifacts/{feature-name}/comparison-report.md

→ Run /assess for verification.
  Pipeline: /assess
```

### Any MISMATCH found

If this is **iteration 1**:

1. Tell the user what mismatches were found — a brief summary, not the full report
2. Invoke `/fix` through the Skill tool with the mismatches as context:
   ```
   Visual comparison found mismatches. Fix the following issues from comparison-report.md:
   {list each MISMATCH issue with section name and description}
   Feature: {feature-name}
   ```
3. After `/fix` completes, re-run Step 3 and Step 4 (iteration 2). The capture script re-compares automatically, so only genuinely still-broken sections come back for review.

If this is **iteration 2**:
- Report what still doesn't match and stop. Do NOT trigger a third fix cycle.
- Suggest the user review manually, then:
  ```
  → Run /assess for verification (even with remaining visual issues).
    Pipeline: /assess
  ```

---

## Rules
- Maximum 2 compare-fix iterations. Never run a third.
- Focus on structural fidelity, not pixel perfection. Browser rendering differs from Figma — that's normal.
- Font rendering, anti-aliasing, and sub-pixel differences are NOT mismatches.
- If a selector is not found, flag it as an issue — the section wasn't built or the selector is wrong.
- Trust the manifest. Read images only for sections it flagged — opening a `PASS` section is wasted work.
- Never guess a verdict from code alone. For a flagged section, read the screenshots.
- Do NOT install or uninstall Playwright. The capture script owns that.
- Do NOT fix issues yourself. Invoke /fix through the Skill tool and let it handle repairs.
- Present the comparison report path to the user, not the full report content.
