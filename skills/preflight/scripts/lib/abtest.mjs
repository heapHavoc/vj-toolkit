/**
 * abtest.mjs — the page-performance measurement engine for /preflight.
 *
 * Replaces Lighthouse's simulated ("Lantern") throttling as the source of truth.
 * Proven on two stores before adoption (2026-10): the old median-of-5 Lantern
 * method flipped verdicts between identical batches, reported a CLS P0 that was
 * an environment artifact, and missed a 21% LCP improvement. This engine gave
 * the same verdicts on two independent repeats.
 *
 * Method (each rule exists because of a measured failure):
 *   - Both sides load through Shopify's preview path (?preview_theme_id=<id>&pb=0),
 *     the live theme included. Live-URL-vs-preview-path skews FCP by ~300ms on the
 *     same theme (preview pages are uncached, carry a redirect and an extra script).
 *   - The preview cookie is obtained with a plain request first; the measured load
 *     has no redirect (the same pre-step Shopify/lighthouse-ci-action uses).
 *   - Warm-up loads until Shopify's server render cache is warm; a run whose
 *     `server-timing: processing` exceeds COLD_MS is a cold render and is excluded.
 *   - Every run proves what it measured: theme id from `server-timing: theme;desc=`,
 *     template from the <body> class.
 *   - Real throttling (CDP network 150ms/1.6Mbps + CPU slowdown), fresh browser
 *     profile per load, strict A/B alternation.
 *   - Sequential sampling with Mann-Whitney U + bootstrap CI of the median
 *     difference against a practical threshold (Pinpoint-style); "inconclusive"
 *     is an honest outcome, never forced into pass/fail.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));

export const NETWORK = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36';
export const COLD_MS = 200;
export const GATED = ['lcp', 'fcp', 'tbt', 'cls'];

export function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

/* ── URLs and identity ────────────────────────────────────────────────── */

/** Preview-path URL for a theme: ?preview_theme_id=<id>&pb=0 (+ view). */
export function previewPathUrl(store, pagePath, themeId, view) {
  const u = new URL(pagePath || '/', `https://${String(store).replace(/^https?:\/\//, '').replace(/\/$/, '')}`);
  if (view) u.searchParams.set('view', view);
  u.searchParams.set('preview_theme_id', String(themeId));
  u.searchParams.set('pb', '0');
  return u.toString();
}

export function parseServerTiming(header) {
  const h = header || '';
  const num = (re) => {
    const m = h.match(re);
    return m ? +m[1] : null;
  };
  return { theme: (h.match(/theme;desc="?(\d+)/) || [])[1] || null, pageType: (h.match(/pageType;desc="?([\w-]+)/) || [])[1] || null, processing: num(/processing;dur=([\d.]+)/), render: num(/render;dur=([\d.]+)/) };
}

export const templateClass = (template) => `template-${String(template).replace(/\./g, '-')}`;

/** Plain-HTTP identity probe (follows redirects carrying cookies): which theme + template does this URL render? */
export async function probe(url) {
  let cookie = '';
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': MOBILE_UA, ...(cookie ? { cookie } : {}) } });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (set.length) cookie = [cookie, ...set].filter(Boolean).join('; ');
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    const html = await res.text();
    const st = parseServerTiming(res.headers.get('server-timing'));
    const body = (html.match(/<body[^>]*\bclass="([^"]*)"/s) || [])[1] || '';
    return { status: res.status, finalUrl: current, theme: st.theme, pageType: st.pageType, processing: st.processing, templates: body.split(/\s+/).filter((c) => c.startsWith('template-')) };
  }
  return { status: null, finalUrl: current, theme: null, templates: [] };
}

/** Resolve a preview URL outside the browser: final URL + the cookies the redirect chain set. */
export async function resolvePreview(url) {
  let cookie = '';
  let current = url;
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': MOBILE_UA, ...(cookie ? { cookie } : {}) } });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (set.length) cookie = [cookie, ...set].filter(Boolean).join('; ');
    const loc = res.headers.get('location');
    if (!(res.status >= 300 && res.status < 400 && loc)) break;
    current = new URL(loc, current).toString();
  }
  return { finalUrl: current, cookie };
}

/* ── one load ─────────────────────────────────────────────────────────── */

function inPage() {
  const D = (window.__pf = { fcp: null, lcp: null, lcpEl: null, shifts: [], longtasks: [] });
  const desc = (n) => (n && n.tagName ? n.tagName.toLowerCase() + (n.id ? '#' + n.id.slice(0, 24) : '') + (n.classList?.length ? '.' + [...n.classList].slice(0, 3).join('.') : '') : null);
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') D.fcp = e.startTime;
  }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      D.lcp = e.startTime;
      D.lcpEl = desc(e.element);
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) D.shifts.push({ t: e.startTime, v: e.value, input: e.hadRecentInput });
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) D.longtasks.push({ s: e.startTime, d: e.duration });
  }).observe({ type: 'longtask', buffered: true });
}

