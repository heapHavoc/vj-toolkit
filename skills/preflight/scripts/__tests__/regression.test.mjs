#!/usr/bin/env node
/**
 * regression.test.mjs — guards against the production incidents documented
 * in README.md's "hard-won correctness rules":
 *
 *   #6  a crashed checker must never resolve to GREEN
 *   #8  a >64KB checker payload must never get truncated and lost
 *   #9  an empty diff is untested (G0), never GREEN
 *   #10 a layer where nothing was tested is INCOMPLETE
 *   #11 unknown flags are rejected; --help runs nothing
 *   #12 verifier merge rules — no evidence-free dismissals, missing = unverified
 *   #13 context-aware code rules (the false alarms from the first real run)
 *   #14 analytics steps that didn't run make dependent checks SKIPPED
 *   #15 performance A/B statistics: regressions found, noise and two-mode data never called regressions
 *
 * No test framework — plain Node assertions, run with:
 *   node scripts/__tests__/regression.test.mjs
 * Exits non-zero (and prints which assertion failed) if anything regresses.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecker, layerStatus, overallStatus, parseArgs } from '../run-preflight.mjs';
import { applyDecisions, buildWorklist, mergeVerifications } from '../lib/verdict.mjs';
import { STANDARDS_RULES, classifyPlaceholder, findCssCollisions, parseCssRules, ruleHits } from '../lib/code-rules.mjs';
import { selectPages } from '../lib/page-map.mjs';
import { verdict, mannWhitney, compareCounted, clsFromShifts, previewPathUrl, parseServerTiming } from '../lib/abtest.mjs';
import { evaluateAnalytics, resolveJourneys, stepUrl, resolveSide } from '../check-analytics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, '..');

// runChecker() resolves its `script` argument as path.join(SCRIPT_DIR, script) — i.e. relative
// to scripts/, exactly like the real CHECKERS entries ('check-code.mjs', etc). A temp file
// under the OS tmpdir (an absolute path) does NOT work here: path.join doesn't special-case an
// absolute second argument, it just concatenates, producing a path that never exists. So the
// fake checker must live under scripts/__tests__/.tmp/ and be referenced by its path relative
// to scripts/, not by its absolute path.
const TMP_ROOT = path.join(__dirname, '.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

function makeTempScript(content) {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'checker-'));
  const file = path.join(dir, 'fake-checker.mjs');
  writeFileSync(file, content);
  return { dir, relativeScript: path.relative(SCRIPTS_DIR, file) };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL — ${name}\n    ${err.message}`);
  }
}

/* ── Rule #6: a crashed checker must never resolve to GREEN ─────────────── */

await test('a checker that exits with unparseable stdout reports crashed + INCOMPLETE, never GREEN', async () => {
  const { dir, relativeScript } = makeTempScript(`console.log('not json, simulating a hard crash'); process.exitCode = 1;\n`);
  try {
    const report = await runChecker(relativeScript, []);
    assert.equal(report.crashed, true, 'expected crashed: true');
    assert.equal(layerStatus(report), 'INCOMPLETE', 'expected layerStatus to be INCOMPLETE, never GREEN, for a crashed checker');
  } finally {
    cleanup(dir);
  }
});

await test('a checker that self-reports a top-level `error` (no checks) is INCOMPLETE, never GREEN', async () => {
  const { dir, relativeScript } = makeTempScript(
    `console.log(JSON.stringify({ checker: 'fake', checks: [], summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 }, error: 'could not resolve ref' })); process.exitCode = 0;\n`
  );
  try {
    const report = await runChecker(relativeScript, []);
    assert.equal(report.crashed, true, 'expected crashed: true for a self-reported error with no checks');
    assert.equal(layerStatus(report), 'INCOMPLETE');
  } finally {
    cleanup(dir);
  }
});

/* ── Rule #8: a >64KB payload must survive intact, on both exit 0 and exit 1 ── */

const BIG_PAYLOAD_SIZE = 200_000; // comfortably over the 65536-byte pipe-buffer threshold

