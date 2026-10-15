---
name: perf-report
description: >
  Write a client-ready before / after performance optimisation report for a
  Shopify page: compares a baseline and an optimised state using PageSpeed
  Insights scans (median of runs) and the git diff between the two branches,
  explains the root causes, every optimisation actually in the diff, the
  results, and what still limits the score. Saves .md and a .docx in the house
  style. Use when the user asks for a performance report, a before/after
  comparison, or to compare two branches for performance.
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion
---

# Perf Report: before / after optimisation report

Compare a baseline and an optimised version of the same page, and explain to the client what was wrong, what was changed, and what improved. Every optimisation described must exist in the git diff.

Shared scripts: `${CLAUDE_SKILL_DIR}/../perf-scan/scripts/`. Thresholds: `${CLAUDE_SKILL_DIR}/../perf-scan/references/thresholds.md`.

## Input

`$ARGUMENTS`: two inputs, **baseline first, optimised second**. Each is a URL (usually the live URL and a `?preview_theme_id=` URL) or a scan folder / `scan.md`. If fewer than two, ask for both.

## Step 1: Branches, and that each URL measures the right code

Ask once, together:
1. **Which two branches hold the code?** (e.g. `main` = baseline, `performance` = optimised)
2. **Which theme each URL shows.** A preview URL measures whichever theme its `preview_theme_id` points to; that theme must be the one built from the optimised branch (GitHub-connected theme, or pushed from it). Confirm the mapping with the user, or with `shopify theme list` when the CLI is logged in.

If the mapping can't be confirmed, say so in the report's header instead of assuming.

## Step 2: Scans

For each URL, reuse or run a scan exactly as `/perf-client-audit` Step 1 (the scan is the median of 3 runs per device):

```bash
node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/psi-scan.mjs --root . --latest --url "<url>"
node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/psi-scan.mjs --root . --url "<url>"
```

- **Both states must be scanned the same way** (same number of runs, same day where possible). If one side is an old single-run scan, re-scan it or flag it.
- **Check the redirect warning** in each `scan.md`. If the optimised URL redirected to the live page, PSI measured the live theme: stop and tell the user.
- **Both URLs must be the same page.** Compare `meta.page`; a home scan can't be compared with a product scan.

## Step 3: Page and template

From `meta.pageType` find the template on the optimised branch:

```bash
git ls-tree --name-only <branch-B> templates/ | grep -E '^templates/(index|product|collection|page|cart|search|article|blog)'
```

If several variants match (e.g. `product.json` and `product.alt.json`), check the scan's URL for `?view=` or ask which template the page uses.

## Step 4: The code changes

```bash
git diff --stat <branch-A>..<branch-B>
git diff --name-only <branch-A>..<branch-B>
```

For each changed file, read both versions (`git show <branch>:<path>`) and note what changed, which baseline problem it addresses, and what it should improve. Also read the baseline's `layout/theme.liquid` and the files that render the tested template, to understand root causes. Group changes into optimisations (e.g. main image prioritised, CSS loading order, scripts deferred, images resized, layout cleanup).

## Step 5: Root causes and what remains

From the baseline scan (using detail items, not just totals):
- render-blocking CSS or JS; the main (LCP) image discovered late, lazy-loaded or oversized
- large unused JS or CSS; heavy third-party scripts on the main thread
- missing image sizes (layout shifts); overlays, splash screens or anti-flicker scripts hiding the page
- short caching; images without responsive sizes

From the optimised scan, decide whether a **What Still Limits the Score** section is needed: remaining theme-fixable opportunities, or third-party scripts that dominate TBT.

## Step 6: Write the report

Fill `${CLAUDE_SKILL_DIR}/templates/performance-report-template.md`:
- **Mobile before desktop** in every table.
- Show the **median** and, when the run range is wide, the range. Note that ±5–10 points between runs is normal.
- **Only describe changes that are in the diff.** Name files, values before and after, and the reasoning.
- If a metric got worse, explain why in a note under the table (e.g. a new app added since the baseline).
- **Field data (real visitors)** reflects the last 28 days, so it won't show the change yet. Report it as context, and say when to re-check (about 28 days after release).
- No Time to Interactive, no lab INP.

## Step 7: Save and export

1. Path: `.buildspace/artifacts/perf/reports/<site>/performance-report-<page>-<YYYY-MM-DD>.md` (`-2`, `-3`… if it exists).
2. Write the report, then export:
   ```bash
   node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/md-to-docx.mjs --in "<report.md>" --subtitle "Performance Optimisation Report | <siteHost> | <Month YYYY>"
   ```

## Step 8: Hand off

Tell the user both paths and the headline change (mobile and desktop performance, LCP, TBT).

## Rules

- Never invent a change, a number or a cause. If the diff or the scans don't show it, it doesn't go in.
- Never compare scans of different pages, or a preview that redirected to live.
- Never present lab gains as real-visitor gains; field results come later.