/** CLS with session windows (1s gap, 5s cap). All shifts count — both sides get identical treatment. */
export function clsFromShifts(shifts) {
  let max = 0;
  let cur = 0;
  let start = -1;
  let prev = -1;
  for (const s of shifts) {
    if (start < 0 || s.t - prev > 1000 || s.t - start > 5000) {
      cur = 0;
      start = s.t;
    }
    cur += s.v;
    prev = s.t;
    max = Math.max(max, cur);
  }
  return max;
}

/**
 * One load in a brand-new browser (fresh profile: no cache, cookies or storage).
 * side: { url, viaPreviewCookie, headers? }
 */
export async function measureLoad(playwright, side, { throttle = true, cpuRate = 4, timeoutMs = 90000 } = {}) {
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 2.625, isMobile: true, userAgent: MOBILE_UA });
    let url = side.url;
    if (side.viaPreviewCookie) {
      // Follow every hop (myshopify → primary domain → preview cookie redirect) in this context's
      // cookie jar; the measured navigation then goes straight to the final URL.
      const r = await ctx.request.get(side.url, { maxRedirects: 10 });
      url = r.url();
    }
    const page = await ctx.newPage();
    await page.addInitScript(inPage);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    if (throttle) {
      await cdp.send('Network.emulateNetworkConditions', NETWORK);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    }
    const reqs = new Map();
    cdp.on('Network.responseReceived', (e) => reqs.set(e.requestId, { type: e.type || 'Other', bytes: 0 }));
    cdp.on('Network.loadingFinished', (e) => {
      const r = reqs.get(e.requestId);
      if (r) r.bytes = e.encodedDataLength;
    });
    let resp = null;
    let loadTimedOut = false;
    try {
      resp = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    } catch {
      loadTimedOut = true;
    }
    await page.waitForTimeout(3000);
    const m = await page.evaluate(() => ({
      ...window.__pf,
      dom: document.getElementsByTagName('*').length,
      bodyClass: document.body?.className || '',
      renderBlocking: performance.getEntriesByType('resource').filter((e) => e.renderBlockingStatus === 'blocking').length,
    }));
    const st = parseServerTiming(resp?.headers()['server-timing']);
    const byType = {};
    for (const r of reqs.values()) {
      byType[r.type] ??= { n: 0, kb: 0 };
      byType[r.type].n++;
      byType[r.type].kb += r.bytes / 1024;
    }
    for (const v of Object.values(byType)) v.kb = Math.round(v.kb);
    return {
      url,
      status: resp?.status() ?? null,
      loadTimedOut,
      theme: st.theme,
      processing: st.processing,
      render: st.render,
      templates: m.bodyClass.split(/\s+/).filter((c) => c.startsWith('template-')),
      fcp: m.fcp,
      lcp: m.lcp,
      lcpEl: m.lcpEl,
      tbt: m.longtasks.filter((t) => m.fcp != null && t.s >= m.fcp).reduce((a, t) => a + Math.max(0, t.d - 50), 0),
      cls: clsFromShifts(m.shifts),
      counted: { requests: reqs.size, kb: Math.round([...reqs.values()].reduce((a, r) => a + r.bytes / 1024, 0)), dom: m.dom, renderBlocking: m.renderBlocking, byType },
    };
  } finally {
    await browser.close();
  }
}

/* ── statistics ───────────────────────────────────────────────────────── */

export const median = (v) => {
  const s = [...v].filter((x) => x != null).sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
};

/** Two-sided Mann-Whitney U, normal approximation with tie and continuity correction. */
export function mannWhitney(a, b) {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(all.length);
  let tie = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tie += t ** 3 - t;
    i = j + 1;
  }
  const n1 = a.length;
  const n2 = b.length;
  const N = n1 + n2;
  const R1 = all.reduce((s, x, i) => s + (x.g === 0 ? ranks[i] : 0), 0);
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tie / (N * (N - 1))));
  if (!sigma) return 1;
  const z = Math.max(0, Math.abs(U1 - (n1 * n2) / 2) - 0.5) / sigma;
  const t = 1 / (1 + 0.5 * (z / Math.SQRT2));
  const x = z / Math.SQRT2;
  const erfc = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return Math.min(1, erfc);
}

/** Bootstrap 95% CI of median(B) − median(A). Seeded so a given sample always yields the same CI. */
export function bootstrapCI(a, b, iters = 4000, seed = 12345) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (v) => v[Math.floor(rand() * v.length)];
  const d = [];
  for (let i = 0; i < iters; i++) d.push(median(b.map(() => pick(b))) - median(a.map(() => pick(a))));
  d.sort((x, y) => x - y);
  return [d[Math.floor(iters * 0.025)], d[Math.floor(iters * 0.975)]];
}