for (const exitCode of [0, 1]) {
  await test(`a checker with a >64KB payload (exit ${exitCode}) is recovered fully, not truncated`, async () => {
    const summary = exitCode === 1 ? { pass: 0, fail: 1, skipped: 0, p0Fail: 1, p1Fail: 0 } : { pass: 1, fail: 0, skipped: 0, p0Fail: 0, p1Fail: 0 };
    const script = [
      `const big = { checker: 'fake', checks: [{ id: 'FAKE1', status: '${exitCode === 1 ? 'FAIL' : 'PASS'}', priority: 'P0', name: 'x', summary: 'x'.repeat(${BIG_PAYLOAD_SIZE}), evidence: {}, risk: '' }], summary: ${JSON.stringify(summary)} };`,
      `console.log(JSON.stringify(big));`,
      // The correct pattern (process.exitCode, not process.exit) — this is what check-code.mjs /
      // check-performance.mjs / check-analytics.mjs / run-preflight.mjs itself must all use.
      `process.exitCode = ${exitCode};`,
    ].join('\n');
    const { dir, relativeScript } = makeTempScript(script);
    try {
      const report = await runChecker(relativeScript, []);
      assert.notEqual(report.crashed, true, `expected a clean recovery, got crashed: ${report.crashed}`);
      assert.equal(report.checks.length, 1, 'expected the single real check to survive, not be lost to truncation');
      assert.ok(report.checks[0].summary.length >= BIG_PAYLOAD_SIZE, 'expected the large summary field to be intact, not truncated');
      const expectedStatus = exitCode === 1 ? 'RED' : 'GREEN';
      assert.equal(layerStatus(report), expectedStatus);
    } finally {
      cleanup(dir);
    }
  });
}

await test('a checker using the OLD buggy pattern (process.exit after a large write) demonstrates the bug this guards against', async () => {
  // Not something we want to pass — this documents the failure mode the regression tests
  // above exist to catch. If check-code.mjs/etc. ever regress back to process.exit(n), this
  // assertion will start failing (report.crashed will flip to true), which is the point: it
  // proves the fixed checkers above are exercising real behavior, not a no-op.
  const script = [
    `const big = { checker: 'fake', checks: [{ id: 'FAKE1', status: 'FAIL', priority: 'P0', name: 'x', summary: 'x'.repeat(${BIG_PAYLOAD_SIZE}), evidence: {}, risk: '' }], summary: { pass: 0, fail: 1, skipped: 0, p0Fail: 1, p1Fail: 0 } };`,
    `console.log(JSON.stringify(big));`,
    `process.exit(1);`, // the bug: forces exit before the async stdout write to the pipe flushes
  ].join('\n');
  const { dir, relativeScript } = makeTempScript(script);
  try {
    const report = await runChecker(relativeScript, []);
    assert.equal(report.crashed, true, 'expected the OLD process.exit() pattern to still truncate and crash — if this now passes, either Node changed its pipe-buffering behavior or this test needs revisiting');
  } finally {
    cleanup(dir);
  }
});


/* ── Rule #10: nothing tested / P0 skipped → INCOMPLETE; P2 never gates ── */

const chk = (id, status, priority = 'P0') => ({ id, name: id, status, priority, summary: '', evidence: {}, risk: '' });

await test('a layer with only SKIPPED checks is INCOMPLETE, not GREEN', () => {
  assert.equal(layerStatus({ checks: [chk('PERF-CONFIG', 'SKIPPED')] }), 'INCOMPLETE');
});
await test('a skipped P0 makes a layer INCOMPLETE even when other checks pass', () => {
  assert.equal(layerStatus({ checks: [chk('A1', 'PASS'), chk('A4', 'SKIPPED')] }), 'INCOMPLETE');
});
await test('a P2-only FAIL is GREEN; a P1 FAIL is YELLOW; INCOMPLETE outranks YELLOW overall', () => {
  assert.equal(layerStatus({ checks: [chk('G1', 'PASS'), chk('S7', 'FAIL', 'P2')] }), 'GREEN');
  assert.equal(layerStatus({ checks: [chk('G1', 'PASS'), chk('S6', 'FAIL', 'P1')] }), 'YELLOW');
  assert.equal(overallStatus(['YELLOW', 'INCOMPLETE', 'GREEN']), 'INCOMPLETE');
  assert.equal(overallStatus(['INCOMPLETE', 'RED']), 'RED');
});

/* ── Rule #11: strict args ──────────────────────────────────────────── */

