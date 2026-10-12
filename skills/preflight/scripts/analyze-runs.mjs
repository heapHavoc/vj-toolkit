#!/usr/bin/env node
/**
 * analyze-runs.mjs — what to improve in /preflight, from archived runs.
 *
 * Reads every .buildspace/preflight/runs/<run>/run.json under one or more theme repos
 * (the same payload that is sent to the shared run log) and prints a markdown summary:
 * false-alarm rate per check, checks that never fire, skip reasons, checker health,
 * post-merge findings and user feedback.
 *
 * For the whole team's runs, use the views in the Supabase project instead
 * (see skills/preflight/telemetry/README.md) — they compute the same tables.
 *
 * Usage:
 *   node analyze-runs.mjs --root . [--root ../other-theme]... [--since 2026-01-01]
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = { roots: [], since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.roots.push(path.resolve(argv[++i]));
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else return { error: `Unknown argument "${a}".` };
  }
  if (!out.roots.length) out.roots.push(path.resolve('.'));
  return out;
}

export function loadRuns(roots, since = null) {
  const runs = [];
  for (const root of roots) {
    const dir = path.join(root, '.buildspace', 'preflight', 'runs');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name, 'run.json');
      if (!existsSync(file)) continue;
      try {
        const run = JSON.parse(readFileSync(file, 'utf-8'));
        if (since && (run.started_at || '') < since) continue;
        runs.push(run);
      } catch {}
    }
  }
  return runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

const pct = (n, d) => (d ? `${Math.round((1000 * n) / d) / 10}%` : '—');
const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '_None._');

export function summarize(runs) {
  const groupBy = (items, key) => items.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) || []), x]), new Map());

  const findings = runs.flatMap((r) => (r.findings || []).map((f) => ({ ...f, run: r })));
  const accuracy = [...groupBy(findings, (f) => `${f.layer}/${f.check_id}`)]
    .map(([k, fs]) => {
      const n = (v) => fs.filter((f) => f.verdict === v).length;
      return { k, name: fs[0].check_name, total: fs.length, confirmed: n('confirmed'), falseAlarm: n('false_alarm'), unverified: n('unverified'), accepted: fs.filter((f) => f.accepted).length };
    })
    .sort((a, b) => b.falseAlarm / b.total - a.falseAlarm / a.total || b.total - a.total);

  const checks = runs.flatMap((r) => (r.checks || []).map((c) => ({ ...c, check_id: String(c.check_id).replace(/#\d+$/, '') })));
  const activity = [...groupBy(checks, (c) => `${c.layer}/${c.check_id}`)].map(([k, cs]) => {
    const n = (s) => cs.filter((c) => c.status === s).length;
    return { k, name: cs[0].check_name, runs: cs.length, fail: n('FAIL') + n('DISMISSED') + n('ACCEPTED'), pass: n('PASS'), skipped: n('SKIPPED') };
  });

  const skips = [...groupBy(checks.filter((c) => c.status === 'SKIPPED'), (c) => `${c.layer}/${c.check_id}|${String(c.summary || '').slice(0, 160)}`)]
    .map(([k, cs]) => ({ k: k.split('|')[0], reason: k.split('|').slice(1).join('|'), times: cs.length }))
    .sort((a, b) => b.times - a.times);

  const layers = runs.flatMap((r) => r.layers || []);
  const health = [...groupBy(layers, (l) => l.layer)].map(([layer, ls]) => {
    const d = ls.map((l) => l.duration_ms).filter(Number.isFinite);
    return { layer, runs: ls.length, crashed: ls.filter((l) => l.crashed).length, incomplete: ls.filter((l) => l.final_status === 'INCOMPLETE').length, avg: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length / 1000) : null, max: d.length ? Math.round(Math.max(...d) / 1000) : null };
  });

  const stage = (r) => r.data?.stage || '—';
  const lines = [
    `# Preflight run analysis`,
    '',
    `${runs.length} run(s)${runs.length ? `, ${runs[0].started_at?.slice(0, 10)} to ${runs[runs.length - 1].started_at?.slice(0, 10)}` : ''}.`,
    '',
    table(
      ['Mode', 'Stage', 'Runs', 'GREEN', 'YELLOW', 'RED', 'INCOMPLETE'],
      [...groupBy(runs, (r) => `${r.mode}|${stage(r)}`)].map(([k, rs]) => [...k.split('|'), rs.length, ...['GREEN', 'YELLOW', 'RED', 'INCOMPLETE'].map((s) => rs.filter((r) => r.overall === s).length)])
    ),
    '',
    '## False alarms per check',
    'High false-alarm rates mark checks to tighten; high accepted rates mark rules that may be too strict.',
    '',
    table(['Check', 'Name', 'Findings', 'Confirmed', 'False alarms', 'False-alarm %', 'Unverified', 'Accepted'], accuracy.map((a) => [a.k, a.name, a.total, a.confirmed, a.falseAlarm, pct(a.falseAlarm, a.total), a.unverified, a.accepted])),
    '',
    '## Checks that never fail',
    table(['Check', 'Name', 'Runs', 'Passed', 'Skipped'], activity.filter((a) => a.fail === 0).sort((a, b) => b.runs - a.runs).map((a) => [a.k, a.name, a.runs, a.pass, a.skipped])),
    '',
    '## Skip reasons',
    table(['Check', 'Reason', 'Times'], skips.slice(0, 30).map((s) => [s.k, s.reason, s.times])),
    '',
    '## Checker health',
    table(['Layer', 'Runs', 'Crashed', 'Incomplete', 'Avg s', 'Max s'], health.map((h) => [h.layer, h.runs, h.crashed, h.incomplete, h.avg, h.max])),
    '',
    '## Found only after merge',
    'Open findings from post-merge runs: candidates for a check pre-merge should have caught.',
    '',
    table(['Date', 'Project', 'Check', 'Priority', 'Summary'], findings.filter((f) => f.run.mode === 'post-merge' && f.verdict !== 'false_alarm' && !f.accepted).map((f) => [f.run.started_at?.slice(0, 10), f.run.project, `${f.layer}/${f.check_id}`, f.priority, f.summary])),
    '',
    '## Feedback',
    table(['Date', 'Project', 'Who', 'Feedback'], runs.filter((r) => r.feedback).map((r) => [r.started_at?.slice(0, 10), r.project, r.user_email, r.feedback])),
  ];
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node analyze-runs.mjs --root . [--root <other theme repo>]... [--since YYYY-MM-DD]\n');
    return;
  }
  if (args.error) {
    process.stderr.write(`analyze-runs: ${args.error}\n`);
    process.exitCode = 2;
    return;
  }
  const runs = loadRuns(args.roots, args.since);
  if (!runs.length) {
    process.stderr.write(`analyze-runs: no archived runs under ${args.roots.map((r) => path.join(r, '.buildspace/preflight/runs')).join(', ')}.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${summarize(runs)}\n`);
}

function isRunDirectly() {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunDirectly()) main();
