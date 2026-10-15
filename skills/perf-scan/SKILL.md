---
name: perf-scan
description: >
  Run Google PageSpeed Insights (mobile + desktop, median of 3 runs) for one or
  more storefront URLs and save the raw responses plus a structured scan
  (summary.json + scan.md): real-user field data and Core Web Vitals verdict,
  lab metrics, LCP element and phases, insights, third parties, images, JS/CSS,
  caching, accessibility / best-practices / SEO failures. The data source for
  /perf-client-audit, /perf-apps-audit and /perf-report. Use when the user asks
  to run a PSI / PageSpeed scan or collect performance data for a URL.
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, AskUserQuestion
---

# Perf Scan: PageSpeed Insights data collection

Collect PageSpeed Insights data for storefront URLs and save it in one place every perf skill reads. **Do not interpret or advise here**: this skill only collects. Reports come from `/perf-client-audit`, `/perf-apps-audit` and `/perf-report`.

Scripts: `${CLAUDE_SKILL_DIR}/scripts/` (Node 18+, no dependencies).

## Input

`$ARGUMENTS`: one or more URLs, optionally `--runs N` (default 3) or `--strategies mobile` / `desktop`. If no URL is given, ask for it. For a store-wide picture, suggest the homepage, one collection page and one product page.

## Step 1: Reuse or re-run

```bash
node ${CLAUDE_SKILL_DIR}/scripts/psi-scan.mjs --root . --latest --url "<url>" [--url "<url>"]
```

For each URL with an existing scan, ask once (one question for all URLs): reuse the scan from `<scannedAt>`, or run a fresh one. Default to fresh if the scan is older than 7 days or the theme changed since.

## Step 2: API key

The script reads `$PAGESPEED_API_KEY`, else `.buildspace/.psi-key`. If neither exists:
- Ask the user to `export PAGESPEED_API_KEY=...` (free key: https://developers.google.com/speed/docs/insights/v5/get-started). Prefer the env var.
- If they paste a key instead, write it to `.buildspace/.psi-key` and make sure `.buildspace/` or `.buildspace/.psi-key` is in `.gitignore`.
- **Never echo the key**, put it in a command line, or write it anywhere else.
- Without a key the script still runs, but Google allows only a few keyless requests, so expect 429 errors.

## Step 3: Scan

```bash
node ${CLAUDE_SKILL_DIR}/scripts/psi-scan.mjs --root . --url "<url>" [--url "<url>"] [--runs 3]
```

- Each URL takes about 1–3 minutes per run (mobile and desktop run in parallel; runs are sequential). Tell the user before a long multi-URL scan.
- Output per URL: `.buildspace/artifacts/perf/scans/<site>/<theme>/<page>/<YYYY-MM-DD-HHMM>/`
  - `mobile-runN.json`, `desktop-runN.json`: raw PSI responses
  - `summary.json`: extracted data (median scores and lab metrics; details from the median run)
  - `scan.md`: the readable scan
- The folder is per **page**, so a homepage scan never stands in for a product page.
- A failed run is retried; a device that fails every run is listed under `errors`. Report failures plainly, never fill gaps with guesses.

## What the scan contains

- **Field data first** (real Chrome users, p75 over 28 days): LCP, INP, CLS, FCP, TTFB. Page-level when Chrome has enough data, else the whole origin, labelled as such. The **Core Web Vitals verdict comes only from field data**, never from lab metrics.
- **Lab metrics** (one controlled test, median of N runs, with range): FCP, LCP, TBT, CLS, Speed Index. No Time to Interactive (removed from Lighthouse) and no lab INP (INP needs real interactions; TBT is its lab proxy).
- LCP element and phase breakdown, failing insights sorted by estimated savings, render-blocking requests, image delivery, third parties (by entity and by resource), JS execution per script, main-thread work, unused JS / CSS, caching, layout shifts, fonts, page weight, DOM size, duplicated and legacy JS, server response.
- Accessibility, best-practices and SEO failures with sample elements.
- Lighthouse 12/13 "insight" audits are read first, older audit ids second. A section neither exists for says **"Not reported by this Lighthouse version"**. It is never shown as "no issues".
- A redirect warning when PSI measured a different URL (a preview URL that lost its `preview_theme_id` measures the live theme).

Thresholds and how to read the numbers: `${CLAUDE_SKILL_DIR}/references/thresholds.md`.

## Step 4: Hand off

Tell the user where each `scan.md` is, the median mobile and desktop performance scores, and the field Core Web Vitals verdict.

```
→ Next: /perf-client-audit <url>   plain-English audit for the client
        /perf-apps-audit <url>     which apps slow the site
        /perf-report               before / after an optimisation
```

## Rules

- One URL = one page. Never reuse a scan from a different page or theme.
- Report the median, and the range when it is wide; never cherry-pick the best run.
- Lab scores vary run to run (±5–10 points is normal). Say so when comparing.
- Scans live under `.buildspace/`, never committed.