await test('parseArgs rejects unknown flags and treats --help as help, not a run', () => {
  assert.ok(parseArgs(['--bogus']).error);
  assert.ok(parseArgs(['--mode', 'nope']).error);
  assert.equal(parseArgs(['--help']).help, true);
  const ok = parseArgs(['--live-url', 'https://a.com/x', '--preview-url', 'https://a.com/x?preview_theme_id=1', '--mode', 'pre-merge']);
  assert.equal(ok.args.liveUrls.length, 1);
});
await test('run-preflight.mjs --help exits 0 and writes nothing; an unknown flag exits 2', () => {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'help-'));
  try {
    const help = spawnSync('node', [path.join(SCRIPTS_DIR, 'run-preflight.mjs'), '--help', '--root', dir], { encoding: 'utf-8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage/);
    assert.equal(existsSync(path.join(dir, '.buildspace')), false, 'help must not create report files');
    const bad = spawnSync('node', [path.join(SCRIPTS_DIR, 'run-preflight.mjs'), '--staging', 'x', '--root', dir], { encoding: 'utf-8' });
    assert.equal(bad.status, 2);
    assert.equal(existsSync(path.join(dir, '.buildspace')), false);
  } finally {
    cleanup(dir);
  }
});

/* ── Rule #9: empty diff → G0 SKIPPED → INCOMPLETE ───────────────────── */

await test('check-code on two identical branches reports G0 SKIPPED and the layer is INCOMPLETE', async () => {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'repo-'));
  try {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    mkdirSync(path.join(dir, 'sections'));
    writeFileSync(path.join(dir, 'sections', 'a.liquid'), '<div></div>');
    g('add', '.');
    g('commit', '-qm', 'init');
    g('branch', 'stage');
    const report = await runChecker('check-code.mjs', ['--root', dir, '--live-branch', 'main', '--staging-branch', 'stage']);
    const g0 = report.checks.find((c) => c.id === 'G0');
    assert.equal(g0?.status, 'SKIPPED');
    assert.equal(layerStatus(report), 'INCOMPLETE');
  } finally {
    cleanup(dir);
  }
});

/* ── Rule #12: verifier merge rules ─────────────────────────────────── */

const fakeReports = () => [
  { checker: 'code', checks: [chk('G1', 'PASS'), { ...chk('S6', 'FAIL', 'P1'), evidence: { findings: [{ file: 'templates/p.json', line: 3, priority: 'P1' }, { file: 'sections/a.liquid', line: 9, priority: 'P2' }] } }] },
  { checker: 'performance', checks: [chk('PERF-pdp-LCP', 'PASS'), { ...chk('PERF-pdp-CLS', 'FAIL', 'P0'), evidence: { runs: {} } }] },
];

await test('no verifier output → every finding unverified at raw priority (RED stays RED)', () => {
  const reports = fakeReports();
  const wl = buildWorklist(reports);
  assert.equal(wl.items.length, 3, 'S6 explodes into 2 items, CLS is 1');
  const eff = applyDecisions(reports, wl, mergeVerifications(wl, []));
  assert.equal(layerStatus(eff[1]), 'RED');
  assert.equal(layerStatus(eff[0]), 'YELLOW');
});
await test('a false_alarm without concrete evidence is rejected and stays unverified', () => {
  const reports = fakeReports();
  const wl = buildWorklist(reports);
  const merged = mergeVerifications(wl, [{ layer: 'performance', items: [{ id: 'performance:PERF-pdp-CLS', verdict: 'false_alarm', evidence: 'looks like noise' }] }]);
  assert.equal(merged.decisions.get('performance:PERF-pdp-CLS').verdict, 'unverified');
  assert.equal(layerStatus(applyDecisions(reports, wl, merged)[1]), 'RED');
});
await test('an evidenced false_alarm dismisses; a confirmed P2 item alone does not gate', () => {
  const reports = fakeReports();
  const wl = buildWorklist(reports);
  const merged = mergeVerifications(wl, [
    { layer: 'performance', items: [{ id: 'performance:PERF-pdp-CLS', verdict: 'false_alarm', evidence: 'CLS 0.000 on runs 4-8; shifting element .x not in the diff' }] },
    { layer: 'code', items: [{ id: 'code:S6#0', verdict: 'false_alarm', evidence: 'templates/p.json:3 — section is disabled: true' }, { id: 'code:S6#1', verdict: 'confirmed' }] },
  ]);
  const eff = applyDecisions(reports, wl, merged);
  assert.equal(eff[1].checks.find((c) => c.id === 'PERF-pdp-CLS').status, 'DISMISSED');
  assert.equal(layerStatus(eff[1]), 'GREEN');
  assert.equal(eff[0].checks.find((c) => c.id === 'S6').priority, 'P2');
  assert.equal(layerStatus(eff[0]), 'GREEN');
});
await test('config.accepted closes a finding only with a reason; verifier can add findings', () => {
  const reports = fakeReports();
  const wl = buildWorklist(reports, { accepted: [{ check: 'S6', file: 'templates/p.json', reason: 'copy lands before launch', by: 'PM' }, { check: 'S6', file: 'sections/a.liquid' }] });
  assert.ok(wl.items[0].accepted);
  assert.equal(wl.items[1].accepted, null, 'an acceptance without a reason is ignored');
  const merged = mergeVerifications(wl, [{ layer: 'code', items: [], added: [{ priority: 'P0', summary: 'broken render', evidence: 'snippets/x.liquid:4' }] }]);
  const eff = applyDecisions(reports, wl, merged);
  assert.equal(layerStatus(eff[0]), 'RED', 'an added P0 gates');
});

