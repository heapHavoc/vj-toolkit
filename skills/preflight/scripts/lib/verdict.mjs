/**
 * verdict.mjs — the status model, the verification worklist, and the merge of
 * verifier output back into a final verdict. Shared by run-preflight.mjs
 * (detect stage) and finalize-preflight.mjs (verdict stage) so there is
 * exactly one place that decides what a check's status means.
 *
 * Pipeline: detect (checkers) → verify (verifier agents) → finalize (this
 * module + finalize-preflight.mjs). A raw checker FAIL is a *candidate*, not a
 * verdict. The verdict is computed only from verified items.
 *
 * Verifier authority is deliberately asymmetric:
 *   - It can confirm, escalate, or add findings freely.
 *   - It can dismiss (false_alarm) or downgrade a finding only with concrete
 *     evidence (a file:line, a measurement, an artifact path). A dismissal
 *     without evidence is rejected and the item stays `unverified`.
 *   - An item the verifier never returned (crash, timeout, skipped) stays
 *     `unverified` and counts at its original priority. A failed verifier can
 *     therefore never turn RED into GREEN.
 */

/* ── status model ─────────────────────────────────────────────────────── */

export const PRIORITY_RANK = { P0: 3, P1: 2, P2: 1, info: 0 };
export const STATUS_RANK = { RED: 3, INCOMPLETE: 2, YELLOW: 1, GREEN: 0 };

export function maxPriority(priorities) {
  let best = null;
  for (const p of priorities) {
    if (p == null) continue;
    if (best == null || (PRIORITY_RANK[p] ?? -1) > (PRIORITY_RANK[best] ?? -1)) best = p;
  }
  return best;
}

/**
 * Per-layer status. Takes a checker report (raw or effective). Order matters:
 *   RED        — any P0 FAIL.
 *   INCOMPLETE — the checker crashed, any P0 check was SKIPPED, or nothing
 *                was actually tested (no PASS and no FAIL). An untested P0
 *                could be a RED, so it outranks YELLOW.
 *   YELLOW     — any P1 FAIL.
 *   GREEN      — none of the above. P2/info FAILs are notes, not gates.
 */
export function layerStatus(report) {
  if (!report || !Array.isArray(report.checks) || report.crashed) return 'INCOMPLETE';
  const checks = report.checks;
  if (checks.some((c) => c.status === 'FAIL' && c.priority === 'P0')) return 'RED';
  if (checks.some((c) => c.status === 'SKIPPED' && c.priority === 'P0')) return 'INCOMPLETE';
  const tested = checks.some((c) => c.status === 'PASS' || c.status === 'FAIL' || c.status === 'DISMISSED' || c.status === 'ACCEPTED');
  if (!tested) return 'INCOMPLETE';
  if (checks.some((c) => c.status === 'FAIL' && c.priority === 'P1')) return 'YELLOW';
  return 'GREEN';
}

export function overallStatus(layerStatuses) {
  let worst = 'GREEN';
  for (const s of layerStatuses) if ((STATUS_RANK[s] ?? 2) > STATUS_RANK[worst]) worst = STATUS_RANK[s] != null ? s : 'INCOMPLETE';
  return worst;
}

/* ── worklist: explode each FAIL check into individually verifiable items ── */

/** Evidence keys that hold one entry per finding. The first array found wins. */
const ITEM_ARRAY_KEYS = ['findings', 'offenses', 'commits', 'blocks', 'dangling', 'regressedSteps'];

function explodeEvidence(evidence) {
  if (evidence && typeof evidence === 'object') {
    for (const key of ITEM_ARRAY_KEYS) {
      if (Array.isArray(evidence[key]) && evidence[key].length > 0) return evidence[key];
    }
  }
  return [evidence || {}];
}

