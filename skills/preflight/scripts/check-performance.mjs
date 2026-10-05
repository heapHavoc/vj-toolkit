#!/usr/bin/env node
/**
 * check-performance.mjs — /preflight performance checker.
 *
 * Measures with the A/B engine in lib/abtest.mjs (real throttling, both themes
 * through Shopify's preview path, warm-up, per-run theme + template proof,
 * sequential sampling with Mann-Whitney + bootstrap CI). Lighthouse is used only
 * to DIAGNOSE a non-passing page (one run per side, insights only) — never for a
 * verdict. See lib/abtest.mjs for why each rule exists.
 *
 * Usage:
 *   node check-performance.mjs --root . --config <cfg> --mode pre-merge --plan <plan.json>
 *   node check-performance.mjs --root . --config <cfg> --mode pre-merge --live-url <u> --preview-url <u> [--page-name n]
 *   node check-performance.mjs --root . --config <cfg> --mode baseline|post-merge --plan <plan.json> [--baseline-file f]
 *
 * plan.json (written by run-preflight.mjs):
 *   { store, liveThemeId, previewThemeId,
 *     pages: [{ name, path, liveView, previewView, liveTemplate, previewTemplate, tier: 'timing'|'counted', reasons }] }
 *
 * Tiers: 'timing' pages get the full sequential A/B (minRuns → maxRuns per side);
 * 'counted' pages get countedRuns unthrottled loads per side and are judged on
 * near-deterministic counts only (bytes, requests, render-blocking, DOM).
 *
 * Prints one JSON object to stdout. Exits non-zero on any P0 FAIL. A missing
 * dependency, unreachable URL or identity mismatch is SKIPPED with a reason —
 * never a silent pass and never a fabricated red.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLD_MS, DEFAULT_THRESHOLDS, compareCounted, loadPlaywright, measureLoad, median, previewPathUrl, probe, resolvePreview, templateClass, verdict } from './lib/abtest.mjs';

const require = createRequire(import.meta.url);

/* ── CLI / config ─────────────────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback = null) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  const getAll = (flag) => args.flatMap((a, i) => (a === flag && i + 1 < args.length ? [args[i + 1]] : []));
  return {
    root: path.resolve(get('--root', '.')),
    config: get('--config', '.buildspace/preflight/preflight.config.json'),
    mode: get('--mode', 'pre-merge'),
    plan: get('--plan'),
    liveUrls: getAll('--live-url'),
    previewUrls: getAll('--preview-url'),
    pageNames: getAll('--page-name'),
    baselineFile: get('--baseline-file'),
    artifactsDir: get('--artifacts-dir'),
  };
}

function loadJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

class Checks {
  constructor() {
    this.checks = [];
  }
  push(id, name, priority, status, summary, evidence = {}, risk = '') {
    this.checks.push({ id, name, priority, status, summary, evidence, risk });
  }
  summary() {
    const s = { pass: 0, fail: 0, skipped: 0, p0Fail: 0, p1Fail: 0 };
    for (const c of this.checks) {
      if (c.status === 'PASS') s.pass++;
      else if (c.status === 'SKIPPED') s.skipped++;
      else if (c.status === 'FAIL') {
        s.fail++;
        if (c.priority === 'P0') s.p0Fail++;
        if (c.priority === 'P1') s.p1Fail++;
      }
    }
    return s;
  }
}

const log = (...a) => console.error('[check-performance]', ...a);

/* ── CPU calibration ──────────────────────────────────────────────────── */

/**
 * Lighthouse's own CPU benchmark (benchmarkIndex), run in a throwaway page. The
 * slowdown targets a mid-tier phone (~460 on this scale), so a fast laptop
 * (~4000) gets ~9x and a CI box (~1500) ~3x — both sides always share one rate.
 */
async function calibrateCpu(playwright) {
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const samples = [];
    for (let i = 0; i < 3; i++) {
      samples.push(
        await page.evaluate(() => {
          const start = Date.now();
          let iterations = 0;
          while (Date.now() - start < 500) {
            let s = '';
            for (let j = 0; j < 100000; j++) s += 'a';
            if (s.length === 1) throw new Error('unreachable');
            iterations++;
          }
          return Math.round(iterations / ((Date.now() - start) / 1000));
        })
      );
    }
    const bench = median(samples);
    return { benchmarkIndex: bench, cpuRate: Math.min(20, Math.max(1, Math.round(bench / 460))) };
  } finally {
    await browser.close();
  }
}

