/**
 * telemetry.mjs — keep every preflight run and send it to the shared run log.
 *
 * Every run (finalized, baseline, or detected but never finalized) is:
 *   1. archived locally under .buildspace/preflight/runs/<started>-<mode>-<id>/ (last 20 kept), and
 *   2. sent, scrubbed, to Supabase through public.ingest_preflight_run (see ../../telemetry/).
 *
 * Nothing here may change a verdict or an exit code: every failure is logged and swallowed.
 * A failed send is queued in .buildspace/preflight/pending/ and retried on the next run;
 * a send the server rejects as invalid goes to .buildspace/preflight/rejected/ for inspection.
 *
 * Turn sending off with PREFLIGHT_TELEMETRY=0 or `"telemetry": { "enabled": false }` in the
 * project's preflight.config.json. Local history is always kept.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_VERSION = 1;
const DEFAULT_URL = 'https://fwvuofgrwckvnfyclrot.supabase.co';
const DEFAULT_KEY = 'sb_publishable_qMEQ8ietkj4hRBckv_5-3g_jemnqWcT';
const SEND_TIMEOUT_MS = 5000;
const MAX_PAYLOAD_BYTES = 1_800_000;
const RUN_FILES = ['preflight-raw.json', 'verification-worklist.json', 'preflight-final.json', 'preflight-report.md', 'perf-plan.json', 'preflight-baseline.json', 'verification', 'artifacts'];

/* ── settings ─────────────────────────────────────────────────────────── */