const VERIFY_HINTS = {
  code: 'Read the cited file/line at the STAGING ref (`git show <stagingRef>:<file>`) and decide whether the rule truly applies in context — shopper-visible vs data attribute/JSON, scoped vs global selector, rendered content vs schema default.',
  performance: 'Use evidence.runs (every individual run, both sides) and evidence.attribution (shifting / LCP elements per run). Trace the element selectors to files in the blast radius. Re-measure the one page with check-performance.mjs if the runs disagree.',
  analytics: 'Read evidence.steps for both sides and the screenshots under .buildspace/preflight/artifacts/analytics/. Decide whether this is a real storefront regression or the journey harness failing to drive the page (selector mismatch, drawer cart, bot wall).',
};

function itemPriority(item, checkPriority) {
  return item && PRIORITY_RANK[item.priority] != null ? item.priority : checkPriority;
}

/** Glob-lite: `*` matches any run of characters. Used for check ids like `PERF-*-CLS`. */
function idMatches(pattern, id) {
  if (!pattern) return false;
  if (!pattern.includes('*')) return pattern === id;
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(id);
}

/**
 * config.accepted[] — a finding a human has reviewed and signed off on.
 * { check, rule?, file?, match?, reason, by?, date? }. `reason` is required;
 * an entry without one is ignored (acceptance must say why).
 */
export function findAcceptance(accepted, checkId, item) {
  if (!Array.isArray(accepted)) return null;
  for (const a of accepted) {
    if (!a || !a.reason || !idMatches(a.check, checkId)) continue;
    if (a.rule && a.rule !== item?.ruleId && a.rule !== item?.kind && a.rule !== item?.pattern) continue;
    if (a.file) {
      const files = [item?.file, ...(Array.isArray(item?.files) ? item.files : [])].filter(Boolean);
      if (!files.includes(a.file)) continue;
    }
    if (a.match && !JSON.stringify(item ?? {}).includes(a.match)) continue;
    return { reason: a.reason, by: a.by || null, date: a.date || null };
  }
  return null;
}

/** Build the verification worklist from the merged raw reports. */
export function buildWorklist(reports, { accepted = [], stagingRef = null, liveRef = null } = {}) {
  const items = [];
  const skipped = [];
  for (const report of reports) {
    const layer = report.checker;
    for (const check of report.checks || []) {
      if (check.status === 'SKIPPED') {
        skipped.push({ layer, checkId: check.id, checkName: check.name, priority: check.priority, reason: check.summary });
        continue;
      }
      if (check.status !== 'FAIL') continue;
      const parts = explodeEvidence(check.evidence);
      parts.forEach((part, i) => {
        const id = parts.length > 1 ? `${layer}:${check.id}#${i}` : `${layer}:${check.id}`;
        items.push({
          id,
          layer,
          checkId: check.id,
          checkName: check.name,
          priority: itemPriority(part, check.priority),
          summary: check.summary,
          risk: check.risk,
          item: part,
          accepted: findAcceptance(accepted, check.id, part),
          hint: VERIFY_HINTS[layer] || null,
        });
      });
    }
  }
  return { generatedAt: new Date().toISOString(), stagingRef, liveRef, items, skipped };
}

/* ── merging verifier output ───────────────────────────────────────────── */

const VERDICTS = new Set(['confirmed', 'false_alarm', 'unverified']);

