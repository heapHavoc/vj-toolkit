# Third-Party App Performance Audit

**Site:** {siteHost}
**Page:** {page type} ({URL})
**Date:** {scan date}
**Source:** Google PageSpeed Insights (median of {N} tests per device) and theme code analysis
**Test devices:** emulated mid-range phone on slow 4G (mobile) and emulated desktop

## Executive Summary

One short paragraph: how much of the page's weight and processing time comes from apps versus the theme, and the two or three apps that matter most.

| Source | Transfer size | Main-thread time | Share of TBT |
|---|---|---|---|
| Third-party apps | ~{X} KiB | ~{X} ms | {X}% or "not reported" |
| Theme and Shopify | ~{X} KiB | ~{X} ms | {X}% or "not reported" |
| **Total** | **~{X} KiB** | **~{X} ms** | Mobile TBT: {X} ms |

> {Only if needed: which numbers are estimates or not reported, and why.}

## App-by-App Analysis

### {N}. {App name} ({one-line purpose})

**What it does for the business:** {purpose}
**How it's loaded:** {Theme code: `snippets/x.liquid:12` / App embed (Theme editor › App embeds) / App block on {templates} / Platform (`content_for_header`, app settings) / Unknown}

| Resource | Transfer size | Cache TTL | Unused |
|---|---|---|---|
| {file} | | | |
| **Total** | | | |

**Processing time (mobile):** {X ms, with a per-script breakdown if several}

**Issues:**
- {render-blocking, heavy main-thread work, unused code, short or missing caching, duplicate loading, loads on pages that don't use it, etc.}

**Recommendations:**
- [ ] {action that matches how it's loaded}

**Priority:** {CRITICAL / HIGH / MEDIUM / LOW / DONE} – {one-line reason}

## Impact Summary

**Total third-party impact (mobile)**

| App | Transfer size | Processing time | Blocking time | Priority |
|---|---|---|---|---|

**Estimated improvement if the actions are taken**

| Action | Est. TBT saved | Est. score impact |
|---|---|---|
| | | |
| **Total potential** | | |

All figures in this table are estimates based on the measured processing time.

## Recommended Actions

### Immediate (no business risk)
1. {e.g. load a widget only when the visitor opens it; add caching to a theme-hosted file}

### Short-term (app settings or vendor contact)
1. {e.g. turn off an app's script on pages that don't use it; ask the vendor about a lighter loader}

### Evaluate (business decision)
1. {e.g. whether an app's value justifies its cost; whether two apps do the same job}

## How to Check App Embeds

1. Go to **Shopify Admin › Online Store › Themes**.
2. Click **Customize** on the theme.
3. In the left sidebar, open **App embeds** (the toggle icon).
4. Review every enabled embed; each one adds its script to the pages it targets.
5. Turn off embeds that aren't needed. This affects **every page**; for per-page control, check the app's own settings.

Apps that add scripts without an embed do so through app script tags or Customer Events pixels (**Settings › Customer events**); those are controlled in the app or by uninstalling it.