/* ── per-page measurement ─────────────────────────────────────────────── */

const METRICS = ['lcp', 'fcp', 'tbt', 'cls'];
const LABEL = { lcp: 'LCP', fcp: 'FCP', tbt: 'TBT', cls: 'CLS' };
const RISK = {
  lcp: 'Slower largest-contentful-paint directly hurts perceived load speed and Core Web Vitals ranking.',
  fcp: 'A later first paint makes the page feel slower to start; it is not a Core Web Vital, so it gates at P1.',
  tbt: 'More main-thread blocking delays interactivity — taps feel unresponsive (lab proxy for INP).',
  cls: 'Layout shift regressions cause visible content jumping and hurt Core Web Vitals.',
};
/** Priority by verdict: [REGRESSED, REGRESSED_MINOR, INCONCLUSIVE/NO_DATA (emitted as SKIPPED)] */
const PRIORITY = { lcp: ['P0', 'P1', 'P0'], cls: ['P0', 'P1', 'P0'], tbt: ['P0', 'P1', 'P0'], fcp: ['P1', 'P2', 'P1'] };

/** A splash/loading-overlay image as LCP isn't the page's real LCP — void that run's LCP only. */
function lcpIgnored(run, ignore) {
  return Boolean(run.lcpEl && ignore.some((s) => run.lcpEl.includes(s.replace(/^\./, ''))));
}

/** Why a run can't count. Theme/template/HTTP/cold-render make it invalid. */
function validate(run, side, { allowCold = false } = {}) {
  const reasons = [];
  if (String(run.theme) !== String(side.themeId)) reasons.push(`theme ${run.theme} ≠ expected ${side.themeId}`);
  if (side.template && !run.templates.includes(templateClass(side.template))) reasons.push(`template ${run.templates.join(' ') || 'none'} ≠ ${templateClass(side.template)}`);
  if (run.status == null || run.status >= 400) reasons.push(`HTTP ${run.status}`);
  if (!allowCold && run.processing != null && run.processing > COLD_MS) reasons.push(`cold server render (processing ${run.processing}ms)`);
  if (run.fcp == null) reasons.push('no FCP recorded');
  return reasons;
}

/** Prove both sides render what the plan says, before spending any time measuring. */
async function identityCheck(sides) {
  const probes = {};
  const problems = [];
  for (const k of ['a', 'b']) {
    const p = await probe(sides[k].url).catch((e) => ({ status: null, error: e.message, templates: [] }));
    probes[k] = p;
    if (String(p.theme) !== String(sides[k].themeId)) problems.push(`${sides[k].label}: rendered theme ${p.theme ?? 'unknown'}, expected ${sides[k].themeId}`);
    if (sides[k].template && !p.templates.includes(templateClass(sides[k].template))) problems.push(`${sides[k].label}: rendered ${p.templates.join(' ') || 'no template class'}, expected ${templateClass(sides[k].template)}`);
    if (p.status == null || p.status >= 400) problems.push(`${sides[k].label}: HTTP ${p.status}${p.error ? ` (${p.error})` : ''}`);
  }
  if (String(sides.a.themeId) === String(sides.b.themeId)) problems.push('both sides are the same theme — nothing to compare');
  return { probes, problems };
}

/** Unthrottled, unmeasured loads until Shopify's server render cache is warm. */
async function warmUp(playwright, side, warmups) {
  const seen = [];
  for (let i = 0; i < warmups + 3; i++) {
    const w = await measureLoad(playwright, side, { throttle: false });
    seen.push(w.processing);
    if (i + 1 >= warmups && (w.processing == null || w.processing <= COLD_MS)) break;
  }
  return seen;
}

