# Performance thresholds

## Field data (real users, what Google ranks on)

Core Web Vitals are assessed at the 75th percentile of real Chrome users over 28 days. A page **passes** only if all three are Good.

| Metric | Good | Needs improvement | Poor | Core Web Vital |
|---|---|---|---|---|
| Largest Contentful Paint (LCP) | ≤ 2.5 s | ≤ 4.0 s | > 4.0 s | Yes |
| Interaction to Next Paint (INP) | ≤ 200 ms | ≤ 500 ms | > 500 ms | Yes (replaced FID in March 2024) |
| Cumulative Layout Shift (CLS) | ≤ 0.1 | ≤ 0.25 | > 0.25 | Yes |
| First Contentful Paint (FCP) | ≤ 1.8 s | ≤ 3.0 s | > 3.0 s | No |
| Time to First Byte (TTFB) | ≤ 0.8 s | ≤ 1.8 s | > 1.8 s | No |

The same field thresholds apply to mobile and desktop.

## Lab data (Lighthouse, one controlled test)

Lighthouse rates each metric from its score: **Good ≥ 0.9, Needs improvement ≥ 0.5, Poor < 0.5**. The time behind a 0.9 score differs by device:

| Metric | Weight | Mobile "good" | Desktop "good" |
|---|---|---|---|
| First Contentful Paint (FCP) | 10% | ≤ 1.8 s | ≤ 0.9 s |
| Largest Contentful Paint (LCP) | 25% | ≤ 2.5 s | ≤ 1.2 s |
| Total Blocking Time (TBT) | 30% | ≤ 200 ms | ≤ 150 ms |
| Cumulative Layout Shift (CLS) | 25% | ≤ 0.1 | ≤ 0.1 |
| Speed Index (SI) | 10% | ≤ 3.4 s | ≤ 1.3 s |

Mobile tests emulate a mid-range phone on a slow 4G connection with a slowed CPU; desktop tests use a fast connection.

## Reading the numbers

- **Field beats lab.** Rankings use field data. Lab data explains *why* and is used to compare before and after a change.
- **Lab scores move run to run.** ±5–10 points between identical runs is normal, so use the median of 3+ runs and quote ranges for close calls.
- **TBT is the lab stand-in for INP.** Lab tests have no real interactions, so there is no lab INP.
- **Field data lags.** A fix shows in field data gradually over the following 28 days.
- **Time to Interactive** was removed in Lighthouse 10; don't report it.
