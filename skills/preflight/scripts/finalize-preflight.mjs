#!/usr/bin/env node
/**
 * finalize-preflight.mjs — VERDICT stage of /preflight.
 *
 * Reads the detect stage's raw findings + worklist, merges every verifier's
 * output (and config.accepted sign-offs), computes the per-layer and overall
 * verdict, and writes the real report. This is the only script that writes a
 * verdict.
 *
 * Usage:
 *   node finalize-preflight.mjs --root . [--config .buildspace/preflight/preflight.config.json]
 *     [--verification <file>]...   default: every *.json in .buildspace/preflight/verification/
 *     [--post-pr]                  post the report to the staging branch's open PR (pre-merge only)
 *
 * Status model (per layer, never blended; overall = worst):
 *   RED        any confirmed or unverified P0
 *   INCOMPLETE a checker crashed, a P0 check was skipped, or nothing was tested
 *   YELLOW     any confirmed or unverified P1
 *   GREEN      none of the above
 * Exit code: 1 on RED or INCOMPLETE, 0 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDecisions, findAcceptance, layerStatus, mergeVerifications, overallStatus } from './lib/verdict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'preflight-report-template.md');

function parseArgs(argv) {
  const out = { root: '.', config: '.buildspace/preflight/preflight.config.json', verifications: [], postPr: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--verification') out.verifications.push(argv[++i]);
    else if (a === '--post-pr') out.postPr = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else return { error: `Unknown argument "${a}".` };
  }
  out.root = path.resolve(out.root);
  return out;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf-8'));

/* ── rendering ────────────────────────────────────────────────────────── */

const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

/** One-line label for an exploded finding — the thing a human needs to go and look at. */
export function itemLabel(item) {
  const i = item || {};
  if (i.file) {
    const where = `\`${i.file}${i.line ? `:${i.line}` : ''}\``;
    const what = [i.ruleId, i.kind, i.location, i.pattern && !i.location ? i.pattern : null].filter(Boolean).join(', ');
    const detail = i.selector ? ` \`${trunc(i.selector, 90)}\`` : i.text ? ` — "${trunc(i.text, 80)}"` : i.newCount ? ` — ${i.newCount} new` : '';
    return `${where}${what ? ` (${what})` : ''}${detail}`;
  }
  if (i.step) return `step \`${i.step}\``;
  if (i.check && i.path) return `\`${i.path}:${i.line ?? ''}\` (${i.check})`;
  if (i.blockId) return `app embed \`${i.type}\` (${i.status})`;
  if (i.sha) return `commit ${i.sha.slice(0, 7)} — ${trunc(i.subject, 60)}`;
  if (i.deletedFile) return `\`${i.deletedFile}\` still referenced by ${i.referencedIn?.join(', ')}`;
  return null;
}

function fmtOpenCheck(check) {
  const lines = [`- **[${check.layer}/${check.id}] ${check.name}** — ${check.summary}`];
  if (check.risk) lines.push(`  - Risk: ${check.risk}`);
  if (check.addedByVerifier) {
    lines.push(`  - Added by verifier: ${check.evidence?.verifierEvidence || ''}`);
    return lines.join('\n');
  }
  const open = (check.items || []).filter((r) => r.state === 'confirmed' || r.state === 'unverified');
  const shown = open.slice(0, 15);
  for (const r of shown) {
    const label = itemLabel(r.item) || (open.length === 1 ? 'this check' : r.id);
    const tag = r.state === 'confirmed' ? '**confirmed**' : '**unverified**';
    const ev = r.decision?.evidence ? ` — ${trunc(r.decision.evidence, 300)}` : '';
    const note = r.decision?.note ? ` _(${r.decision.note})_` : '';
    const prio = r.finalPriority !== r.priority ? ` [${r.priority}→${r.finalPriority}]` : ` [${r.finalPriority}]`;
    lines.push(`  - ${tag}${prio} ${label}${ev}${note}`);
  }
  if (open.length > shown.length) lines.push(`  - …and ${open.length - shown.length} more — see \`preflight-final.json\``);
  if (open.length === 1 && !itemLabel(open[0].item)) lines.push(`  - Evidence: \`${trunc(JSON.stringify(check.evidence), 400)}\``);
  return lines.join('\n');
}