/** Sequential A/B: alternate sides, evaluate, double the sample while any gated metric is unsettled. */
async function abTiming(playwright, sides, opts) {
  const runs = { a: [], b: [] };
  const excluded = [];
  const valid = (k) => runs[k].filter((r) => r.valid);
  const values = (k, m) => valid(k).map((r) => (m === 'lcp' && r.lcpVoid ? null : r[m]));
  const roundCap = opts.maxRuns * 3; // bounds the loop if a side keeps producing invalid runs
  let target = opts.minRuns;
  let round = 0;
  let results;
  for (;;) {
    while ((valid('a').length < target || valid('b').length < target) && round < roundCap) {
      round++;
      for (const k of round % 2 ? ['a', 'b'] : ['b', 'a']) {
        if (valid(k).length >= target) continue;
        const r = await measureLoad(playwright, sides[k], { cpuRate: opts.cpuRate });
        r.reasons = validate(r, sides[k]);
        r.valid = r.reasons.length === 0;
        r.lcpVoid = lcpIgnored(r, opts.ignoreLcpSelectors);
        runs[k].push(r);
        if (!r.valid) excluded.push({ side: sides[k].label, round, reasons: r.reasons });
        log(`${opts.page} r${round} ${k} ${r.valid ? 'ok ' : 'EXC'} FCP ${Math.round(r.fcp)} LCP ${Math.round(r.lcp)}${r.lcpVoid ? '(void)' : ''} TBT ${Math.round(r.tbt)} CLS ${r.cls.toFixed(3)} srv ${r.processing}ms ${r.reasons.join('; ')}`);
      }
    }
    results = Object.fromEntries(METRICS.map((m) => [m, verdict(m, values('a', m), values('b', m), opts.thresholds)]));
    const unsettled = METRICS.filter((m) => !results[m].settled && results[m].verdict !== 'NO_DATA');
    if (unsettled.length === 0 || target >= opts.maxRuns || round >= roundCap) break;
    target = Math.min(opts.maxRuns, target * 2);
    log(`${opts.page}: unsettled ${unsettled.join(', ')} → extending to ${target} runs per side`);
  }
  const voided = { a: runs.a.filter((r) => r.valid && r.lcpVoid).length, b: runs.b.filter((r) => r.valid && r.lcpVoid).length };
  return { runs, excluded, results, voided, rounds: round };
}

/** Counted-only tier: a few unthrottled loads per side; counts don't depend on throttling. */
async function abCounted(playwright, sides, opts) {
  const runs = { a: [], b: [] };
  const excluded = [];
  for (let i = 0; i < opts.countedRuns; i++) {
    for (const k of i % 2 ? ['b', 'a'] : ['a', 'b']) {
      const r = await measureLoad(playwright, sides[k], { throttle: false });
      r.reasons = validate(r, sides[k], { allowCold: true });
      r.valid = r.reasons.length === 0;
      runs[k].push(r);
      if (!r.valid) excluded.push({ side: sides[k].label, reasons: r.reasons });
    }
  }
  return { runs, excluded };
}

/* ── Lighthouse diagnosis (explains, never decides) ───────────────────── */

function resolvePackage(name) {
  try {
    const mod = require(name);
    return mod && typeof mod === 'object' && typeof mod.default === 'function' ? mod.default : mod;
  } catch {
    return null;
  }
}

/** Lighthouse 13 insight audits — the attribution a verifier traces back to code. */
function insightSummary(lhr) {
  const a = lhr.audits;
  const node = (x, d = 0) => {
    if (!x || typeof x !== 'object' || d > 7) return null;
    if (x.type === 'node' && x.selector) return x;
    if (x.node?.selector) return x.node;
    for (const v of Array.isArray(x) ? x : Object.values(x)) {
      const n = node(v, d + 1);
      if (n) return n;
    }
    return null;
  };
  const lcpTable = (a['lcp-breakdown-insight']?.details?.items || []).find((i) => i.type === 'table');
  return {
    lcpElement: node(a['lcp-breakdown-insight']?.details)?.selector || null,
    lcpPhasesMs: Object.fromEntries((lcpTable?.items || []).map((i) => [i.subpart, Math.round(i.duration)])),
    clsCulprits: (a['cls-culprits-insight']?.details?.items?.[0]?.items || []).filter((i) => i.node?.type === 'node').slice(0, 5).map((i) => ({ element: i.node.selector, score: +(+i.score).toFixed(4) })),
    renderBlocking: (a['render-blocking-insight']?.details?.items || []).slice(0, 8).map((i) => i.url),
    documentLatency: a['document-latency-insight']?.details?.items?.[0] || null,
    warnings: lhr.runWarnings,
  };
}

