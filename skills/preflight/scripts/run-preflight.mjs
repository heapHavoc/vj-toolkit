#!/usr/bin/env node
/**
 * run-preflight.mjs — DETECT stage of /preflight.
 *
 * Pipeline:  detect (this script) → verify (verifier agents) → finalize (finalize-preflight.mjs)
 *
 * This script runs the three checkers and writes their raw candidate findings.
 * It never writes a verdict: a raw FAIL is a candidate until a verifier has
 * checked it against the code / measurements / screenshots. The verdict and
 * the real report come only from finalize-preflight.mjs.
 *
 * Outputs (under <root>/.buildspace/preflight/):
 *   preflight-raw.json            every checker's full report + resolved refs + page selection
 *   verification-worklist.json    one entry per verifiable finding (what the verifiers work on)
 *   preflight-report.md           a PENDING stub — replaced by finalize-preflight.mjs
 *   artifacts/                    screenshots (analytics) and worst-run Lighthouse reports (performance)
 *
 * baseline mode is unchanged: it snapshots live and writes preflight-baseline.json, no verdict.
 *
 * Run with --help for flags. Unknown flags are rejected — a typo never silently
 * falls back to defaults and overwrites a report.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildWorklist, layerStatus, overallStatus } from './lib/verdict.mjs';
import { DEFAULT_IGNORED_TEMPLATES, pageUrls, readThemeAtRef, selectPages, templateTypeForPath } from './lib/page-map.mjs';
import { previewPathUrl, probe } from './lib/abtest.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;

const CHECKERS = [
  { name: 'code', script: 'check-code.mjs' },
  { name: 'performance', script: 'check-performance.mjs' },
  { name: 'analytics', script: 'check-analytics.mjs' },
];

/* ── CLI ──────────────────────────────────────────────────────────────── */

const USAGE = `Usage: node run-preflight.mjs [flags]

Detect stage of /preflight: runs code/performance/analytics checkers and writes
raw findings + a verification worklist. The verdict comes from finalize-preflight.mjs.

  --mode <pre-merge|post-merge|baseline>   default pre-merge
  --live-branch <branch>                   default: config.branches.live, else main
  --staging-branch <branch>                default: config.branches.staging, else stage
  --root <dir>                             theme repo root, default .
  --config <path>                          default .buildspace/preflight/preflight.config.json
  --live-url <url> --preview-url <url>     explicit page pair (repeatable, positional); overrides config.pages
  --page-name <name>                       name for the matching --live-url pair (repeatable)
  --url <url>                              unordered live/preview URLs, auto-paired by path (repeatable)
  --pages <a,b,...>                        test only these config.pages by name
  --all-pages                              test every config.pages entry, not just those the diff touches
  --baseline-file <path>                   post-merge: baseline to diff against
  --post-pr                                recorded for finalize-preflight.mjs (posts the final report)
  -h, --help                               show this help
`;

const VALUE_FLAGS = new Set(['--mode', '--live-branch', '--staging-branch', '--root', '--config', '--live-url', '--preview-url', '--page-name', '--url', '--pages', '--baseline-file']);
const BOOLEAN_FLAGS = new Set(['--post-pr', '--all-pages', '--help', '-h']);
const MODES = new Set(['pre-merge', 'post-merge', 'baseline']);

/** Strict parse. Returns { args } or { error } — never guesses past an unknown flag. */
export function parseArgs(argv) {
  const values = {};
  const multi = { '--live-url': [], '--preview-url': [], '--page-name': [], '--url': [] };
  const bools = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOLEAN_FLAGS.has(a)) {
      bools.add(a);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && !v.includes('://'))) return { error: `${a} needs a value.` };
      if (a in multi) multi[a].push(v);
      else values[a] = v;
      i++;
      continue;
    }
    return { error: `Unknown argument "${a}".` };
  }
  if (bools.has('--help') || bools.has('-h')) return { help: true };
  const mode = values['--mode'] || 'pre-merge';
  if (!MODES.has(mode)) return { error: `--mode must be one of ${[...MODES].join(', ')} (got "${mode}").` };
  return {
    args: {
      mode,
      liveBranch: values['--live-branch'] || null,
      stagingBranch: values['--staging-branch'] || null,
      root: path.resolve(values['--root'] || '.'),
      config: values['--config'] || '.buildspace/preflight/preflight.config.json',
      postPr: bools.has('--post-pr'),
      allPages: bools.has('--all-pages'),
      pagesFilter: values['--pages'] ? values['--pages'].split(',').map((s) => s.trim()).filter(Boolean) : null,
      liveUrls: multi['--live-url'],
      previewUrls: multi['--preview-url'],
      pageNames: multi['--page-name'],
      urls: multi['--url'],
      baselineFile: values['--baseline-file'] || null,
    },
  };
}

