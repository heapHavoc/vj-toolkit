#!/usr/bin/env node
/**
 * psi-scan.mjs — run PageSpeed Insights for one or more URLs and save the results.
 *
 * For each URL and device it runs PSI --runs times (default 3), keeps every raw
 * response, and reports the median: scores and lab metrics are the median across
 * runs, details (LCP element, insights, third parties…) come from the median run.
 *
 * Output per URL (folder per site / theme / page / time):
 *   .buildspace/artifacts/perf/scans/<site>/<theme>/<page>/<stamp>/
 *     mobile-run1.json …   raw PSI responses
 *     summary.json         extracted data (what the report skills read)
 *     scan.md              human-readable scan
 *
 * Usage:
 *   node psi-scan.mjs --url <url> [--url <url>]... [--root .] [--runs 3]
 *                     [--strategies mobile,desktop] [--latest]
 *   --latest  don't run PSI; print the newest existing scan for each URL (or null)
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { combineRuns, extract } from './lib/extract.mjs';
import { describeUrl, latestScan, scanDir, stamp } from './lib/paths.mjs';
import { apiKey, runPsi } from './lib/psi.mjs';
import { renderScan } from './lib/render.mjs';

const USAGE = 'Usage: node psi-scan.mjs --url <url> [--url <url>]... [--root .] [--runs 3] [--strategies mobile,desktop] [--latest]\n';

export function parseArgs(argv) {
  const out = { urls: [], root: '.', runs: 3, strategies: ['mobile', 'desktop'], latest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.urls.push(argv[++i]);
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--runs') out.runs = Number.parseInt(argv[++i], 10);
    else if (a === '--strategies') out.strategies = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--latest') out.latest = true;
    else if (a === '--help' || a === '-h') return { help: true };
    else if (/^https?:\/\//.test(a)) out.urls.push(a);
    else return { error: `Unknown argument "${a}".` };
  }
  if (!out.urls.length) return { error: 'At least one --url is required.' };
  for (const u of out.urls) {
    try {
      new URL(u);
    } catch {
      return { error: `Not a valid URL: ${u}` };
    }
  }
  if (!Number.isInteger(out.runs) || out.runs < 1 || out.runs > 10) return { error: '--runs must be 1–10.' };
  if (!out.strategies.every((s) => s === 'mobile' || s === 'desktop')) return { error: '--strategies takes mobile and/or desktop.' };
  out.root = path.resolve(out.root);
  return out;
}

async function scanDevice(url, strategy, runs, dir, key) {
  const extracts = [];
  const errors = [];
  for (let n = 1; n <= runs; n++) {
    const r = await runPsi(url, strategy, { key, log: (m) => process.stderr.write(`${m}\n`) });
    if (!r.ok) {
      errors.push(`run ${n}: ${r.error}`);
      process.stderr.write(`[perf-scan] ${strategy} run ${n}/${runs} failed: ${r.error}\n`);
      continue;
    }
    writeFileSync(path.join(dir, `${strategy}-run${n}.json`), JSON.stringify(r.json));
    const e = extract(r.json);
    extracts.push(e);
    process.stderr.write(`[perf-scan] ${strategy} run ${n}/${runs}: performance ${e.scores.performance ?? '—'}\n`);
  }
  if (!extracts.length) return { errors };
  const combined = combineRuns(extracts);
  return { combined, median: extracts[combined.medianRun], runScores: extracts.map((e) => e.scores.performance), errors };
}

export async function scanUrl(url, { root, runs, strategies, key }) {
  const d = describeUrl(url);
  const date = new Date();
  const dir = path.join(scanDir(root, url), stamp(date));
  mkdirSync(dir, { recursive: true });
  process.stderr.write(`[perf-scan] ${url} → ${path.relative(root, dir)} (${runs} run(s) × ${strategies.join(' + ')})\n`);
  const results = await Promise.all(strategies.map((s) => scanDevice(url, s, runs, dir, key)));
  const devices = {};
  const errors = {};
  strategies.forEach((s, i) => {
    if (results[i].combined) devices[s] = results[i];
    if (results[i].errors.length) errors[s] = results[i].errors;
  });
  const meta = { url, ...d, date: date.toISOString().slice(0, 10), scannedAt: date.toISOString(), runs, strategies, keySource: key ? 'set' : 'none', errors };
  if (!Object.keys(devices).length) {
    writeFileSync(path.join(dir, 'errors.json'), JSON.stringify(meta, null, 2));
    return { url, ok: false, dir, errors };
  }
  const summary = { schema: 1, meta, devices };
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(dir, 'scan.md'), renderScan(summary));
  return {
    url,
    ok: true,
    dir: path.relative(root, dir),
    scanMd: path.relative(root, path.join(dir, 'scan.md')),
    summaryJson: path.relative(root, path.join(dir, 'summary.json')),
    performance: Object.fromEntries(Object.entries(devices).map(([s, v]) => [s, v.combined.scores.performance?.value ?? null])),
    fieldCwv: Object.fromEntries(Object.entries(devices).map(([s, v]) => [s, v.median.field.best ? v.median.field.best.cwvPassed : 'no data'])),
    errors,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(USAGE);
  if (args.error) {
    process.stderr.write(`perf-scan: ${args.error}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.latest) {
    const out = args.urls.map((u) => {
      const dir = latestScan(args.root, u);
      return { url: u, latest: dir ? path.relative(args.root, dir) : null, scannedAt: dir ? JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf-8')).meta.scannedAt : null };
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  const { key, source } = apiKey(args.root);
  process.stderr.write(key ? `[perf-scan] API key from ${source}.\n` : '[perf-scan] No API key ($PAGESPEED_API_KEY or .buildspace/.psi-key) — running keyless; Google allows only a few requests, so expect 429 errors.\n');
  const results = [];
  for (const url of args.urls) results.push(await scanUrl(url, { root: args.root, runs: args.runs, strategies: args.strategies, key }));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.every((r) => !r.ok)) process.exitCode = 1;
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
    process.stderr.write(`perf-scan crashed: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
