# Performance Optimisation Report

**Site:** {siteHost}
**Page:** {page type} (`{template file}`)
**Baseline:** `{branch A}` ({baseline URL})
**Optimised:** `{branch B}` ({optimised URL})
**Method:** Google PageSpeed Insights, median of {N} tests per device for each version; scans taken {dates}

## Baseline (before optimisation)

| Category | Mobile | Desktop |
|---|---|---|
| Performance | {X}/100 | {X}/100 |
| Accessibility | {X}/100 | {X}/100 |
| Best Practices | {X}/100 | {X}/100 |
| SEO | {X}/100 | {X}/100 |

| Metric | Mobile | Desktop |
|---|---|---|
| First Contentful Paint (FCP) | | |
| Largest Contentful Paint (LCP) | | |
| Total Blocking Time (TBT) | | |
| Cumulative Layout Shift (CLS) | | |
| Speed Index (SI) | | |

**Root causes identified**

1. {Specific cause: the file, resource or script responsible, quantified (e.g. "blocks the first paint for 900 ms", "main image starts loading 1.4 s late").}

## Optimisations Implemented

### {N}. {Optimisation title}

**Files changed:** `{files}`

{What was changed and why, which problem it solves; resources and values before and after. Tables where they help.}

**Impact:** {what this removes or improves, with numbers where the scans show them}

## Results (after optimisation)

### Mobile

| Category | Baseline | Optimised | Change |
|---|---|---|---|
| Performance | | | |
| Accessibility | | | |
| Best Practices | | | |
| SEO | | | |

| Metric | Baseline | Optimised | Change |
|---|---|---|---|
| FCP | | | |
| LCP | | | |
| TBT | | | |
| CLS | | | |
| Speed Index | | | |

### Desktop

{same two tables}

> {Only if a metric got worse: why.} Scores vary by ±5–10 points between identical tests; the values above are medians of {N} tests.

### Real visitors (field data)

{Current real-visitor Core Web Vitals (LCP, INP, CLS) and verdict, for the page or the whole site. Explain these cover the last 28 days, so the effect of these changes appears gradually after release; re-check around {date}.}

## What Still Limits the Score

*(Only when the optimised scan shows remaining opportunities.)*

- **Third-party scripts:** main-thread time by source, and which can't be changed in theme code.
- **Remaining theme opportunities:** each with its estimated saving.

| Metric | Weight in the performance score | Theme-controllable? |
|---|---|---|
| Total Blocking Time (TBT) | 30% | |
| Largest Contentful Paint (LCP) | 25% | |
| Cumulative Layout Shift (CLS) | 25% | |
| First Contentful Paint (FCP) | 10% | |
| Speed Index (SI) | 10% | |

## Summary of Files Changed

| File | Change |
|---|---|
| `{path}` | {one line} |