function loadConfig(root, configPath) {
  const full = path.isAbsolute(configPath) ? configPath : path.join(root, configPath);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf-8'));
  } catch (err) {
    console.error(`[run-preflight] could not parse ${full}: ${err.message}`);
    return null;
  }
}

/* ── git ──────────────────────────────────────────────────────────────── */

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function resolveRef(root, branch) {
  for (const candidate of [`origin/${branch}`, branch]) {
    try {
      return { ref: candidate, sha: git(root, ['rev-parse', '--verify', candidate]) };
    } catch {}
  }
  return null;
}

function changedFiles(root, liveRef, stagingRef) {
  try {
    return git(root, ['diff', '--name-status', `${liveRef}...${stagingRef}`])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split('\t');
        return { status: status[0], file: rest[rest.length - 1] };
      });
  } catch {
    return [];
  }
}

/* ── page pairs (pre-merge) ───────────────────────────────────────────── */

function isPreviewUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.has('preview_theme_id') || u.searchParams.has('pb');
  } catch {
    return false;
  }
}

function normalizedPath(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
}

function derivePageName(url) {
  const p = normalizedPath(url);
  if (p === '/') return 'home';
  const segments = p.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'page';
}

/** Explicit pairs from the CLI (positional --live-url/--preview-url, or unordered --url). */
function explicitPairs(args) {
  if (args.urls.length > 0) {
    const live = [];
    const preview = [];
    for (const url of args.urls) (isPreviewUrl(url) ? preview : live).push(url);
    const byPath = new Map();
    for (const url of live) {
      const k = normalizedPath(url);
      if (!byPath.has(k)) byPath.set(k, []);
      byPath.get(k).push(url);
    }
    const pairs = [];
    const unmatched = [];
    for (const url of preview) {
      const c = byPath.get(normalizedPath(url));
      if (c && c.length) pairs.push({ name: derivePageName(url), liveUrl: c.shift(), previewUrl: url });
      else unmatched.push(url);
    }
    unmatched.push(...[...byPath.values()].flat());
    return { pairs, note: unmatched.length ? `${unmatched.length} URL(s) could not be paired by path (not tested): ${unmatched.join(', ')}` : null };
  }
  if (args.liveUrls.length !== args.previewUrls.length) {
    return { pairs: [], note: `${args.liveUrls.length} --live-url flag(s) but ${args.previewUrls.length} --preview-url flag(s) — counts must match for positional pairing (or use --url).` };
  }
  return { pairs: args.liveUrls.map((liveUrl, i) => ({ name: args.pageNames[i] || derivePageName(liveUrl), liveUrl, previewUrl: args.previewUrls[i] })), note: null };
}

/** A CLI pair as a page spec the page map understands (path + each side's `view`). */
function pairAsPage(pair) {
  const live = new URL(pair.liveUrl);
  const preview = new URL(pair.previewUrl);
  return { name: pair.name, path: live.pathname, view: live.searchParams.get('view') || null, previewView: preview.searchParams.get('view') || null, liveUrl: pair.liveUrl, previewUrl: pair.previewUrl };
}

/** Fallback when config.pages is absent: the classic three templates from fixtures. */
function fixturePages(config) {
  const f = config?.fixtures || {};
  const real = (h) => h && !/^(handle|todo)?$/i.test(String(h).trim());
  return [
    { name: 'home', path: '/', always: true },
    real(f.productInStock) ? { name: 'product', path: `/products/${f.productInStock}`, always: true } : null,
    real(f.collection) ? { name: 'collection', path: `/collections/${f.collection}`, always: true } : null,
  ].filter(Boolean);
}

/**
 * Decide which pages performance measures. Returns
 *   { source, pairs[], selection|null, note|null }
 * Source is 'cli' (explicit URLs), 'config' (config.pages ∩ blast radius), or 'fixtures'.
 * The page map runs in every case, so coverage gaps are reported even for explicit URLs.
 */
