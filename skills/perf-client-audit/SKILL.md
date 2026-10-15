---
name: perf-client-audit
description: >
  Write a client-ready, plain-English performance audit of a storefront page
  from PageSpeed Insights data: scores, the real-user Core Web Vitals verdict,
  what each metric means, what is slowing the page down (named scripts and
  apps), images, JavaScript and CSS, and accessibility / SEO / best practices.
  Saves .md and a .docx in the house document style. Use when the user asks for
  a performance audit or audit report to share with a non-technical client.
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion
---

# Perf Client Audit: plain-English performance audit

Produce a performance audit a business owner can read: what is slowing the site down, what it means for visitors and for Google, and what to fix. No audit IDs, JSON or developer shorthand.

Shared scripts: `${CLAUDE_SKILL_DIR}/../perf-scan/scripts/`. Thresholds: `${CLAUDE_SKILL_DIR}/../perf-scan/references/thresholds.md`.

## Input

`$ARGUMENTS`: a page URL, or the path to an existing scan folder / `scan.md`. Optionally `--name "<Brand name>"` for the title (default: the store's domain). If nothing is given, ask for a URL.

## Step 1: Get the scan

- A path → use that scan folder.
- A URL → check for an existing scan:
  ```bash
  node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/psi-scan.mjs --root . --latest --url "<url>"
  ```
  If one exists, ask: use the scan from `<scannedAt>`, or run a fresh one. If none exists, say so and run one. Follow `/perf-scan` Step 2 for the API key (never echo it).
  ```bash
  node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/psi-scan.mjs --root . --url "<url>"
  ```

## Step 2: Read the data

Read `scan.md` in full, and `summary.json` for exact values. Hold:
- scores for all four categories, mobile and desktop
- **field data** (`devices.<d>.median.field.best`): source (page or whole site), Core Web Vitals verdict, p75 LCP / INP / CLS / FCP
- lab metrics (median and range), the LCP element and its phases
- failing insights with estimated savings; render-blocking requests; image delivery
- third parties, JavaScript execution per script, unused JS / CSS, page weight
- accessibility, best-practices and SEO failures
- anything marked "Not reported by this Lighthouse version": leave that topic out rather than claiming it's fine

Page type and site name come from `summary.json` `meta` (`pageType`, `siteHost`).

## Step 3: Write the report

Fill `${CLAUDE_SKILL_DIR}/templates/client-audit-template.md`. Writing rules:
- **Plain English for a business owner.** Use everyday comparisons ("the page is frozen for 2 seconds, so taps do nothing"). Explain any term on first use.
- **Scores appear only in the summary table.** Elsewhere, describe the experience and weave the numbers in.
- **The Core Web Vitals verdict comes only from field data.** If there is no field data, write "Google doesn't have enough real-visitor data for this page yet" and don't invent a pass or fail. If the data is for the whole site, say so.
- **Use each device's own targets** from `thresholds.md`: desktop targets are stricter than mobile.
- **INP** is covered from field data only. Never quote a lab INP.
- **Name the real culprits.** Use the script, app and vendor names from the data (e.g. a review widget, a tag manager, a chat app); group a vendor's files together. Don't name apps that aren't in this page's data.
- **Quantify with the data you have**: KiB, seconds, counts. Never invent a saving; use the estimates the scan gives.
- Mobile first, then desktop, everywhere.
- Short paragraphs; no PSI audit IDs; no raw JSON.

## Step 4: Save and export

1. Path: `.buildspace/artifacts/perf/reports/<site>/client-audit-<page>-<YYYY-MM-DD>.md`, where `<site>` and `<page>` are the `meta.site` and `meta.page` of the scan. If the file exists, add `-2`, `-3`, …
2. Write the report.
3. Export the .docx (house style: Manrope, navy headings, bordered tables):
   ```bash
   node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/md-to-docx.mjs --in "<report.md>" --subtitle "Performance Audit | <siteHost> | <Month YYYY>"
   ```
   The first export installs the `docx` package once (about 10 s).

## Step 5: Hand off

Tell the user both file paths and the three key findings in one line each.

```
→ Next: /perf-apps-audit <url>   app-by-app impact and what to do about each
```

## Rules

- Every statement must trace to the scan. If the data doesn't show it, don't say it.
- Never present a lab score as what real visitors experience.
- Never include pricing, timelines or company details unless the user supplies them for this report.