async function diagnose(sides) {
  const lighthouse = resolvePackage('lighthouse');
  const chromeLauncher = resolvePackage('chrome-launcher');
  if (!lighthouse || !chromeLauncher) return { error: 'lighthouse/chrome-launcher unavailable' };
  const out = {};
  for (const k of ['a', 'b']) {
    let url = sides[k].url;
    let headers;
    if (sides[k].viaPreviewCookie) {
      const resolved = await resolvePreview(url);
      url = resolved.finalUrl;
      if (resolved.cookie) headers = { Cookie: resolved.cookie };
    }
    const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'] });
    try {
      const { lhr } = await lighthouse(url, { port: chrome.port, onlyCategories: ['performance'], formFactor: 'mobile', screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 2.625, disabled: false }, throttlingMethod: 'simulate', extraHeaders: headers });
      out[sides[k].label] = insightSummary(lhr);
    } catch (err) {
      out[sides[k].label] = { error: err.message.split('\n')[0] };
    } finally {
      await chrome.kill();
    }
  }
  return { note: 'One Lighthouse run per side, for attribution only — its timings are not used for any verdict.', ...out };
}

/* ── emitting checks ──────────────────────────────────────────────────── */

const fmt = (m, v) => (v == null ? 'n/a' : m === 'cls' ? v.toFixed(3) : `${Math.round(v)}ms`);

function emitTiming(checks, page, r, ctx) {
  for (const m of METRICS) {
    const v = r.results[m];
    const id = `PERF-${page.name}-${LABEL[m]}`;
    const name = `${LABEL[m]}: ${page.name}`;
    const [pReg, pMinor, pSkip] = PRIORITY[m];
    const evidence = {
      verdict: v.verdict,
      magnitudeUncertain: v.magnitudeUncertain,
      reference: ctx.labels.a,
      current: ctx.labels.b,
      medianReference: v.medianA,
      medianCurrent: v.medianB,
      diff: v.diff,
      ci95: v.ci95,
      threshold: v.threshold,
      p: v.p,
      n: v.n,
      runs: { [ctx.labels.a]: v.valuesA, [ctx.labels.b]: v.valuesB },
      ...(m === 'lcp' ? { lcpElements: { [ctx.labels.a]: [...new Set(r.runs.a.map((x) => x.lcpEl))], [ctx.labels.b]: [...new Set(r.runs.b.map((x) => x.lcpEl))] }, lcpVoidedRuns: r.voided } : {}),
      excludedRuns: r.excluded,
      diagnosis: ctx.diagnosis || undefined,
    };
    const what = `${ctx.labels.a} ${fmt(m, v.medianA)} → ${ctx.labels.b} ${fmt(m, v.medianB)} (Δ ${fmt(m, v.diff)}, 95% CI ${fmt(m, v.ci95?.[0])}…${fmt(m, v.ci95?.[1])}, threshold ±${fmt(m, v.threshold)}, p=${v.p}, n=${v.n?.join('/')})`;
    if (v.verdict === 'REGRESSED') checks.push(id, name, pReg, 'FAIL', `${LABEL[m]} regressed: ${what}.`, evidence, RISK[m]);
    else if (v.verdict === 'REGRESSED_MINOR') checks.push(id, name, pMinor, 'FAIL', `${LABEL[m]} regressed${v.magnitudeUncertain ? ' (size uncertain — may exceed the threshold)' : ' by less than the practical threshold'}: ${what}.`, evidence, RISK[m]);
    else if (v.verdict === 'INCONCLUSIVE') checks.push(id, name, pSkip, 'SKIPPED', `${LABEL[m]} inconclusive after ${v.n?.join('/')} runs — the data can neither confirm nor rule out a regression: ${what}.`, evidence);
    else if (v.verdict === 'NO_DATA') checks.push(id, name, pSkip, 'SKIPPED', `${LABEL[m]}: too few valid runs (${v.n?.join('/')}) — see excluded/voided runs.`, evidence);
    else checks.push(id, name, 'P0', 'PASS', `${LABEL[m]} ${v.verdict.toLowerCase().replace('_', ' ')}: ${what}.`, evidence);
  }
}