function resolvePages(args, config, themeFiles, changed) {
  const ignoreTemplates = config?.performance?.ignoreTemplates || DEFAULT_IGNORED_TEMPLATES;
  const store = config?.store;
  const previewThemeId = config?.themes?.preview?.themeId || null;
  const previewParams = config?.themes?.preview?.params || {};

  if (args.urls.length > 0 || args.liveUrls.length > 0 || args.previewUrls.length > 0) {
    const { pairs, note } = explicitPairs(args);
    const pages = pairs.map(pairAsPage).map((p) => ({ ...p, always: true }));
    const selection = themeFiles ? selectPages({ files: themeFiles, changed, pages, ignoreTemplates }) : null;
    return { source: 'cli', pairs, selection, note };
  }

  const configured = Array.isArray(config?.pages) && config.pages.length > 0;
  let pages = configured ? config.pages : fixturePages(config);
  if (args.pagesFilter) {
    const unknown = args.pagesFilter.filter((n) => !pages.some((p) => p.name === n));
    pages = pages.filter((p) => args.pagesFilter.includes(p.name)).map((p) => ({ ...p, always: true }));
    if (unknown.length) console.error(`[run-preflight] --pages: unknown page name(s) ignored: ${unknown.join(', ')}`);
  }
  if (args.allPages) pages = pages.map((p) => ({ ...p, always: true }));

  if (!store) return { source: configured ? 'config' : 'fixtures', pairs: [], selection: null, note: 'config.store is not set — cannot build page URLs.' };
  if (!previewThemeId) return { source: configured ? 'config' : 'fixtures', pairs: [], selection: null, note: 'config.themes.preview.themeId is not set — cannot build preview URLs.' };

  const selection = themeFiles ? selectPages({ files: themeFiles, changed, pages, ignoreTemplates }) : { selected: pages.map((p) => ({ ...p, reasons: ['page map unavailable — testing all'] })), skipped: [], gaps: [], unmapped: [], globalChanges: [] };
  if (args.pagesFilter && configured) {
    // A gap caused by --pages narrowing is still untested this run — but say so, not "no page exists".
    const typeOf = (p) => (p.template || templateTypeForPath(p.path)).split('.')[0];
    for (const gap of selection.gaps) {
      const excluded = config.pages.filter((p) => !args.pagesFilter.includes(p.name) && (gap.direct ? p.template === gap.template : typeOf(p) === gap.template));
      if (excluded.length) gap.reason = `"${gap.template}" renders changed files; configured page(s) ${excluded.map((p) => p.name).join(', ')} were excluded by --pages`;
    }
  }
  const pairs = selection.selected.map((p) => ({ name: p.name, ...pageUrls(p, { store, previewThemeId, previewParams }) }));
  return { source: configured ? 'config' : 'fixtures', pairs, selection, note: null };
}

/**
 * The performance plan: both theme ids, and per page its path, views, the templates each side must
 * render (asserted on every run), and a tier. 'timing' (full sequential A/B, ~15–25 min) runs on pages
 * whose template file this diff changed, or that are marked `key: true`; every other affected page is
 * 'counted' (bytes/requests/render-blocking/DOM, ~1 min). Baseline/post-merge measure every config page.
 */