function fmtClosedItems(checks, state) {
  const out = [];
  for (const check of checks) {
    for (const r of (check.items || []).filter((x) => x.state === state)) {
      const label = itemLabel(r.item) || check.name;
      const why = state === 'accepted' ? `${r.accepted.reason}${r.accepted.by ? ` — ${r.accepted.by}` : ''}${r.accepted.date ? `, ${r.accepted.date}` : ''}` : trunc(r.decision?.evidence || r.decision?.reason, 300);
      out.push(`- [${check.layer}/${check.id}] ${label} — ${why}`);
    }
  }
  return out;
}

function pagesSection(raw) {
  const pages = raw.pages || {};
  const tested = pages.tested || [];
  const sel = pages.selection;
  const lines = [];
  if (tested.length === 0) lines.push("_No pages were measured — see the performance layer's SKIPPED entries for why._");
  else {
    const th = pages.themes;
    if (th) lines.push(`Both sides load through Shopify's preview path: **live theme ${th.live}** (${th.liveSource}) vs **preview theme ${th.preview}**. Every run re-checks the theme id (server-timing) and template (body class).`, '');
    lines.push('| Page | Tier | Why | Templates checked (live / preview) |', '|---|---|---|---|');
    for (const p of tested) {
      const reasons = sel?.selected?.find((s) => s.name === p.name)?.reasons || [];
      lines.push(`| ${p.name} | ${p.tier === 'timing' ? '**timing A/B**' : 'counted only'} | ${trunc(reasons.slice(0, 3).join('; '), 140) || '—'} | ${p.liveTemplate || '—'} / ${p.previewTemplate || '—'} |`);
    }
  }
  if (sel?.notSelected?.length) lines.push('', `Not tested (nothing they render changed): ${sel.notSelected.map((s) => `${s.page} (${s.reason})`).join(', ')}.`);
  if (sel?.gaps?.length) lines.push('', `**Coverage gaps:** ${sel.gaps.map((g) => `\`${g.template}\`${g.direct ? ' (template itself changed — P0)' : ''}`).join(', ')} — add pages for these to \`config.pages\`.`);
  if (pages.note) lines.push('', `_Note: ${pages.note}_`);
  return lines.join('\n');
}