export function telemetrySettings(config, env = process.env) {
  const enabled = env.PREFLIGHT_TELEMETRY !== '0' && config?.telemetry?.enabled !== false;
  return {
    enabled,
    url: (env.PREFLIGHT_SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, '').replace(/\/rest\/v1$/, ''),
    key: env.PREFLIGHT_SUPABASE_KEY || DEFAULT_KEY,
    keepRuns: Math.max(1, Number.parseInt(env.PREFLIGHT_KEEP_RUNS || '20', 10) || 20),
  };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function versions() {
  return {
    toolkit: readJsonSafe(path.join(SCRIPTS_DIR, '..', '..', '..', '.claude-plugin', 'plugin.json'))?.version || null,
    preflight: readJsonSafe(path.join(SCRIPTS_DIR, 'package.json'))?.version || null,
  };
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function identity(root) {
  const remote = git(root, ['config', '--get', 'remote.origin.url']);
  const project = remote ? remote.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() : path.basename(root);
  return {
    user_email: git(root, ['config', 'user.email']) || `${os.userInfo().username}@${os.hostname()}`,
    user_name: git(root, ['config', 'user.name']) || os.userInfo().username,
    project,
  };
}

/* ── scrubbing ────────────────────────────────────────────────────────── */

const SECRET_KEY_RE = /password|passwd|secret|token|cookie|authori[sz]ation|api[-_]?key|bearer|credential/i;
const PERSONAL_KEY_RE = /^(e-?mail|phone|client_?id|user_?id|customer_?id|ip|ip_?address|fbp|fbc|_ga|_gid|first_?name|last_?name|full_?name|address[12]?|zip|postal_?code)$/i;
const URL_PARAMS_KEPT = new Set(['preview_theme_id', 'pb', 'view', 'variant', 'page', 'sort_by']);
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;
const URL_RE = /https?:\/\/[^\s"'`<>)\]]+/g;
const FILE_EXT_RE = /\.(png|jpe?g|webp|avif|gif|svg|css|js|mjs|liquid|json|woff2?)$/i;
const TOKEN_SEGMENT_RE = /^[A-Za-z0-9_-]{24,}$/;
const MAX_STRING = 4000;

export function scrubUrl(value) {
  try {
    const u = new URL(value);
    u.username = '';
    u.password = '';
    for (const key of [...u.searchParams.keys()]) if (!URL_PARAMS_KEPT.has(key)) u.searchParams.delete(key);
    u.pathname = u.pathname
      .split('/')
      .map((seg) => (TOKEN_SEGMENT_RE.test(seg) ? ':token' : seg))
      .join('/');
    u.hash = '';
    return u.toString();
  } catch {
    return value.split('?')[0];
  }
}

export function scrubString(value, { home = os.homedir(), keepEmails = [] } = {}) {
  let s = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]` : value;
  if (home && home.length > 1) s = s.split(home).join('~');
  if (s.includes('://')) s = s.replace(URL_RE, (m) => scrubUrl(m));
  return s.includes('@') ? s.replace(EMAIL_RE, (m) => (keepEmails.includes(m) || FILE_EXT_RE.test(m) ? m : '[email]')) : s;
}

/** Deep copy with secrets, personal data, URL query strings and home paths removed. */
export function scrub(value, opts = {}, depth = 0) {
  if (depth > 40) return '[too deep]';
  if (typeof value === 'string') return scrubString(value, opts);
  if (Array.isArray(value)) return value.map((v) => scrub(v, opts, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if ((typeof v === 'string' || (v && typeof v === 'object')) && v !== '' && (SECRET_KEY_RE.test(k) || PERSONAL_KEY_RE.test(k))) out[k] = '[redacted]';
      else out[k] = scrub(v, opts, depth + 1);
    }
    return out;
  }
  return value;
}

/* ── payload ──────────────────────────────────────────────────────────── */

const METRIC_ID_RE = /^PERF-(.+)-(LCP|FCP|TBT|CLS)$/;

function countRuns(x) {
  if (Array.isArray(x)) return x.length;
  if (x && typeof x === 'object') return Object.values(x).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  return null;
}

export function metricsFrom(reports) {
  const rows = [];
  const perf = (reports || []).find((r) => r.checker === 'performance');
  for (const check of perf?.checks || []) {
    const e = check.evidence || {};
    const m = METRIC_ID_RE.exec(check.id || '');
    if (m && (e.medianReference != null || e.medianCurrent != null)) {
      const [, page, metric] = m;
      rows.push({ page, side: e.reference || 'reference', metric, value: e.medianReference ?? null, runs: e.n?.[0] ?? null, excluded: countRuns(e.excludedRuns) });
      rows.push({ page, side: e.current || 'current', metric, value: e.medianCurrent ?? null, runs: e.n?.[1] ?? null, excluded: null });
      continue;
    }
    const b = /^PERF-(.+)$/.exec(check.id || '');
    if (b && check.status === 'INFO' && e.medians) {
      for (const [metric, value] of Object.entries(e.medians)) rows.push({ page: b[1], side: 'baseline', metric: metric.toUpperCase(), value: value ?? null, runs: null, excluded: null });
    }
  }
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.page}|${r.side}|${r.metric}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function changedFileCount(reports) {
  const g5 = (reports || []).find((r) => r.checker === 'code')?.checks?.find((c) => c.id === 'G5');
  if (!g5?.evidence) return null;
  const files = new Set();
  for (const v of Object.values(g5.evidence)) if (Array.isArray(v)) v.forEach((f) => files.add(f));
  return files.size;
}

function checkRows(reports) {
  const rows = [];
  const seen = new Map();
  for (const r of reports || []) {
    for (const c of r.checks || []) {
      const base = `${r.checker}|${c.id}`;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      rows.push({ layer: r.checker, check_id: n ? `${c.id}#${n + 1}` : c.id, check_name: c.name || null, priority: c.priority || null, status: c.status, summary: c.summary || null });
    }
  }
  return rows;
}

function findingRows(effective, worklist) {
  if (effective) {
    const rows = [];
    for (const r of effective) {
      for (const c of r.checks || []) {
        if (c.addedByVerifier) {
          rows.push({ item_id: c.id, layer: r.checker, check_id: c.id, check_name: c.name, priority: c.priority, summary: c.summary, item: null, verdict: 'confirmed', verdict_reason: null, verdict_evidence: c.evidence?.verifierEvidence || null, accepted: false, added_by_verifier: true });
          continue;
        }
        for (const i of c.items || []) {
          rows.push({
            item_id: i.id,
            layer: r.checker,
            check_id: c.id,
            check_name: c.name,
            priority: i.finalPriority || i.priority,
            summary: c.summary,
            item: { ...(i.item && typeof i.item === 'object' ? i.item : { value: i.item }), raw_priority: i.priority, verifier_note: i.decision?.note || undefined },
            verdict: i.decision?.verdict || null,
            verdict_reason: i.decision?.reason || null,
            verdict_evidence: i.decision?.evidence || null,
            accepted: i.state === 'accepted',
            added_by_verifier: false,
          });
        }
      }
    }
    return rows;
  }
  return (worklist?.items || []).map((i) => ({
    item_id: i.id,
    layer: i.layer,
    check_id: i.checkId,
    check_name: i.checkName,
    priority: i.priority,
    summary: i.summary,
    item: i.item && typeof i.item === 'object' ? i.item : { value: i.item },
    verdict: null,
    verdict_reason: null,
    verdict_evidence: null,
    accepted: Boolean(i.accepted),
    added_by_verifier: false,
  }));
}

