# {Brand or site name} – Performance Audit

**Page:** {page type} ({URL})
**Date:** {scan date}
**Source:** Google PageSpeed Insights, median of {N} tests per device, plus real-visitor data from Google's Chrome User Experience Report

## Summary of Scores and Key Findings

| Category | Mobile | Desktop |
|---|---|---|
| Performance | {score}/100 | {score}/100 |
| Accessibility | {score}/100 | {score}/100 |
| Best Practices | {score}/100 | {score}/100 |
| SEO | {score}/100 | {score}/100 |

**Core Web Vitals assessment (real visitors): {PASSED / FAILED / Not enough data}** ({mobile and desktop, or which one; and "for this page" or "for the whole site"})

Performance is the focus; the third finding always groups the secondary categories:

1. **{Top performance issue}** – 1–2 sentences on the most impactful problem and its effect on visitors or sales.
2. **{Second performance issue}** – 1–2 sentences on the next most impactful problem.
3. **Accessibility, SEO and Best Practices** – one plain sentence each on the most important finding in each category.

## 1. Performance Overview

One paragraph: is the experience good, average or poor; does the site pass Google's Core Web Vitals for real visitors; what that means for visitors and for search rankings. Describe the experience rather than leading with the score.

### Mobile performance ({score}/100)
One paragraph on what phone visitors experience and why mobile matters most.

### Desktop performance ({score}/100)
One paragraph on the desktop experience and the room for improvement.

## 2. What the Metrics Mean

One sentence: each measurement explained in plain English. Real-visitor values come first where Google has them; test values follow.

### Largest Contentful Paint (LCP) – how quickly the main content appears
- Real visitors: {field p75, or "not enough data"}
- Mobile test: {value} (target under 2.5 s)
- Desktop test: {value} (target under 1.2 s)

Plain-English explanation and what the current values mean for visitors.

### Interaction to Next Paint (INP) – how quickly the page reacts to a tap or click
- Real visitors: {field p75, or "not enough data"} (target under 200 ms)

Explain that this is only measured with real visitors. Relate it to the Total Blocking Time result below, which is the test's closest stand-in.

### Cumulative Layout Shift (CLS) – how much the page jumps around while loading
- Real visitors: {field p75, or "not enough data"}
- Mobile test: {value} / Desktop test: {value} (target under 0.1)

Plain-English explanation; if good, say so positively.

### First Contentful Paint (FCP) – when something first appears
- Mobile test: {value} (target under 1.8 s) / Desktop test: {value} (target under 0.9 s)

### Total Blocking Time (TBT) – how long the page is frozen while loading
- Mobile test: {value} (target under 200 ms) / Desktop test: {value} (target under 150 ms)

Explain it as the time the page won't respond to taps or clicks, caused mostly by JavaScript.

### Speed Index – how quickly the visible page fills in
- Mobile test: {value} (target under 3.4 s) / Desktop test: {value} (target under 1.3 s)

## 3. What's Slowing the Page Down

Two to four paragraphs on the root causes, in plain English:
- anything that pauses the page before it can show ("render-blocking")
- how long the browser's main processor is busy running scripts, and which scripts
- total JavaScript work and who causes it, naming the actual scripts and apps
- total page weight compared with a well-optimised page (many deliver under about 1,500 KiB)

## 4. Images

### 4.1 The main (LCP) image
What the main element is (often the hero banner), whether it loads efficiently, and how long it waits before loading starts (from the LCP phases). If images are sent larger than displayed, give a plain example.

**Estimated potential savings: {X} KiB** (only if the scan gives an estimate)

Key issues as bullets.

### 4.2 How images load
Lazy loading in plain English; whether below-the-fold images load too early; what missing image sizes do (content jumping around). Impacts as bullets.

## 5. JavaScript and CSS

### 5.1 CSS
Unused styling code ("styling the browser downloads but never uses on this page"), the total estimated saving, the main contributors with their unused KiB, and the recommended steps.

### 5.2 JavaScript
Usually the biggest issue. Total unused JavaScript, what it means, the main contributors grouped by vendor, and any duplicated or legacy JavaScript flagged.

### 5.3 Third-party scripts
What third-party scripts are, which vendors are present and what they do, and their cost (time on the main processor, data transferred). Recommendations as bullets, for example:
- load after the main content appears
- remove tools that aren't used
- load chat and similar widgets only when a visitor opens them
- review how tags are managed

## 6. Accessibility, SEO and Best Practices

Three short paragraphs, one per category, each 3–5 sentences: what is failing, who or what it affects, and the single highest-priority fix. If a category has no failures: "No {category} issues were detected on this page."

**Accessibility** – …

**SEO** – …

**Best Practices** – …