function blastRadius(raw) {
  const g5 = raw.reports.find((r) => r.checker === 'code')?.checks?.find((c) => c.id === 'G5');
  if (!g5) return '_check-code.mjs did not produce a blast radius (see the code layer)._';
  const e = g5.evidence || {};
  return Object.entries(e)
    .filter(([, files]) => Array.isArray(files) && files.length)
    .map(([bucket, files]) => `- **${bucket}** (${files.length}): ${files.slice(0, 25).map((f) => `\`${f}\``).join(', ')}${files.length > 25 ? `, …+${files.length - 25}` : ''}`)
    .join('\n');
}

export function renderReport({ raw, effective, statuses, overall, merged, verificationFiles }) {
  const template = existsSync(TEMPLATE_PATH) ? readFileSync(TEMPLATE_PATH, 'utf-8') : '# Preflight Report ({{MODE}})\n\n**Overall verdict:** {{OVERALL_STATUS}}\n';
  const all = effective.flatMap((r) => (r.checks || []).map((c) => ({ ...c, layer: r.checker })));
  const open = (p) => all.filter((c) => c.status === 'FAIL' && c.priority === p);
  const withItems = all.filter((c) => Array.isArray(c.items));
  const itemStates = withItems.flatMap((c) => c.items.map((i) => i.state));
  const count = (s) => itemStates.filter((x) => x === s).length;

  const verificationStatus =
    verificationFiles.length === 0
      ? `**NOT RUN** — no verifier output found. Every finding below is \`unverified\` and counts at its raw priority.`
      : `${verificationFiles.length} verifier file(s) — ${count('confirmed')} confirmed, ${count('unverified')} unverified, ${count('false_alarm')} dismissed as false alarms, ${count('accepted')} accepted in config.`;

  const layerRows = effective
    .map((r, i) => {
      const checks = r.checks || [];
      const items = checks.filter((c) => Array.isArray(c.items)).flatMap((c) => c.items);
      const n = (s) => items.filter((x) => x.state === s).length;
      const raw0 = raw.rawStatuses?.find((s) => s.checker === r.checker)?.status || '—';
      return `| ${r.checker} | **${statuses[i]}** | ${raw0} | ${checks.filter((c) => c.status === 'PASS').length} | ${n('confirmed')} | ${n('unverified')} | ${n('false_alarm')} | ${n('accepted')} | ${checks.filter((c) => c.status === 'SKIPPED').length} |`;
    })
    .join('\n');

  const notTested = [
    ...effective.filter((r) => r.crashed).map((r) => `- **[${r.checker}] checker crashed** — ${trunc(r.error, 400)}`),
    ...all.filter((c) => c.status === 'SKIPPED' && c.priority === 'P0').map((c) => `- **[${c.layer}/${c.id}] ${c.name}** — ${c.summary}`),
    ...effective.filter((r, i) => statuses[i] === 'INCOMPLETE' && !r.crashed && !(r.checks || []).some((c) => c.status === 'SKIPPED' && c.priority === 'P0')).map((r) => `- **[${r.checker}]** nothing was actually tested on this layer.`),
  ];
  const otherSkipped = all.filter((c) => c.status === 'SKIPPED' && c.priority !== 'P0').map((c) => `- [${c.layer}/${c.id}] ${c.name}: ${c.summary}`);
  const p2 = all.filter((c) => c.status === 'FAIL' && (c.priority === 'P2' || c.priority === 'info'));
  const info = all.filter((c) => c.status === 'INFO' && c.id !== 'G5').map((c) => `- **[${c.layer}/${c.id}] ${c.name}** — ${c.summary}`);
  const dismissed = fmtClosedItems(withItems, 'false_alarm');
  const accepted = fmtClosedItems(withItems, 'accepted');
  const problems = [...merged.problems, ...withItems.flatMap((c) => c.items.filter((i) => i.decision?.note && i.decision.note !== 'not returned by any verifier').map((i) => `${c.layer}/${c.id} ${itemLabel(i.item) || i.id}: ${i.decision.note}`))];

  const none = '_None._';
  return template
    .replace('{{MODE}}', raw.mode)
    .replace('{{OVERALL_STATUS}}', overall)
    .replace('{{COMPARISON}}', raw.comparison)
    .replace('{{VERIFICATION_STATUS}}', verificationStatus)
    .replace('{{TIMESTAMP}}', new Date().toISOString())
    .replace('{{DETECTED_AT}}', raw.generatedAt)
    .replace('{{LAYER_STATUS_TABLE}}', layerRows)
    .replace('{{BLAST_RADIUS}}', blastRadius(raw))
    .replace('{{PAGES}}', pagesSection(raw))
    .replace('{{RED_FINDINGS}}', open('P0').map(fmtOpenCheck).join('\n\n') || none)
    .replace('{{YELLOW_FINDINGS}}', open('P1').map(fmtOpenCheck).join('\n\n') || none)
    .replace('{{NOT_TESTED}}', notTested.join('\n') || none)
    .replace('{{P2_FINDINGS}}', p2.map((c) => `- [${c.layer}/${c.id}] ${c.name} — ${c.summary}`).join('\n') || none)
    .replace('{{DISMISSED}}', dismissed.join('\n') || none)
    .replace('{{ACCEPTED}}', accepted.join('\n') || none)
    .replace('{{INFO_FINDINGS}}', info.join('\n') || none)
    .replace('{{SKIPPED}}', otherSkipped.join('\n') || none)
    .replace('{{VERIFIER_PROBLEMS}}', problems.map((p) => `- ${p}`).join('\n') || none);
}