function emitCounted(checks, page, runs, excluded, ctx) {
  const A = runs.a.filter((r) => r.valid);
  const B = runs.b.filter((r) => r.valid);
  const id = `PERF-${page.name}-COUNTED`;
  const name = `Bytes, requests & DOM: ${page.name}`;
  if (A.length === 0 || B.length === 0) {
    checks.push(id, name, 'P1', 'SKIPPED', `No valid runs on ${A.length ? ctx.labels.b : ctx.labels.a} — see excluded runs.`, { excludedRuns: excluded });
    return;
  }
  const { rows, findings } = compareCounted(A, B);
  const table = Object.fromEntries(Object.entries(rows).map(([k, [a, b]]) => [k, { [ctx.labels.a]: a, [ctx.labels.b]: b }]));
  const line = Object.entries(rows).map(([k, [a, b]]) => `${k} ${a}→${b}`).join(', ');
  if (findings.length === 0) {
    checks.push(id, name, 'P1', 'PASS', `No counted metric grew beyond tolerance (${line}).`, { table, runs: [A.length, B.length] });
    return;
  }
  const worst = findings.some((f) => f.priority === 'P1') ? 'P1' : 'P2';
  checks.push(id, name, worst, 'FAIL', `${findings.length} counted metric(s) grew beyond tolerance: ${findings.map((f) => `${f.metric} ${f.reference}→${f.current} (+${f.changePct ?? '∞'}%)`).join(', ')}.`, { findings, table, runs: [A.length, B.length] }, 'More bytes, requests or render-blocking resources make every load slower for every shopper — these counts barely vary between runs, so a change here is real.');
}

/* ── plan from explicit URLs ──────────────────────────────────────────── */