function fitSize(payload) {
  const size = () => Buffer.byteLength(JSON.stringify(payload));
  if (size() <= MAX_PAYLOAD_BYTES) return payload;
  for (const r of payload.data.reports || []) {
    for (const c of r.checks || []) {
      const ev = JSON.stringify(c.evidence ?? null);
      if (ev.length > 2000) c.evidence = `${ev.slice(0, 2000)}…[truncated]`;
    }
  }
  payload.data.truncated = 'check evidence';
  if (size() <= MAX_PAYLOAD_BYTES) return payload;
  delete payload.data.reports;
  payload.data.truncated = 'reports removed';
  if (size() <= MAX_PAYLOAD_BYTES) return payload;
  payload.findings = payload.findings.map((f) => ({ ...f, item: null, verdict_evidence: f.verdict_evidence?.slice(0, 300) || null }));
  payload.data.truncated = 'reports removed, finding details removed';
  return payload;
}

/**
 * stage: 'finalized' (after finalize), 'detect-only' (detected, never finalized), 'baseline'.
 * raw: preflight-raw.json contents (or an equivalent object for baseline).
 * final: { effective, statuses, overall, merged, verificationCount } when finalized.
 */
export function buildPayload({ stage, raw, final = null, worklist = null, config = null, root, finishedAt = new Date().toISOString(), feedback = null, deps = null }) {
  const reports = final?.effective || raw.reports || [];
  const startedAt = raw.startedAt || raw.generatedAt || null;
  const who = identity(root);
  const v = versions();
  const opts = { keepEmails: [who.user_email] };
  const layers = (raw.reports || []).map((r, i) => ({
    layer: r.checker,
    raw_status: raw.rawStatuses?.find((s) => s.checker === r.checker)?.status || null,
    final_status: final?.statuses?.[i] ?? null,
    duration_ms: Number.isFinite(r.durationMs) ? Math.round(r.durationMs) : null,
    crashed: Boolean(r.crashed),
    error: r.error ? scrubString(String(r.error)) : null,
  }));
  const payload = {
    schema_version: SCHEMA_VERSION,
    run_id: raw.runId,
    mode: raw.mode,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    overall: final?.overall || null,
    toolkit_version: v.toolkit,
    preflight_version: v.preflight,
    ...who,
    store_domain: config?.store ? String(config.store).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null,
    live_ref: raw.refs?.live?.ref || raw.liveBranch || null,
    live_sha: raw.refs?.live?.sha || raw.liveSha || null,
    staging_ref: raw.refs?.staging?.ref || null,
    staging_sha: raw.refs?.staging?.sha || null,
    changed_files: changedFileCount(reports),
    feedback,
    layers,
    checks: checkRows(reports),
    findings: scrub(findingRows(final?.effective || null, worklist), opts),
    metrics: metricsFrom(reports),
    data: scrub(
      {
        stage,
        comparison: raw.comparison || null,
        args: raw.args ? { liveBranch: raw.args.liveBranch, stagingBranch: raw.args.stagingBranch, postPr: raw.args.postPr } : null,
        pages: raw.pages || null,
        themes: raw.pages?.themes || null,
        deps,
        environment: { node: process.versions.node, platform: process.platform, arch: process.arch, ci: Boolean(process.env.CI) },
        verification: final ? { files: final.verificationCount ?? null, problems: final.merged?.problems || [], added: final.merged?.added || [] } : null,
        skippedChecks: worklist?.skipped || null,
        config: config ? { ...config, accepted: config.accepted || [] } : null,
        reports,
      },
      opts
    ),
  };
  return fitSize(payload);
}

/* ── local history ────────────────────────────────────────────────────── */