/* ── main ─────────────────────────────────────────────────────────────── */

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node finalize-preflight.mjs --root . [--config path] [--verification file]... [--post-pr]\n');
    return;
  }
  if (args.error) {
    process.stderr.write(`finalize-preflight: ${args.error}\n`);
    process.exitCode = 2;
    return;
  }
  const outDir = path.join(args.root, '.buildspace', 'preflight');
  const rawPath = path.join(outDir, 'preflight-raw.json');
  const worklistPath = path.join(outDir, 'verification-worklist.json');
  if (!existsSync(rawPath) || !existsSync(worklistPath)) {
    process.stderr.write(`finalize-preflight: ${!existsSync(rawPath) ? rawPath : worklistPath} not found — run run-preflight.mjs first.\n`);
    process.exitCode = 2;
    return;
  }
  const raw = readJson(rawPath);
  const worklist = readJson(worklistPath);
  const configFull = path.isAbsolute(args.config) ? args.config : path.join(args.root, args.config);
  const config = existsSync(configFull) ? readJson(configFull) : {};

  // Acceptances are re-read at finalize time so a sign-off added after detect still applies.
  for (const item of worklist.items) item.accepted = findAcceptance(config.accepted || [], item.checkId, item.item);

  const verificationDir = path.join(outDir, 'verification');
  const verificationFiles = args.verifications.length ? args.verifications : existsSync(verificationDir) ? readdirSync(verificationDir).filter((f) => f.endsWith('.json')).map((f) => path.join(verificationDir, f)) : [];
  const verifications = [];
  const loadProblems = [];
  for (const f of verificationFiles) {
    try {
      verifications.push(readJson(f));
    } catch (err) {
      loadProblems.push(`could not read verifier output ${f}: ${err.message} — its items stay unverified`);
    }
  }

  const merged = mergeVerifications(worklist, verifications);
  merged.problems.unshift(...loadProblems);
  const effective = applyDecisions(raw.reports, worklist, merged);
  const statuses = effective.map(layerStatus);
  const overall = overallStatus(statuses);

  const reportMd = renderReport({ raw, effective, statuses, overall, merged, verificationFiles: verifications.length ? verificationFiles : [] });
  const reportPath = path.join(outDir, 'preflight-report.md');
  writeFileSync(reportPath, reportMd);
  writeFileSync(path.join(outDir, 'preflight-final.json'), JSON.stringify({ mode: raw.mode, overall, layers: effective.map((r, i) => ({ checker: r.checker, status: statuses[i] })), finalizedAt: new Date().toISOString(), comparison: raw.comparison, verificationFiles, addedFindings: merged.added, problems: merged.problems, reports: effective }, null, 2));

  const postPr = (args.postPr || raw.args?.postPr) && raw.mode === 'pre-merge';
  if (postPr) {
    try {
      const pr = JSON.parse(execFileSync('gh', ['pr', 'view', raw.args.stagingBranch, '--json', 'number,url'], { cwd: args.root, encoding: 'utf-8' }));
      execFileSync('gh', ['pr', 'comment', String(pr.number), '--body-file', '-'], { cwd: args.root, input: reportMd, encoding: 'utf-8' });
      console.error(`Posted preflight report to PR #${pr.number}.`);
    } catch (err) {
      console.error(`Could not post PR comment (${err.message.split('\n')[0]}) — report is still written to ${reportPath}.`);
    }
  }

  const items = effective.flatMap((r) => (r.checks || []).flatMap((c) => c.items || []));
  const n = (s) => items.filter((i) => i.state === s).length;
  console.log(JSON.stringify({ mode: raw.mode, overall, layers: effective.map((r, i) => ({ checker: r.checker, status: statuses[i], raw: raw.rawStatuses?.find((s) => s.checker === r.checker)?.status })), items: { confirmed: n('confirmed'), unverified: n('unverified'), falseAlarm: n('false_alarm'), accepted: n('accepted') }, added: merged.added.length, problems: merged.problems, verificationFiles: verifications.length, reportPath }, null, 2));
  process.exitCode = overall === 'RED' || overall === 'INCOMPLETE' ? 1 : 0;
}

function isRunDirectly() {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  try {
    main();
  } catch (err) {
    console.error(`finalize-preflight.mjs crashed: ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}