/* ── Rule #13: context-aware code rules ─────────────────────────────── */

await test('money rule skips data-* attributes, JSON values and <script>; flags visible text', () => {
  const rule = STANDARDS_RULES.find((r) => r.id === 'liquid-manual-price');
  const src = [
    '<div data-price="{{ variant.price }}"></div>',
    '{ "price": {{ item.price }},',
    '<script type="application/json">{"p": [{{ v.price }}]}</script>',
    '<span>{{ product.price }}</span>',
  ].join('\n');
  const hits = ruleHits(rule, src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 4);
});
await test('CSS: nested + scoped selectors are not collisions; bare generic and exact overrides are', () => {
  const staging = new Map([
    ['assets/new.css', '.hero { .notes-tab.active { color: red; } }\n.active { color: blue; }\n.acme-faq { padding: 0; }\nbody.x .footer { padding-bottom: 0; }'],
    ['assets/old.css', '.notes-tab { color: green; }\n.menu .active { color: black; }\n.footer { padding-bottom: 10px; }\n.acme-faq-pair .acme-faq { margin: 0; }'],
  ]);
  const rules = parseCssRules(staging.get('assets/new.css'));
  assert.ok(rules.some((r) => r.selector === '.hero .notes-tab.active'), 'nesting resolved');
  const f = findCssCollisions(staging, new Map(), ['assets/new.css']);
  const kinds = (sel) => f.filter((x) => x.selector === sel).map((x) => x.kind);
  assert.deepEqual(kinds('.hero .notes-tab.active'), ['css-override-candidate'], 'scoped restyle of a bare legacy rule is a P2 candidate, never a P1 collision');
  assert.ok(f.filter((x) => x.selector === '.hero .notes-tab.active').every((x) => x.priority === 'P2'));
  assert.deepEqual(kinds('.active'), ['css-unscoped-generic']);
  assert.deepEqual(kinds('.acme-faq'), [], 'a namespaced component root is not a generic collision');
  assert.deepEqual(kinds('body.x .footer'), ['css-override-candidate'], 'scoped override of a bare rule, same property, is a P2 candidate');
});
await test('placeholders are classified by where they render', () => {
  const liquid = 'x\n{% schema %}\n{"default": "Lorem ipsum"}\n{% endschema %}';
  assert.equal(classifyPlaceholder('templates/product.revamp.json', 260, 'Lorem ipsum', '').priority, 'P1');
  assert.equal(classifyPlaceholder('sections/a.liquid', 3, 'Lorem ipsum', liquid).location, 'schema-default');
  assert.equal(classifyPlaceholder('sections/a.liquid', 1, 'Lorem ipsum', liquid).location, 'markup');
  assert.equal(classifyPlaceholder('locales/en.default.schema.json', 1, 'TODO', '').priority, 'P2');
});

/* ── page map ───────────────────────────────────────────────────────── */