async function buildPerfPlan(args, config, pageResolution, changed) {
  const changedTemplates = new Set(changed.filter((c) => c.status !== 'D' && c.file.startsWith('templates/')).map((c) => c.file.replace(/^templates\//, '').replace(/\.(json|liquid)$/, '')));
  const typeOf = (p) => templateTypeForPath(p.path);
  const explicit = (p, view, tmpl) => tmpl || (view ? `${typeOf(p)}.${view}` : null); // only assert a template we actually know
  const fromCli = pageResolution.source === 'cli';
  const store = fromCli && pageResolution.pairs[0] ? new URL(pageResolution.pairs[0].liveUrl).host : config?.store;
  if (!store) return { plan: null, note: 'config.store is not set.' };

  let liveThemeId = config?.themes?.live?.themeId || null;
  let liveThemeSource = 'config.themes.live.themeId';
  if (!liveThemeId) {
    // The published theme answers on the bare domain; Shopify names it in server-timing.
    liveThemeId = (await probe(fromCli ? pageResolution.pairs[0].liveUrl : `https://${store}/`).catch(() => ({}))).theme || null;
    liveThemeSource = 'detected from the live storefront (server-timing theme)';
  }
  let previewThemeId = config?.themes?.preview?.themeId || null;
  if (!previewThemeId && fromCli && pageResolution.pairs[0]) previewThemeId = new URL(pageResolution.pairs[0].previewUrl).searchParams.get('preview_theme_id');

  let pages;
  if (args.mode !== 'pre-merge') {
    pages = (config?.pages || []).map((p) => ({ name: p.name, path: p.path, liveView: p.view || null, previewView: p.previewView ?? p.view ?? null, liveTemplate: p.liveTemplate || explicit(p, p.view, null), tier: 'timing', reasons: ['baseline/post-merge measures every configured page'] }));
  } else if (fromCli) {
    pages = pageResolution.pairs.map((pair) => {
      const lv = new URL(pair.liveUrl).searchParams.get('view');
      const pv = new URL(pair.previewUrl).searchParams.get('view');
      const u = new URL(pair.liveUrl);
      for (const k of ['preview_theme_id', 'pb', 'view', '_fd', '_ab']) u.searchParams.delete(k);
      const page = { path: u.pathname + u.search };
      return { name: pair.name, path: page.path, liveView: lv, previewView: pv, liveTemplate: explicit(page, lv, null), previewTemplate: explicit(page, pv, null), tier: 'timing', reasons: ['explicit --live-url/--preview-url'] };
    });
  } else {
    pages = (pageResolution.selection?.selected || []).map((p) => {
      const previewView = p.previewView ?? p.view ?? null;
      const previewTemplate = explicit(p, previewView, p.template);
      const direct = previewTemplate && changedTemplates.has(previewTemplate);
      const tier = p.key || direct ? 'timing' : 'counted';
      // Same view on both sides → same template; a preview-only view needs an explicit liveTemplate.
      const liveTemplate = p.liveTemplate || (previewView === (p.view || null) ? previewTemplate : explicit(p, p.view, null));
      return { name: p.name, path: p.path, liveView: p.view || null, previewView, liveTemplate, previewTemplate, tier, reasons: [...(p.reasons || []), tier === 'timing' ? (direct ? `templates/${previewTemplate} changed → full timing A/B` : 'key: true → full timing A/B') : 'counted metrics only (template unchanged, not a key page)'] };
    });
  }
  return { plan: { store, liveThemeId, liveThemeSource, previewThemeId, pages }, note: null };
}

/** Coverage gaps become checks on the performance layer — an unmeasured changed template is never silently fine. */
function coverageChecks(selection) {
  if (!selection) return [];
  const checks = selection.gaps.map((g) => ({
    id: `PERF-COVERAGE-${g.template}`,
    name: `Page coverage: ${g.template}`,
    priority: g.direct ? 'P0' : 'P1',
    status: 'SKIPPED',
    summary: `${g.reason}. Add a page for it to config.pages${g.direct ? '' : ' (or list it in config.performance.ignoreTemplates with a reason)'}.`,
    evidence: { template: g.template, direct: g.direct },
    risk: '',
  }));
  if (selection.unmapped.length > 0) {
    checks.push({ id: 'PERF-COVERAGE-UNMAPPED', name: 'Page coverage: unmapped changes', priority: 'info', status: 'INFO', summary: `${selection.unmapped.length} changed theme file(s) are not reachable from any template by static analysis (dynamic render, orphan, or deleted) — only the always-tested pages cover them.`, evidence: { files: selection.unmapped }, risk: '' });
  }
  return checks;
}

function summarize(checks) {
  const s = { pass: 0, fail: 0, skipped: 0, p0Fail: 0, p1Fail: 0 };
  for (const c of checks) {
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

/* ── running checkers ─────────────────────────────────────────────────── */

/**
 * Runs one checker script and returns its parsed JSON report. Async
 * (execFile, not execFileSync) so all three checkers run concurrently.
 *
 * A checker that crashes (non-zero exit with no parseable JSON on stdout, or
 * a JSON payload that itself carries a top-level `error`) always comes back
 * with `crashed: true`. layerStatus() checks that flag before it looks at
 * `checks` — an empty `checks: []` array is truthy and iterable, so without
 * this flag a hard crash and "everything passed" are indistinguishable.
 */
export async function runChecker(script, args) {
  const scriptPath = path.join(SCRIPT_DIR, script);
  const checkerName = script.replace('.mjs', '').replace(/^check-/, '');
  if (!existsSync(scriptPath)) {
    return { checker: checkerName, crashed: true, checks: [], summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 }, error: 'Checker not yet implemented.' };
  }
  try {
    const { stdout } = await execFileAsync('node', [scriptPath, ...args], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 });
    const report = JSON.parse(stdout);
    if (report.error) report.crashed = true;
    return report;
  } catch (err) {
    // Checker scripts exit non-zero on P0 fail but still print valid JSON to stdout — parse that first.
    let parseError = null;
    if (err.stdout) {
      try {
        const report = JSON.parse(err.stdout);
        if (report.error) report.crashed = true;
        return report;
      } catch (e) {
        parseError = e.message;
      }
    }
    const details = [
      `err.message: ${err.message}`,
      err.code != null ? `exit code: ${err.code}` : null,
      err.signal ? `signal: ${err.signal}` : null,
      err.stdout ? `stdout: ${err.stdout.length} bytes, JSON.parse failed: ${parseError}` : 'stdout: none',
      err.stderr ? `stderr: ${err.stderr.slice(0, 2000)}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
    const reason = `Checker crashed without valid JSON output — ${details}`;
    return {
      checker: checkerName,
      crashed: true,
      checks: [{ id: `${checkerName.toUpperCase()}-CRASH`, name: 'Checker crashed', priority: 'P0', status: 'SKIPPED', summary: reason, evidence: {}, risk: '' }],
      summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 },
      error: reason,
    };
  }
}

// The three checkers share no mutable state with each other — only
// check-code.mjs touches git (temp `git worktree add`/`remove`), and it's
// invoked exactly once per run here. Running them concurrently is safe;
// running check-code.mjs itself concurrently against the same repo is NOT
// (races on git's worktree metadata). Never add a second check-code entry.
async function runAllCheckers(argsFor) {
  return Promise.all(CHECKERS.map((c) => runChecker(c.script, argsFor(c.name))));
}

export { layerStatus, overallStatus, buildPerfPlan };

/* ── main ─────────────────────────────────────────────────────────────── */

const PENDING_REPORT = (raw) => `# Preflight Report (${raw.mode}) — PENDING VERIFICATION

**This is not a verdict.** The detect stage finished at ${raw.generatedAt}; its findings are
candidates until the verifier agents have checked them and \`finalize-preflight.mjs\` has run.

- Raw findings: \`.buildspace/preflight/preflight-raw.json\`
- Worklist: \`.buildspace/preflight/verification-worklist.json\` (${raw.worklistCount} item(s) to verify)
- Comparing: ${raw.comparison}

Run the verify + finalize steps in SKILL.md to replace this file with the real report.
`;

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.error) {
    process.stderr.write(`run-preflight: ${parsed.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const args = parsed.args;
  const config = loadConfig(args.root, args.config);
  args.liveBranch ||= config?.branches?.live || 'main';
  args.stagingBranch ||= config?.branches?.staging || 'stage';

  const outDir = path.join(args.root, '.buildspace', 'preflight');
  const artifactsDir = path.join(outDir, 'artifacts');
  mkdirSync(outDir, { recursive: true });

  // Refs — resolved and printed up front so a wrong branch is visible before anything runs.
  try {
    execFileSync('git', ['fetch', 'origin', args.liveBranch, ...(args.mode === 'baseline' ? [] : [args.stagingBranch])], { cwd: args.root, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {}
  const live = resolveRef(args.root, args.liveBranch);
  const staging = args.mode === 'pre-merge' ? resolveRef(args.root, args.stagingBranch) : null;
  const comparison =
    args.mode === 'pre-merge'
      ? `staging \`${staging?.ref || args.stagingBranch}\` (${staging?.sha?.slice(0, 7) || 'unresolved'}) vs. live \`${live?.ref || args.liveBranch}\` (${live?.sha?.slice(0, 7) || 'unresolved'})`
      : args.mode === 'post-merge'
        ? `live \`${live?.ref || args.liveBranch}\` (${live?.sha?.slice(0, 7) || 'unresolved'}) vs. last baseline`
        : `live \`${live?.ref || args.liveBranch}\` snapshot`;
  console.error(`[run-preflight] mode ${args.mode}: ${comparison}`);

  // Blast radius → pages (pre-merge only).
  let changed = [];
  let themeFiles = null;
  let pageResolution = { source: 'none', pairs: [], selection: null, note: null };
  if (args.mode === 'pre-merge' && live && staging) {
    changed = changedFiles(args.root, live.ref, staging.ref);
    try {
      themeFiles = readThemeAtRef(args.root, staging.ref);
    } catch (err) {
      console.error(`[run-preflight] page map unavailable (${err.message}) — testing every configured page.`);
    }
    pageResolution = resolvePages(args, config, themeFiles, changed);
    if (pageResolution.note) console.error(`[run-preflight] pages: ${pageResolution.note}`);
    console.error(`[run-preflight] pages (${pageResolution.source}): ${pageResolution.pairs.map((p) => p.name).join(', ') || 'none'}`);
  }

  // Fresh artifacts every run — a stale screenshot must never be read as this run's evidence.
  if (args.mode !== 'baseline') rmSync(artifactsDir, { recursive: true, force: true });

  const base = ['--root', args.root, '--config', args.config, '--mode', args.mode, '--live-branch', args.liveBranch];
  if (args.mode !== 'baseline') base.push('--staging-branch', args.stagingBranch);
  const baselinePath = args.baselineFile || path.join(outDir, 'preflight-baseline.json');
  if (args.mode === 'post-merge') base.push('--baseline-file', baselinePath);

  // Performance plan → file; the checker reads it (theme ids, pages, templates, tiers).
  const perfPlanPath = path.join(outDir, 'perf-plan.json');
  const { plan: perfPlan, note: perfPlanNote } = await buildPerfPlan(args, config, pageResolution, changed);
  if (perfPlan) {
    writeFileSync(perfPlanPath, JSON.stringify(perfPlan, null, 2));
    console.error(`[run-preflight] performance: live theme ${perfPlan.liveThemeId ?? '?'} (${perfPlan.liveThemeSource}) vs preview theme ${perfPlan.previewThemeId ?? '?'}; ${perfPlan.pages.map((p) => `${p.name}=${p.tier}`).join(', ') || 'no pages'}`);
  } else if (perfPlanNote) console.error(`[run-preflight] performance plan: ${perfPlanNote}`);

  const argsFor = (checker) => {
    const a = [...base];
    if (checker === 'performance') {
      a.push('--artifacts-dir', path.join(artifactsDir, 'performance'));
      if (perfPlan) a.push('--plan', perfPlanPath);
    }
    if (checker === 'analytics') {
      a.push('--artifacts-dir', path.join(artifactsDir, 'analytics'));
      // Only explicit CLI pairs are forwarded — otherwise analytics uses config.analytics.journeys / fixtures.
      if (pageResolution.source === 'cli' && pageResolution.pairs[0]) a.push('--live-url', pageResolution.pairs[0].liveUrl, '--preview-url', pageResolution.pairs[0].previewUrl);
    }
    return a;
  };

  /* ── baseline mode: snapshot live, write preflight-baseline.json, no verdict ── */
  if (args.mode === 'baseline') {
    const reports = await runAllCheckers(argsFor);
    const baseline = { generatedAt: new Date().toISOString(), liveBranch: args.liveBranch, liveSha: live?.sha || null };
    for (const report of reports) if (report.snapshot) baseline[report.checker] = { snapshot: report.snapshot };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
    const captured = Object.keys(baseline).filter((k) => !['generatedAt', 'liveBranch', 'liveSha'].includes(k));
    console.error(`Baseline written to ${baselinePath} — captured: ${captured.join(', ') || 'nothing (all checkers skipped)'}.`);
    console.log(JSON.stringify({ mode: 'baseline', baselinePath, captured, reports }, null, 2));
    return;
  }

  if (args.mode === 'post-merge' && !existsSync(baselinePath)) {
    console.error(`No baseline found at ${baselinePath} — run \`--mode baseline\` after a known-good release before using post-merge mode.`);
    console.log(JSON.stringify({ mode: 'post-merge', stage: 'detect', status: 'INCOMPLETE', error: `No baseline found at ${baselinePath}.` }, null, 2));
    return;
  }

  /* ── pre-merge / post-merge: detect only ── */
  const reports = await runAllCheckers(argsFor);

  const perf = reports.find((r) => r.checker === 'performance');
  const coverage = coverageChecks(pageResolution.selection);
  if (perf && coverage.length) {
    perf.checks = [...(perf.checks || []), ...coverage];
    perf.summary = summarize(perf.checks);
  }

  const generatedAt = new Date().toISOString();
  const worklist = buildWorklist(reports, { accepted: config?.accepted || [], stagingRef: staging?.ref || null, liveRef: live?.ref || null });
  const raw = {
    mode: args.mode,
    stage: 'detect',
    generatedAt,
    comparison,
    refs: { live, staging },
    args: { liveBranch: args.liveBranch, stagingBranch: args.stagingBranch, postPr: args.postPr, config: args.config },
    pages: {
      source: pageResolution.source,
      note: pageResolution.note,
      // What performance actually measures: both themes through the preview path, per page tier.
      tested: (perfPlan?.pages || []).map((p) => ({ name: p.name, tier: p.tier, liveUrl: previewPathUrl(perfPlan.store, p.path, perfPlan.liveThemeId, p.liveView), previewUrl: previewPathUrl(perfPlan.store, p.path, perfPlan.previewThemeId, p.previewView), liveTemplate: p.liveTemplate, previewTemplate: p.previewTemplate })),
      themes: perfPlan ? { live: perfPlan.liveThemeId, liveSource: perfPlan.liveThemeSource, preview: perfPlan.previewThemeId } : null,
      selection: pageResolution.selection && {
        selected: pageResolution.selection.selected.map((p) => ({ name: p.name, template: p.template, reasons: p.reasons })),
        notSelected: pageResolution.selection.skipped,
        gaps: pageResolution.selection.gaps,
        unmapped: pageResolution.selection.unmapped,
      },
    },
    rawStatuses: reports.map((r) => ({ checker: r.checker, status: layerStatus(r) })),
    reports,
  };
  writeFileSync(path.join(outDir, 'preflight-raw.json'), JSON.stringify(raw, null, 2));
  writeFileSync(path.join(outDir, 'verification-worklist.json'), JSON.stringify(worklist, null, 2));
  writeFileSync(path.join(outDir, 'preflight-report.md'), PENDING_REPORT({ ...raw, worklistCount: worklist.items.length }));
  // Verifier output from a previous run must never be merged into this one.
  rmSync(path.join(outDir, 'verification'), { recursive: true, force: true });
  mkdirSync(path.join(outDir, 'verification'), { recursive: true });

  const byLayer = (layer) => worklist.items.filter((i) => i.layer === layer);
  console.log(
    JSON.stringify(
      {
        mode: args.mode,
        stage: 'detect',
        comparison,
        rawStatuses: raw.rawStatuses,
        rawOverall: overallStatus(raw.rawStatuses.map((s) => s.status)),
        worklist: {
          path: path.join(outDir, 'verification-worklist.json'),
          total: worklist.items.length,
          preAccepted: worklist.items.filter((i) => i.accepted).length,
          byLayer: Object.fromEntries(CHECKERS.map((c) => [c.name, byLayer(c.name).length])),
          skippedChecks: worklist.skipped.length,
        },
        pages: raw.pages.tested.map((p) => `${p.name} (${p.tier})`),
        coverageGaps: pageResolution.selection?.gaps || [],
        rawPath: path.join(outDir, 'preflight-raw.json'),
        verificationDir: path.join(outDir, 'verification'),
        next: 'Dispatch one preflight-verifier per layer with items, then run finalize-preflight.mjs.',
      },
      null,
      2
    )
  );
}

// Only auto-run when executed directly (`node run-preflight.mjs ...`), not when imported —
// scripts/__tests__/regression.test.mjs imports runChecker/layerStatus/parseArgs.
//
// This script is normally reached via a symlinked directory (.claude/skills/preflight ->
// the plugin marketplace copy). Node's ESM loader resolves symlinks when computing
// import.meta.url, but never touches process.argv[1] — so a raw string comparison between
// the two permanently fails for every symlinked invocation. Realpath both sides.
function isRunDirectly() {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch((err) => {
    console.error(`run-preflight.mjs crashed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