/** --live-url/--preview-url pairs: identify both themes by probing; path and views from the URLs. */
async function planFromUrls(args, config) {
  const pages = [];
  let liveThemeId = config?.themes?.live?.themeId || null;
  let previewThemeId = config?.themes?.preview?.themeId || null;
  let store = config?.store || null;
  const strip = (u) => {
    const c = new URL(u);
    for (const p of ['preview_theme_id', 'pb', 'view', '_fd', '_ab']) c.searchParams.delete(p);
    return c.pathname + c.search;
  };
  for (let i = 0; i < args.liveUrls.length; i++) {
    const live = new URL(args.liveUrls[i]);
    const prev = new URL(args.previewUrls[i]);
    store = live.host;
    if (!liveThemeId) liveThemeId = (await probe(args.liveUrls[i])).theme;
    if (!previewThemeId) previewThemeId = prev.searchParams.get('preview_theme_id') || (await probe(args.previewUrls[i])).theme;
    pages.push({ name: args.pageNames[i] || `page-${i + 1}`, path: strip(args.liveUrls[i]), liveView: live.searchParams.get('view'), previewView: prev.searchParams.get('view'), tier: 'timing', reasons: ['explicit --live-url/--preview-url'] });
  }
  return { store, liveThemeId, previewThemeId, pages };
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs();
  const checks = new Checks();
  const startedAt = new Date().toISOString();
  const config = loadJson(path.isAbsolute(args.config) ? args.config : path.join(args.root, args.config));
  const perf = config?.performance || {};
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(perf.thresholds || {}) };
  const opts = {
    minRuns: perf.minRuns ?? 10,
    maxRuns: perf.maxRuns ?? 20,
    warmups: perf.warmups ?? 3,
    countedRuns: perf.countedRuns ?? 3,
    thresholds,
    ignoreLcpSelectors: perf.ignoreLcpSelectors || [],
  };
  const emit = (context, extra = {}) => console.log(JSON.stringify({ checker: 'performance', mode: args.mode, startedAt, context, checks: checks.checks, summary: checks.summary(), ...extra }, null, 2));

  let plan = args.plan ? loadJson(args.plan) : null;
  if (!plan && args.liveUrls.length > 0) {
    if (args.mode === 'pre-merge' && args.liveUrls.length !== args.previewUrls.length) {
      checks.push('PERF-URL', 'URL resolution', 'P0', 'SKIPPED', `${args.liveUrls.length} --live-url but ${args.previewUrls.length} --preview-url — provide one preview URL per live URL.`);
      emit({});
      return;
    }
    plan = await planFromUrls(args, config);
  }
  if (!plan || !plan.pages?.length) {
    checks.push('PERF-CONFIG', 'Page plan', 'P0', 'SKIPPED', 'No pages to measure — run-preflight.mjs passes a --plan built from config.pages; otherwise pass --live-url/--preview-url.');
    emit({});
    return;
  }

  const playwright = loadPlaywright();
  if (!playwright) {
    checks.push('PERF-DEPS', 'Browser availability', 'P0', 'SKIPPED', 'Playwright could not be loaded — run npm install in the preflight scripts directory.');
    emit({ store: plan.store });
    return;
  }

  const calib = perf.cpuRate ? { benchmarkIndex: null, cpuRate: perf.cpuRate } : await calibrateCpu(playwright);
  opts.cpuRate = calib.cpuRate;
  const artifactsDir = args.artifactsDir || path.join(args.root, '.buildspace', 'preflight', 'artifacts', 'performance');
  mkdirSync(artifactsDir, { recursive: true });
  const context = {
    method: 'A/B with real throttling (CDP 150ms RTT, 1.6/0.75 Mbps, calibrated CPU slowdown); both themes via the preview path; warm-up; per-run theme + template proof; sequential Mann-Whitney U + bootstrap 95% CI of the median difference',
    ...calib,
    opts,
    store: plan.store,
    liveThemeId: plan.liveThemeId,
    previewThemeId: plan.previewThemeId,
    pages: [],
  };
  log(`CPU benchmark ${calib.benchmarkIndex ?? 'n/a (config.performance.cpuRate)'} → ${calib.cpuRate}x slowdown`);

  /* ── baseline / post-merge: the published theme over time (time axis) ── */
  if (args.mode === 'baseline' || args.mode === 'post-merge') {
    const published = (await probe(`https://${plan.store}/`).catch(() => ({}))).theme || plan.liveThemeId;
    let baseline = null;
    if (args.mode === 'post-merge') {
      baseline = args.baselineFile && existsSync(args.baselineFile) ? loadJson(args.baselineFile)?.performance?.snapshot : null;
      if (!baseline?.pages) {
        checks.push('PERF-BASELINE', 'Baseline availability', 'P0', 'SKIPPED', 'No performance baseline found — run `/preflight --mode baseline` after a known-good release first.');
        emit(context);
        return;
      }
    }
    const snapshot = { generatedAt: new Date().toISOString(), themeId: published, cpuRate: opts.cpuRate, pages: {} };
    for (const page of plan.pages) {
      const side = { label: 'live', url: previewPathUrl(plan.store, page.path, published, page.liveView), themeId: published, template: page.liveTemplate, viaPreviewCookie: true };
      await warmUp(playwright, side, opts.warmups);
      const runs = [];
      for (let i = 0; i < opts.minRuns * 2 && runs.length < opts.minRuns; i++) {
        const r = await measureLoad(playwright, side, { cpuRate: opts.cpuRate });
        if (validate(r, side).length === 0) runs.push(r);
      }
      const values = Object.fromEntries(METRICS.map((m) => [m, runs.map((r) => (m === 'lcp' && lcpIgnored(r, opts.ignoreLcpSelectors) ? null : r[m])).filter((v) => v != null)]));
      context.pages.push({ name: page.name, validRuns: runs.length });
      if (args.mode === 'baseline') {
        snapshot.pages[page.name] = { values, counted: runs.map((r) => r.counted) };
        checks.push(`PERF-${page.name}`, `Performance baseline: ${page.name}`, 'info', 'INFO', `Captured ${runs.length} valid run(s) for "${page.name}" on theme ${published}.`, { medians: Object.fromEntries(Object.entries(values).map(([m, v]) => [m, median(v)])) });
        continue;
      }
      const ref = baseline.pages[page.name];
      if (!ref) {
        checks.push(`PERF-${page.name}`, `Performance: ${page.name}`, 'P1', 'SKIPPED', `No baseline samples for "${page.name}" — re-run --mode baseline to include it.`);
        continue;
      }
      if (baseline.cpuRate && baseline.cpuRate !== opts.cpuRate) context.warning = `CPU slowdown differs from the baseline (${baseline.cpuRate}x then, ${opts.cpuRate}x now) — set config.performance.cpuRate to compare like with like.`;
      const results = Object.fromEntries(METRICS.map((m) => [m, verdict(m, ref.values[m] || [], values[m], thresholds)]));
      emitTiming(checks, page, { results, runs: { a: [], b: runs }, excluded: [], voided: { a: 0, b: 0 } }, { labels: { a: 'baseline', b: 'live now' } });
      emitCounted(checks, page, { a: (ref.counted || []).map((c) => ({ valid: true, counted: c })), b: runs.map((r) => ({ valid: true, counted: r.counted })) }, [], { labels: { a: 'baseline', b: 'live now' } });
    }
    emit(context, args.mode === 'baseline' ? { snapshot } : {});
    process.exitCode = args.mode === 'post-merge' && checks.summary().p0Fail > 0 ? 1 : 0;
    return;
  }

  /* ── pre-merge: live theme vs preview theme, both via the preview path ── */
  if (!plan.liveThemeId || !plan.previewThemeId) {
    checks.push('PERF-THEMES', 'Theme ids', 'P0', 'SKIPPED', `Both theme ids are required (live ${plan.liveThemeId ?? 'missing'}, preview ${plan.previewThemeId ?? 'missing'}) — set config.themes.live.themeId and config.themes.preview.themeId.`);
    emit(context);
    return;
  }
  const labels = { a: 'live theme', b: 'preview theme' };

  for (const page of plan.pages) {
    const sides = {
      a: { label: labels.a, url: previewPathUrl(plan.store, page.path, plan.liveThemeId, page.liveView), themeId: plan.liveThemeId, template: page.liveTemplate, viaPreviewCookie: true },
      b: { label: labels.b, url: previewPathUrl(plan.store, page.path, plan.previewThemeId, page.previewView), themeId: plan.previewThemeId, template: page.previewTemplate, viaPreviewCookie: true },
    };
    const pageCtx = { name: page.name, tier: page.tier, reasons: page.reasons, urls: { [labels.a]: sides.a.url, [labels.b]: sides.b.url }, templates: { [labels.a]: page.liveTemplate || '(not asserted)', [labels.b]: page.previewTemplate || '(not asserted)' } };
    context.pages.push(pageCtx);
    log(`page ${page.name} (${page.tier})`);

    const id = await identityCheck(sides);
    pageCtx.identity = id.probes;
    if (id.problems.length) {
      checks.push(`PERF-${page.name}-IDENTITY`, `Measured theme & template: ${page.name}`, 'P0', 'SKIPPED', `Not measured — the URLs don't render what the plan expects: ${id.problems.join('; ')}.`, { probes: id.probes });
      continue;
    }
    checks.push(`PERF-${page.name}-IDENTITY`, `Measured theme & template: ${page.name}`, 'P0', 'PASS', `${labels.a} renders theme ${id.probes.a.theme} (${id.probes.a.templates.join(' ')}); ${labels.b} renders theme ${id.probes.b.theme} (${id.probes.b.templates.join(' ')}). Re-checked on every run.`, { probes: id.probes });

    pageCtx.warmupProcessingMs = { [labels.a]: await warmUp(playwright, sides.a, opts.warmups), [labels.b]: await warmUp(playwright, sides.b, opts.warmups) };

    if (page.tier === 'timing') {
      const r = await abTiming(playwright, sides, { ...opts, page: page.name });
      const needsDiagnosis = Object.values(r.results).some((v) => ['REGRESSED', 'REGRESSED_MINOR', 'INCONCLUSIVE'].includes(v.verdict));
      const diagnosis = needsDiagnosis ? await diagnose(sides).catch((e) => ({ error: e.message })) : null;
      emitTiming(checks, page, r, { labels, diagnosis });
      emitCounted(checks, page, r.runs, r.excluded, { labels });
      pageCtx.validRuns = { [labels.a]: r.runs.a.filter((x) => x.valid).length, [labels.b]: r.runs.b.filter((x) => x.valid).length };
      pageCtx.excludedRuns = r.excluded.length;
      writeFileSync(path.join(artifactsDir, `${page.name}-runs.json`), JSON.stringify({ sides, runs: r.runs, excluded: r.excluded, results: r.results, diagnosis }, null, 1));
    } else {
      const r = await abCounted(playwright, sides, opts);
      emitCounted(checks, page, r.runs, r.excluded, { labels });
      pageCtx.validRuns = { [labels.a]: r.runs.a.filter((x) => x.valid).length, [labels.b]: r.runs.b.filter((x) => x.valid).length };
    }
  }

  emit(context);
  process.exitCode = checks.summary().p0Fail > 0 ? 1 : 0;
}

function isRunDirectly() {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch((err) => {
    console.log(JSON.stringify({ checker: 'performance', startedAt: new Date().toISOString(), context: {}, checks: [], summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 }, error: `Unhandled error: ${err.stack || err.message}` }));
    process.exitCode = 1;
  });
}