await test('page map: a layout change selects every page; a section change only its templates; gaps reported', () => {
  const files = new Map([
    ['layout/theme.liquid', "{% render 'head' %}"],
    ['snippets/head.liquid', ''],
    ['templates/index.json', JSON.stringify({ sections: { a: { type: 'hero' } }, order: ['a'] })],
    ['templates/product.revamp.json', JSON.stringify({ sections: { a: { type: 'product-hero' } }, order: ['a'] })],
    ['templates/collection.json', JSON.stringify({ sections: { a: { type: 'grid' } }, order: ['a'] })],
    ['sections/hero.liquid', ''],
    ['sections/grid.liquid', ''],
    ['sections/product-hero.liquid', "{{ 'product-hero.css' | asset_url | stylesheet_tag }}"],
    ['assets/product-hero.css', ''],
  ]);
  const pages = [{ name: 'home', path: '/' }, { name: 'pdp', path: '/products/x', previewView: 'revamp' }];
  const sectionOnly = selectPages({ files, changed: [{ status: 'M', file: 'assets/product-hero.css' }], pages });
  assert.deepEqual(sectionOnly.selected.map((p) => p.name), ['pdp']);
  const layout = selectPages({ files, changed: [{ status: 'M', file: 'layout/theme.liquid' }], pages });
  assert.deepEqual(layout.selected.map((p) => p.name), ['home', 'pdp']);
  assert.ok(layout.gaps.some((g) => g.template === 'collection' && !g.direct), 'collection renders the changed layout but has no page');
  const direct = selectPages({ files, changed: [{ status: 'M', file: 'templates/collection.json' }], pages });
  assert.ok(direct.gaps.some((g) => g.template === 'collection' && g.direct));
});

/* ── performance: A/B statistics (lib/abtest.mjs) ───────────────────── */

const seq = (n, base, spread, shift = 0) => Array.from({ length: n }, (_, i) => base + shift + ((i * 37) % 11) * (spread / 10));