export function archiveRun(outDir, payload, { keepRuns = 20 } = {}) {
  const runsDir = path.join(outDir, 'runs');
  const started = (payload.started_at || new Date().toISOString()).replace(/[:.]/g, '-').replace(/Z$/, '');
  const dir = path.join(runsDir, `${started}-${payload.mode}-${String(payload.run_id).slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const name of RUN_FILES) {
    const src = path.join(outDir, name);
    if (existsSync(src)) cpSync(src, path.join(dir, name), { recursive: true });
  }
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(payload, null, 2));
  const all = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - keepRuns))) rmSync(path.join(runsDir, old), { recursive: true, force: true });
  return dir;
}

export function latestRunDir(outDir) {
  const runsDir = path.join(outDir, 'runs');
  if (!existsSync(runsDir)) return null;
  const all = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(runsDir, d.name, 'run.json')))
    .map((d) => d.name)
    .sort();
  return all.length ? path.join(runsDir, all[all.length - 1]) : null;
}

export function isArchived(outDir, runId) {
  const runsDir = path.join(outDir, 'runs');
  if (!runId || !existsSync(runsDir)) return false;
  return readdirSync(runsDir).some((d) => d.endsWith(`-${String(runId).slice(0, 8)}`));
}

/* ── sending ──────────────────────────────────────────────────────────── */

async function post(settings, fn, body) {
  try {
    const res = await fetch(`${settings.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: settings.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: 0, body: err.name === 'TimeoutError' ? `timed out after ${SEND_TIMEOUT_MS} ms` : err.message };
  }
}

function sendEnvelope(settings, envelope) {
  return envelope.kind === 'feedback'
    ? post(settings, 'record_preflight_feedback', { p_run_id: envelope.run_id, p_feedback: envelope.feedback })
    : post(settings, 'ingest_preflight_run', { payload: envelope.payload });
}

function park(outDir, folder, envelope, result) {
  const dir = path.join(outDir, folder);
  mkdirSync(dir, { recursive: true });
  const name = `${envelope.kind}-${envelope.run_id}.json`;
  writeFileSync(path.join(dir, name), JSON.stringify({ ...envelope, lastAttempt: new Date().toISOString(), lastResult: result }, null, 2));
}

async function deliverOne(outDir, settings, envelope) {
  const result = await sendEnvelope(settings, envelope);
  if (result.ok) return 'sent';
  const permanent = result.status >= 400 && result.status < 500 && result.status !== 401 && result.status !== 408 && result.status !== 429;
  park(outDir, permanent ? 'rejected' : 'pending', envelope, result);
  return permanent ? `rejected (${result.status}: ${result.body})` : `queued for retry (${result.status || 'network'}: ${result.body})`;
}

export async function flushPending(outDir, settings) {
  const dir = path.join(outDir, 'pending');
  if (!settings.enabled || !existsSync(dir)) return { sent: 0, left: 0 };
  let sent = 0;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => (a.startsWith('run-') === b.startsWith('run-') ? a.localeCompare(b) : a.startsWith('run-') ? -1 : 1));
  for (const f of files) {
    const envelope = readJsonSafe(path.join(dir, f));
    if (!envelope) continue;
    unlinkSync(path.join(dir, f));
    const outcome = await deliverOne(outDir, settings, envelope);
    if (outcome === 'sent') sent++;
  }
  const left = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
  return { sent, left };
}

/** Archive locally, then send (after retrying anything queued). Never throws. */
export async function recordRun({ outDir, payload, settings, log = (m) => process.stderr.write(`${m}\n`) }) {
  let archived = null;
  try {
    archived = archiveRun(outDir, payload, { keepRuns: settings.keepRuns });
  } catch (err) {
    log(`[preflight] could not archive this run locally: ${err.message}`);
  }
  if (!settings.enabled) {
    log('[preflight] run log not sent (telemetry is off for this project).');
    return { archived, sent: 'disabled' };
  }
  try {
    const flushed = await flushPending(outDir, settings);
    if (flushed.sent) log(`[preflight] sent ${flushed.sent} queued run log(s).`);
    const outcome = await deliverOne(outDir, settings, { kind: 'run', run_id: payload.run_id, payload });
    log(`[preflight] run log ${outcome === 'sent' ? 'sent' : outcome}.`);
    return { archived, sent: outcome };
  } catch (err) {
    log(`[preflight] could not send the run log: ${err.message}`);
    return { archived, sent: `error: ${err.message}` };
  }
}

export async function recordFeedback({ outDir, runId, feedback, settings, log = (m) => process.stderr.write(`${m}\n`) }) {
  const text = scrubString(String(feedback)).slice(0, 5000);
  if (!settings.enabled) return 'disabled';
  try {
    await flushPending(outDir, settings);
    const outcome = await deliverOne(outDir, settings, { kind: 'feedback', run_id: runId, feedback: text });
    log(`[preflight] feedback ${outcome === 'sent' ? 'sent' : outcome}.`);
    return outcome;
  } catch (err) {
    log(`[preflight] could not send feedback: ${err.message}`);
    return `error: ${err.message}`;
  }
}
