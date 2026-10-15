#!/usr/bin/env node
/**
 * perf.test.mjs — regression tests for the perf scan engine and report export.
 *
 * Fixtures are hand-built PageSpeed responses in the Lighthouse 12 "insight"
 * shape (psi-lh12-run*.json) and the older Lighthouse 11 shape (psi-lh11.json).
 * Run: node scripts/__tests__/perf.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { combineRuns, extract, median, rating } from '../lib/extract.mjs';
import { describeUrl, latestScan, reportPath, scanDir } from '../lib/paths.mjs';
import { apiKey, redact, requestUrl, runPsi } from '../lib/psi.mjs';
import { renderScan } from '../lib/render.mjs';
import { parseArgs, scanUrl } from '../psi-scan.mjs';
import { clean, parseMarkdown } from '../md-to-docx.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (n) => JSON.parse(readFileSync(path.join(FIX, n), 'utf-8'));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL — ${name}\n    ${err.message}`);
  }
}

await test('scan folders are per site, theme AND page (home and product scans never collide)', () => {
  const home = describeUrl('https://www.example-store.com/');
  const pdp = describeUrl('https://example-store.com/products/blue-shirt?variant=1');
  const pdpInCollection = describeUrl('https://example-store.com/collections/men/products/blue-shirt');
  const preview = describeUrl('https://example-store.com/collections/men?preview_theme_id=123&view=alt');
  assert.equal(home.site, 'example-store-com');
  assert.equal(home.page, 'home');
  assert.equal(pdp.page, 'product-blue-shirt');
  assert.equal(pdpInCollection.page, 'product-blue-shirt');
  assert.equal(preview.theme, 'preview-123');
  assert.equal(preview.page, 'collection-men-view-alt');
  assert.notEqual(scanDir('/r', 'https://example-store.com/'), scanDir('/r', 'https://example-store.com/products/x'));
});

await test('Lighthouse 12 insight audits are read: LCP element, phases, render-blocking, third parties', () => {
  const e = extract(load('psi-lh12-run1.json'));
  assert.equal(e.lighthouseVersion, '12.8.2');
  assert.equal(e.lcp.node.selector, 'div.hero > img');
  assert.deepEqual(e.lcp.phases.map((p) => p.phase), ['timeToFirstByte', 'resourceLoadDelay']);
  assert.equal(e.sections.renderBlocking.used[0], 'render-blocking-insight');
  assert.equal(e.sections.renderBlocking.audits[0].items[0].wastedMs, 600);
  const tp = e.sections.thirdParties.audits[0].items;
  assert.equal(tp.find((i) => !i.parent).entity, 'Google Tag Manager');
  assert.ok(tp.some((i) => i.parent === 'Google Tag Manager' && i.url.includes('gtm.js')), 'third-party sub-items keep their entity');
  assert.ok(!('TTI' in e.lab) && !('INP' in e.lab), 'no removed or field-only metrics in lab');
});

await test('older Lighthouse 11 audit ids are still read as a fallback', () => {
  const e = extract(load('psi-lh11.json'));
  assert.equal(e.lcp.node.selector, 'img.old');
  assert.equal(e.sections.renderBlocking.used[0], 'render-blocking-resources');
  assert.equal(e.sections.thirdParties.audits[0].items[0].entity, 'Google Tag Manager', 'entity objects are flattened to text');
  assert.ok(e.missingSections.includes('imageDelivery'));
});

await test('field data falls back to the origin and the Core Web Vitals verdict comes only from it', () => {
  const e = extract(load('psi-lh12-run1.json'));
  assert.equal(e.field.best.originFallback, true);
  assert.equal(e.field.best.cwvPassed, false, 'LCP is AVERAGE, so CWV fails');
  assert.equal(e.field.best.metrics.CLS.p75, 0.05, 'CLS percentile is divided by 100');
  assert.equal(e.field.best.metrics.INP.rating, 'Good');
});

await test('three runs → median scores and metrics, details from the median run', () => {
  const runs = ['psi-lh12-run1.json', 'psi-lh12-run2.json', 'psi-lh12-run3.json'].map((f) => extract(load(f)));
  const c = combineRuns(runs);
  assert.equal(c.scores.performance.value, 42);
  assert.equal(c.scores.performance.min, 38);
  assert.equal(c.lab.LCP.value, 5200);
  assert.equal(c.lab.TBT.value, 780);
  assert.equal(c.medianRun, 0);
  assert.equal(median([3, 1, 2, null]), 2);
  assert.equal(rating(0.95), 'Good');
  assert.equal(rating(0.75), 'Needs improvement', 'CLS uses the same 0.9 / 0.5 bands as every metric');
});

await test('scan.md: Mobile before Desktop, missing sections said out loud, origin field data labelled', () => {
  const m = extract(load('psi-lh12-run1.json'));
  const d = extract(load('psi-lh11.json'));
  const summary = { meta: { url: 'https://example-store.com/', siteHost: 'example-store.com', page: 'home', pageType: 'Homepage', theme: 'live', date: '2026-10-15', runs: 1 }, devices: { mobile: { median: m, combined: combineRuns([m]) }, desktop: { median: d, combined: combineRuns([d]) } } };
  const md = renderScan(summary);
  assert.ok(md.indexOf('| Category | Mobile | Desktop |') > -1);
  assert.match(md, /whole site \(origin\)/);
  assert.match(md, /Core Web Vitals assessment: FAILED/);
  assert.match(md, /Not reported by this Lighthouse version \(looked for: image-delivery-insight/);
  assert.match(md, /div\.hero > img/);
  assert.match(md, /Background and foreground colors/);
});

await test('API key: env first, then .buildspace/.psi-key, and never printed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perf-'));
  assert.deepEqual(apiKey(root, {}), { key: null, source: null });
  assert.equal(apiKey(root, { PAGESPEED_API_KEY: ' abc ' }).key, 'abc');
  assert.equal(redact('bad key AIzaSECRET in url', 'AIzaSECRET'), 'bad key *** in url');
  const u = new URL(requestUrl('https://s.com/?a=1&b=2', 'mobile', 'K'));
  assert.equal(u.searchParams.get('url'), 'https://s.com/?a=1&b=2');
  assert.deepEqual(u.searchParams.getAll('category'), ['performance', 'accessibility', 'best-practices', 'seo']);
  rmSync(root, { recursive: true, force: true });
});

await test('a failing PSI call retries, then reports the error without the key', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'Quota exceeded for key SECRETKEY' } }), { status: 429 });
  };
  const sleep = global.setTimeout;
  global.setTimeout = (fn) => sleep(fn, 0);
  const r = await runPsi('https://s.com/', 'mobile', { key: 'SECRETKEY', attempts: 2, fetchImpl });
  global.setTimeout = sleep;
  assert.equal(r.ok, false);
  assert.equal(calls, 2);
  assert.ok(!r.error.includes('SECRETKEY'));
});

await test('psi-scan end to end with a fake PSI: folder, summary.json, scan.md, latest lookup', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perf-'));
  const responses = ['psi-lh12-run1.json', 'psi-lh12-run2.json'];
  let i = 0;
  const realFetch = global.fetch;
  global.fetch = async () => new Response(readFileSync(path.join(FIX, responses[i++ % 2]), 'utf-8'), { status: 200 });
  try {
    const r = await scanUrl('https://example-store.com/', { root, runs: 2, strategies: ['mobile'], key: null });
    assert.equal(r.ok, true);
    assert.equal(r.performance.mobile, 49);
    assert.equal(r.fieldCwv.mobile, false);
    assert.ok(latestScan(root, 'https://example-store.com/').endsWith(path.basename(r.dir)));
    assert.equal(latestScan(root, 'https://example-store.com/products/x'), null, 'a product page never picks up the homepage scan');
    assert.match(readFileSync(path.join(root, r.scanMd), 'utf-8'), /median of 2 runs/);
  } finally {
    global.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

await test('argument parsing rejects typos and bad values', () => {
  assert.match(parseArgs(['--url', 'https://s.com', '--run', '3']).error, /Unknown argument/);
  assert.match(parseArgs(['--url', 'nope']).error, /Not a valid URL/);
  assert.match(parseArgs(['--url', 'https://s.com', '--runs', '0']).error, /--runs/);
  assert.deepEqual(parseArgs(['https://s.com']).urls, ['https://s.com']);
});

await test('report names carry kind, page and date and never overwrite', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perf-'));
  const p = reportPath(root, 'example-store-com', 'client-audit', 'home', new Date('2026-10-15T10:00:00'));
  assert.ok(p.endsWith(path.join('reports', 'example-store-com', 'client-audit-home-2026-10-15.md')));
  rmSync(root, { recursive: true, force: true });
});

await test('markdown → docx blocks: headings, tables, lists, quotes; no em dashes left', () => {
  const { title, blocks } = parseMarkdown('# Site – Audit\n\n## 1. Overview\nLine one\nline two.\n\n| A | B |\n|---|---|\n| 1 | x \\| y |\n\n- [ ] item\n  - sub\n1. first\n\n> note — here\n');
  assert.equal(title, 'Site – Audit');
  assert.deepEqual(blocks.map((b) => b.type), ['h1', 'p', 'table', 'li', 'li', 'li', 'quote']);
  assert.equal(blocks[1].text, 'Line one line two.');
  assert.deepEqual(blocks[2].rows[0], ['1', 'x \\| y']);
  assert.equal(blocks[3].text, 'item');
  assert.equal(blocks[4].level, 1);
  assert.equal(clean('a — b—c'), 'a, b-c');
});

console.log(`\n${passed}/${passed + failures.length} passed.`);
if (failures.length) process.exitCode = 1;