await test('A/B verdict: a large consistent regression is REGRESSED; noise is not', () => {
  const a = seq(10, 4600, 120);
  assert.equal(verdict('fcp', a, seq(10, 4600, 120, 660)).verdict, 'REGRESSED', 'the Store A FCP +660ms pattern');
  assert.equal(verdict('lcp', seq(10, 19300, 600), seq(10, 15300, 900)).verdict, 'IMPROVED', 'the Store A LCP −4s pattern');
  const same = verdict('lcp', seq(10, 5000, 400), seq(10, 5000, 400, 10));
  assert.ok(['UNCHANGED', 'INCONCLUSIVE'].includes(same.verdict), `identical distributions must never be called a regression (got ${same.verdict})`);
});
await test('A/B verdict: certain but small change is MINOR; few runs are NO_DATA; wide overlap is INCONCLUSIVE', () => {
  const minor = verdict('tbt', seq(20, 2610, 60), seq(20, 2610, 60, -300));
  assert.ok(['IMPROVED_MINOR'].includes(minor.verdict), `−300ms TBT on a ±650ms threshold is minor (got ${minor.verdict})`);
  assert.equal(verdict('lcp', [1, 2], [3, 4]).verdict, 'NO_DATA');
  const bimodal = verdict('fcp', [700, 720, 1800, 1850, 740, 1900, 760, 1820, 730, 1790], [900, 1700, 910, 1750, 880, 920, 1680, 905, 1720, 890]);
  assert.equal(bimodal.verdict, 'INCONCLUSIVE', 'the Store B FCP two-mode pattern must stay inconclusive');
  assert.equal(bimodal.settled, false);
});
await test('Mann-Whitney: identical samples p=1, fully separated samples p<0.001', () => {
  assert.equal(mannWhitney([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), 1);
  assert.ok(mannWhitney(seq(10, 100, 10), seq(10, 500, 10)) < 0.001);
});
await test('counted metrics flag real growth only (both % and absolute floor)', () => {
  const run = (kb, req, rb, script) => ({ counted: { kb, requests: req, dom: 3000, renderBlocking: rb, byType: { Script: { kb: script } } } });
  const { findings } = compareCounted([run(4800, 330, 1, 2600), run(4790, 328, 1, 2600)], [run(4810, 333, 3, 2620), run(4820, 331, 3, 2610)]);
  assert.deepEqual(findings.map((f) => f.metric), ['renderBlocking'], 'only the render-blocking 1→3 jump exceeds tolerance');
});
await test('CLS session windows, server-timing parsing, preview-path URLs', () => {
  assert.equal(+clsFromShifts([{ t: 100, v: 0.1 }, { t: 300, v: 0.1 }, { t: 3000, v: 0.05 }]).toFixed(2), 0.2);
  const st = parseServerTiming('processing;dur=697;desc="gc:47", render;dur=409, theme;desc="160991936745", pageType;desc="index"');
  assert.deepEqual([st.theme, st.processing, st.render, st.pageType], ['160991936745', 697, 409, 'index']);
  const u = new URL(previewPathUrl('example-store.com', '/products/x', 152880775364, 'revamp'));
  assert.deepEqual([u.searchParams.get('preview_theme_id'), u.searchParams.get('view'), u.searchParams.get('pb')], ['152880775364', 'revamp', '0']);
});

/* ── Rule #14: analytics step awareness ─────────────────────────────── */

class FakeChecks {
  constructor() { this.checks = []; }
  push(id, name, priority, status, summary, evidence = {}) { this.checks.push({ id, name, priority, status, summary, evidence }); }
}
const journeyResult = (steps, events = {}) => ({ scripts: { gtm: false, ga4: true, metaPixel: true }, scriptDelivery: {}, events, consentBannerVisible: false, gaBeaconHits: 1, metaBeaconHits: 1, notes: [], steps: Object.entries(steps).map(([step, status]) => ({ step, status, detail: status })) });
const allOk = { home: 'ok', collection: 'ok', pdp: 'ok', addToCart: 'ok', cart: 'ok', checkout: 'ok' };
const labels = { referenceLabel: 'live', currentLabel: 'preview', referenceKey: 'live', currentKey: 'preview' };
const cfg = { expectedEvents: ['view_item', 'add_to_cart'] };

await test('A4 is SKIPPED (not PASS) when add-to-cart could not be driven on either side', () => {
  const c = new FakeChecks();
  const steps = { ...allOk, addToCart: 'failed' };
  evaluateAnalytics(c, cfg, journeyResult(steps, { view_item: [] }), journeyResult(steps, { view_item: [] }), labels);
  assert.equal(c.checks.find((x) => x.id === 'A4').status, 'SKIPPED');
  assert.equal(c.checks.find((x) => x.id === 'A8').status, 'SKIPPED');
  assert.equal(layerStatus({ checks: c.checks }), 'INCOMPLETE');
});
await test('A8 FAILs P0 when a step works on live but not on preview', () => {
  const c = new FakeChecks();
  evaluateAnalytics(c, cfg, journeyResult(allOk, { view_item: [], add_to_cart: [] }), journeyResult({ ...allOk, addToCart: 'failed' }, { view_item: [] }), labels);
  const a8 = c.checks.find((x) => x.id === 'A8');
  assert.equal(a8.status, 'FAIL');
  assert.equal(a8.priority, 'P0');
});
await test('journeys: preview params and a PDP view are carried onto every step URL', () => {
  const [j] = resolveJourneys({ fixtures: { collection: 'handle' } }, { liveUrl: 'https://s.com/products/p', previewUrl: 'https://s.com/products/p?view=revamp&preview_theme_id=9&pb=0' });
  assert.equal(j.product, '/products/p');
  assert.equal(j.collection, null, 'placeholder handle is unset, not /collections/handle');
  assert.equal(j.productPreviewView, 'revamp');
  const side = resolveSide('https://s.com/products/p?view=revamp&preview_theme_id=9&pb=0', null);
  const cart = new URL(stepUrl(side, '/cart'));
  assert.equal(cart.searchParams.get('preview_theme_id'), '9');
  assert.equal(cart.searchParams.get('view'), null, 'view is only applied to the PDP step');
});

rmSync(TMP_ROOT, { recursive: true, force: true });

console.log(`\n${passed}/${passed + failures.length} passed.`);
if (failures.length > 0) {
  console.error(`\n${failures.length} regression(s) detected — see FAIL lines above.`);
  process.exitCode = 1;
}
