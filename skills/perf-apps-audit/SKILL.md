---
name: perf-apps-audit
description: >
  Audit which third-party apps and scripts slow a Shopify storefront page:
  combines PageSpeed Insights third-party, JS execution, unused JS and cache
  data with the theme code (snippets, app embeds, app blocks,
  content_for_header) to show how each app is loaded, what it costs, its
  priority, and concrete actions. Saves .md and a .docx in the house style.
  Use when the user asks which apps hurt performance, or for a third-party
  script audit.
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion
---

# Perf Apps Audit: third-party app impact

Find which apps and third-party scripts slow the page, how each one gets onto the page, and what to do about it. Written for the client and the developer together.

Shared scripts: `${CLAUDE_SKILL_DIR}/../perf-scan/scripts/`. App reference: `${CLAUDE_SKILL_DIR}/references/known-apps.md`.

## Input

`$ARGUMENTS`: a page URL, or the path to an existing scan folder / `scan.md`. Run it from the theme repo root so the theme code can be read. If nothing is given, ask for a URL.

## Step 1: Get the scan

Same as `/perf-client-audit` Step 1:

```bash
node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/psi-scan.mjs --root . --latest --url "<url>"
node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/psi-scan.mjs --root . --url "<url>"
```

## Step 2: Read the PSI data

From `scan.md` and `summary.json` (mobile first, desktop for comparison), take:
- **Third parties by entity and by resource**: transfer size, main-thread time, blocking time when reported
- **JavaScript execution per script** (`bootup`): the most precise CPU source
- **Unused JavaScript** per script; **caching** (TTL) per resource; page weight
- **Main-thread work** by category, and the page's TBT

Where the CPU numbers come from, in order: (1) JS execution per script, (2) third parties' main-thread time, (3) unused-JS bytes as a size proxy only. With (3), write "— (not reported)" for CPU and say so under the summary table. Never guess a CPU time.

TBT share: third-party **blocking time** ÷ page TBT when blocking time is reported. Main-thread time is not the same thing, so if only that exists, show it as main-thread time and don't call it a share of TBT.

## Step 3: Find how each app is loaded

Search the theme (from the repo root) for each third-party domain, script name and vendor keyword from Step 2, plus the hints in `references/known-apps.md`:
- **Theme code**: a match in `layout/`, `snippets/`, `sections/`, `blocks/` or `assets/` → name the file and line. Controllable in the theme.
- **App embed**: a block with `"type": "shopify://apps/<app>/…"` in `config/settings_data.json` → toggled in Theme editor › App embeds. Note whether it's `"disabled": true`.
- **App block**: `shopify://apps/…` inside `templates/*.json` or section group JSON → added in the theme editor on specific templates.
- **Platform**: Shopify's own scripts (`cdn.shopify.com/shopifycloud/…`, `monorail`, web pixels, `trekkie`), or a script from an app with no theme footprint → injected through `content_for_header` (app script tags, Customer Events pixels). Not controllable in theme code; controlled in the app's settings or by uninstalling.
- **Unknown**: can't be traced; say so.

Don't assume files exist (e.g. `snippets/head.liquid`); search instead.

## Step 4: Write the report

Fill `${CLAUDE_SKILL_DIR}/templates/apps-audit-template.md`:
- one section per app or script group, ordered **CRITICAL → HIGH → MEDIUM → LOW → DONE**
  - **CRITICAL**: render-blocking, or over ~300 ms main-thread on mobile
  - **HIGH**: 100–300 ms, or large unused JS
  - **MEDIUM**: under 100 ms but heavy transfer or no caching
  - **LOW**: small and well loaded
  - **DONE**: already deferred or loaded on interaction, so nothing to do
- name the real app (use `known-apps.md` to turn domains into app names) and what it does for the business
- recommendations must match how the app is loaded: theme code → a code change; app embed or block → a theme editor or app setting; platform → an app setting, Customer Events, or a business decision
- the score-impact table estimates TBT saved from the measured time only; label every estimate as an estimate
- Mobile first, then desktop.

## Step 5: Save and export

1. Path: `.buildspace/artifacts/perf/reports/<site>/apps-audit-<page>-<YYYY-MM-DD>.md` (`-2`, `-3`… if it exists).
2. Write the report, then export:
   ```bash
   node ${CLAUDE_SKILL_DIR}/../perf-scan/scripts/md-to-docx.mjs --in "<report.md>" --subtitle "Third-Party App Audit | <siteHost> | <Month YYYY>"
   ```

## Step 6: Hand off

Tell the user both paths and the top three apps by impact.

```
→ Next: fix what's in theme code, then /perf-report to show before vs after
```

## Rules

- Only apps that appear in this page's data. Never list an app from memory.
- Disabling an app embed affects every page; turning off an app may break a business function. Business decisions go under **Evaluate**, never "Immediate".
- Never recommend editing `content_for_header` or Shopify's own scripts.