/** Practical thresholds: a difference smaller than this doesn't matter to a shopper. */
export const DEFAULT_THRESHOLDS = { lcpPercent: 10, lcpMinMs: 100, fcpPercent: 10, fcpMinMs: 100, tbtPercent: 25, tbtMinMs: 50, clsAbsolute: 0.05 };

export function practicalThreshold(metric, referenceMedian, th = DEFAULT_THRESHOLDS) {
  if (metric === 'cls') return th.clsAbsolute;
  const pct = th[`${metric}Percent`];
  const min = th[`${metric}MinMs`];
  return Math.max((pct / 100) * referenceMedian, min);
}

/**
 * Verdict for one metric, B (current) vs A (reference):
 *   REGRESSED        p ≤ 0.01 and the whole CI is above +threshold
 *   REGRESSED_MINOR  p ≤ 0.01 and the whole CI is above 0, but not above +threshold
 *   IMPROVED / IMPROVED_MINOR  mirror images
 *   UNCHANGED        the whole CI sits inside ±threshold
 *   INCONCLUSIVE     none of the above — sample more
 *   NO_DATA          fewer than 3 valid values on a side
 */
export function verdict(metric, aVals, bVals, th = DEFAULT_THRESHOLDS) {
  const a = aVals.filter((v) => v != null);
  const b = bVals.filter((v) => v != null);
  if (a.length < 3 || b.length < 3) return { metric, verdict: 'NO_DATA', n: [a.length, b.length] };
  const ma = median(a);
  const mb = median(b);
  const threshold = practicalThreshold(metric, ma, th);
  const p = mannWhitney(a, b);
  const [lo, hi] = bootstrapCI(a, b);
  const up = p <= 0.01 && lo > 0;
  const down = p <= 0.01 && hi < 0;
  let v = 'INCONCLUSIVE';
  // Direction certain but the CI straddles the threshold: minor-or-major is still open.
  let magnitudeUncertain = false;
  if (up) {
    v = lo > threshold ? 'REGRESSED' : 'REGRESSED_MINOR';
    magnitudeUncertain = lo <= threshold && hi >= threshold;
  } else if (down) {
    v = hi < -threshold ? 'IMPROVED' : 'IMPROVED_MINOR';
    magnitudeUncertain = hi >= -threshold && lo <= -threshold;
  } else if (lo > -threshold && hi < threshold) v = 'UNCHANGED';
  const settled = v !== 'INCONCLUSIVE' && !magnitudeUncertain;
  return { metric, verdict: v, magnitudeUncertain, settled, medianA: ma, medianB: mb, diff: mb - ma, ci95: [lo, hi], threshold, p: +p.toFixed(4), n: [a.length, b.length], valuesA: a, valuesB: b };
}

/* ── counted (near-deterministic) metrics ────────────────────────────── */

/** Counted metrics, B vs A medians. Returns findings that exceed tolerance. */
export function compareCounted(aRuns, bRuns) {
  const med = (runs, f) => median(runs.map((r) => f(r.counted)));
  const rows = {
    totalKb: [med(aRuns, (c) => c.kb), med(bRuns, (c) => c.kb)],
    requests: [med(aRuns, (c) => c.requests), med(bRuns, (c) => c.requests)],
    scriptKb: [med(aRuns, (c) => c.byType.Script?.kb ?? 0), med(bRuns, (c) => c.byType.Script?.kb ?? 0)],
    cssKb: [med(aRuns, (c) => c.byType.Stylesheet?.kb ?? 0), med(bRuns, (c) => c.byType.Stylesheet?.kb ?? 0)],
    imageKb: [med(aRuns, (c) => c.byType.Image?.kb ?? 0), med(bRuns, (c) => c.byType.Image?.kb ?? 0)],
    fontKb: [med(aRuns, (c) => c.byType.Font?.kb ?? 0), med(bRuns, (c) => c.byType.Font?.kb ?? 0)],
    renderBlocking: [med(aRuns, (c) => c.renderBlocking), med(bRuns, (c) => c.renderBlocking)],
    dom: [med(aRuns, (c) => c.dom), med(bRuns, (c) => c.dom)],
  };
  // Tolerance: [percent, absolute floor, priority]. Both must be exceeded.
  const rules = { totalKb: [10, 100, 'P1'], requests: [10, 10, 'P1'], scriptKb: [10, 50, 'P1'], cssKb: [10, 20, 'P1'], imageKb: [15, 100, 'P2'], fontKb: [10, 20, 'P2'], renderBlocking: [0, 1, 'P1'], dom: [20, 300, 'P2'] };
  const findings = [];
  for (const [key, [a, b]] of Object.entries(rows)) {
    if (a == null || b == null) continue;
    const [pct, floor, priority] = rules[key];
    const d = b - a;
    if (d >= floor && (a === 0 || (d / a) * 100 > pct)) findings.push({ metric: key, reference: a, current: b, change: d, changePct: a ? +((d / a) * 100).toFixed(1) : null, priority });
  }
  return { rows, findings };
}