/** Evidence must point at something checkable: a file(:line), a measurement, or an artifact. */
const CONCRETE_EVIDENCE_RE = /([\w@./-]+\.(liquid|json|css|js|mjs|png|jpe?g|md|txt)(:\d+)?)|(\d+(\.\d+)?\s*(ms|%|s\b))|(\brun\s*#?\d+)|(artifacts\/)|(\b(cls|lcp|tbt)\b[^.]*\d)/i;

export function hasConcreteEvidence(evidence) {
  return typeof evidence === 'string' && evidence.trim().length >= 12 && CONCRETE_EVIDENCE_RE.test(evidence);
}

/**
 * Merge one or more verification payloads into per-item decisions.
 * Returns { decisions: Map<itemId, decision>, added: [], problems: [] }.
 */
export function mergeVerifications(worklist, verifications) {
  const byId = new Map(worklist.items.map((i) => [i.id, i]));
  const decisions = new Map();
  const added = [];
  const problems = [];

  for (const v of verifications) {
    for (const entry of v?.items || []) {
      const item = byId.get(entry?.id);
      if (!item) {
        problems.push(`verifier returned unknown item id "${entry?.id}" — ignored`);
        continue;
      }
      let verdict = VERDICTS.has(entry.verdict) ? entry.verdict : 'unverified';
      let finalPriority = PRIORITY_RANK[entry.final_priority] != null ? entry.final_priority : item.priority;
      const note = [];
      const lowering = (PRIORITY_RANK[finalPriority] ?? 0) < (PRIORITY_RANK[item.priority] ?? 0);
      if ((verdict === 'false_alarm' || lowering) && !hasConcreteEvidence(entry.evidence)) {
        note.push(`${verdict === 'false_alarm' ? 'dismissal' : 'downgrade'} rejected — no concrete evidence (file:line, measurement, or artifact) given`);
        verdict = verdict === 'false_alarm' ? 'unverified' : verdict;
        finalPriority = item.priority;
      }
      decisions.set(item.id, { verdict, finalPriority, evidence: entry.evidence || '', reason: entry.reason || '', note: note.join('; '), verifier: v.verifier || v.layer || null });
    }
    for (const a of v?.added || []) {
      if (!a || !a.summary || PRIORITY_RANK[a.priority] == null) {
        problems.push('verifier added a finding without summary/priority — ignored');
        continue;
      }
      added.push({ layer: a.layer || v.layer || 'unknown', id: a.id || `VER-${added.length + 1}`, priority: a.priority, summary: a.summary, evidence: a.evidence || '', risk: a.risk || '' });
    }
  }

  for (const item of worklist.items) {
    if (!decisions.has(item.id)) decisions.set(item.id, { verdict: 'unverified', finalPriority: item.priority, evidence: '', reason: '', note: 'not returned by any verifier', verifier: null });
  }
  return { decisions, added, problems };
}

/**
 * Rebuild each layer's checks from item decisions. A FAIL check becomes:
 *   FAIL (at the highest remaining item priority) if any item is confirmed or unverified,
 *   ACCEPTED if every remaining item was accepted in config,
 *   DISMISSED if every item was a verified false alarm (or accepted).
 * Added findings become extra FAIL checks on their layer.
 */
export function applyDecisions(reports, worklist, merged) {
  const itemsByCheck = new Map();
  for (const item of worklist.items) {
    const key = `${item.layer}::${item.checkId}`;
    if (!itemsByCheck.has(key)) itemsByCheck.set(key, []);
    itemsByCheck.get(key).push(item);
  }

  return reports.map((report) => {
    const checks = (report.checks || []).map((check) => {
      if (check.status !== 'FAIL') return check;
      const items = itemsByCheck.get(`${report.checker}::${check.id}`) || [];
      const resolved = items.map((item) => {
        const d = merged.decisions.get(item.id);
        const state = item.accepted ? 'accepted' : d.verdict;
        return { ...item, decision: d, state, finalPriority: item.accepted ? item.priority : d.finalPriority };
      });
      const open = resolved.filter((r) => r.state === 'confirmed' || r.state === 'unverified');
      if (open.length > 0) {
        return { ...check, status: 'FAIL', rawPriority: check.priority, priority: maxPriority(open.map((r) => r.finalPriority)), items: resolved };
      }
      const allAccepted = resolved.length > 0 && resolved.every((r) => r.state === 'accepted');
      return { ...check, status: allAccepted ? 'ACCEPTED' : 'DISMISSED', rawPriority: check.priority, items: resolved };
    });
    for (const a of merged.added.filter((x) => x.layer === report.checker)) {
      checks.push({ id: a.id, name: 'Added by verifier', priority: a.priority, status: 'FAIL', summary: a.summary, evidence: { verifierEvidence: a.evidence }, risk: a.risk, addedByVerifier: true });
    }
    return { ...report, checks };
  });
}
