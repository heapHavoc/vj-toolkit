/**
 * extract.mjs — turn one PageSpeed Insights v5 response into plain data.
 *
 * Lighthouse 12/13 replaced many "opportunity" audits with "insight" audits
 * (e.g. render-blocking-resources → render-blocking-insight). Every lookup here
 * tries the current id first and the older id second, and records which audits
 * were missing so a report never shows an empty table as if it were "no issues".
 * Removed metrics are not read: Time to Interactive is gone, and INP has no lab
 * value — INP comes only from field (CrUX) data.
 */

export const LAB_METRICS = [
  { key: 'FCP', id: 'first-contentful-paint', name: 'First Contentful Paint', unit: 'ms' },
  { key: 'LCP', id: 'largest-contentful-paint', name: 'Largest Contentful Paint', unit: 'ms' },
  { key: 'TBT', id: 'total-blocking-time', name: 'Total Blocking Time', unit: 'ms' },
  { key: 'CLS', id: 'cumulative-layout-shift', name: 'Cumulative Layout Shift', unit: '' },
  { key: 'SI', id: 'speed-index', name: 'Speed Index', unit: 'ms' },
];

export const FIELD_METRICS = [
  { key: 'LCP', id: 'LARGEST_CONTENTFUL_PAINT_MS', cwv: true },
  { key: 'INP', id: 'INTERACTION_TO_NEXT_PAINT', cwv: true },
  { key: 'CLS', id: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', cwv: true },
  { key: 'FCP', id: 'FIRST_CONTENTFUL_PAINT_MS', cwv: false },
  { key: 'TTFB', id: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE', cwv: false },
];

const FIELD_RATING = { FAST: 'Good', AVERAGE: 'Needs improvement', SLOW: 'Poor' };

export const SECTIONS = {
  lcpElement: ['lcp-breakdown-insight', 'lcp-phases-insight', 'largest-contentful-paint-element'],
  lcpDiscovery: ['lcp-discovery-insight', 'prioritize-lcp-image', 'lcp-lazy-loaded'],
  renderBlocking: ['render-blocking-insight', 'render-blocking-resources'],
  imageDelivery: ['image-delivery-insight', 'uses-responsive-images', 'uses-optimized-images', 'modern-image-formats', 'offscreen-images', 'unsized-images'],
  cache: ['cache-insight', 'uses-long-cache-ttl'],
  thirdParties: ['third-parties-insight', 'third-party-summary'],
  layoutShifts: ['cls-culprits-insight', 'layout-shifts', 'layout-shift-elements'],
  fonts: ['font-display-insight', 'font-display'],
  domSize: ['dom-size-insight', 'dom-size'],
  duplicatedJs: ['duplicated-javascript-insight', 'duplicated-javascript'],
  legacyJs: ['legacy-javascript-insight', 'legacy-javascript'],
  documentLatency: ['document-latency-insight', 'server-response-time', 'redirects'],
  networkDependency: ['network-dependency-tree-insight', 'critical-request-chains'],
  unusedJs: ['unused-javascript'],
  unusedCss: ['unused-css-rules'],
  bootup: ['bootup-time'],
  mainThread: ['mainthread-work-breakdown'],
  payload: ['total-byte-weight'],
  longTasks: ['long-tasks'],
};

const ITEM_FIELDS = ['url', 'entity', 'totalBytes', 'wastedBytes', 'wastedMs', 'transferSize', 'mainThreadTime', 'blockingTime', 'cacheLifetimeMs', 'total', 'scripting', 'scriptParseCompile', 'groupLabel', 'group', 'duration', 'startTime', 'score', 'label', 'subpart', 'phase', 'requestCount', 'value', 'statistic'];

function textOf(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'object') return v.text ?? v.value ?? v.url ?? null;
  return null;
}

function slimItem(item) {
  if (!item || typeof item !== 'object') return item;
  const out = {};
  for (const f of ITEM_FIELDS) if (item[f] != null) out[f] = typeof item[f] === 'object' ? textOf(item[f]) : item[f];
  const node = item.node || (item.type === 'node' ? item : null);
  if (node) out.node = { snippet: node.snippet || null, selector: node.selector || null, label: node.nodeLabel || null };
  return out;
}

/** Every table row inside an audit's details, however deeply Lighthouse nested it. */
export function tableItems(details, depth = 0) {
  if (!details || depth > 4) return [];
  if (Array.isArray(details.items) && (details.type === 'table' || details.type === 'opportunity')) {
    const rows = [];
    for (const it of details.items) {
      rows.push(slimItem(it));
      if (it?.subItems?.items) for (const s of it.subItems.items) rows.push({ ...slimItem(s), parent: textOf(it.url) || textOf(it.entity) || null });
    }
    return rows;
  }
  if (Array.isArray(details.items)) return details.items.flatMap((d) => tableItems(d, depth + 1));
  return [];
}

export function findNode(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  if (value.type === 'node' && (value.snippet || value.selector)) return { snippet: value.snippet || null, selector: value.selector || null, label: value.nodeLabel || null };
  if (value.node && (value.node.snippet || value.node.selector)) return findNode({ ...value.node, type: 'node' }, depth + 1);
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    const n = findNode(v, depth + 1);
    if (n) return n;
  }
  return null;
}

function auditSummary(id, a) {
  return {
    id,
    title: a.title || id,
    score: a.score ?? null,
    scoreDisplayMode: a.scoreDisplayMode || null,
    displayValue: a.displayValue || null,
    metricSavings: a.metricSavings || null,
    items: tableItems(a.details),
  };
}

function section(audits, ids) {
  const present = ids.filter((id) => audits[id]);
  return { ids, used: present, audits: present.map((id) => auditSummary(id, audits[id])) };
}

function lcpPhases(audits) {
  for (const id of SECTIONS.lcpElement) {
    const rows = tableItems(audits[id]?.details).filter((r) => r.subpart || r.phase || r.label);
    if (rows.length) return rows.map((r) => ({ phase: r.subpart || r.phase || r.label, ms: Math.round(r.duration ?? r.value ?? r.startTime ?? 0) }));
  }
  return [];
}

function field(exp) {
  if (!exp || !exp.metrics) return null;
  const metrics = {};
  for (const m of FIELD_METRICS) {
    const d = exp.metrics[m.id];
    if (!d) continue;
    const p75 = m.key === 'CLS' ? d.percentile / 100 : d.percentile;
    metrics[m.key] = { p75, rating: FIELD_RATING[d.category] || d.category || null, cwv: m.cwv };
  }
  const cwvKeys = FIELD_METRICS.filter((m) => m.cwv).map((m) => m.key);
  const haveAll = cwvKeys.every((k) => metrics[k]);
  const passed = haveAll ? cwvKeys.every((k) => metrics[k].rating === 'Good') : null;
  return { id: exp.id || null, originFallback: Boolean(exp.origin_fallback), overall: exp.overall_category || null, cwvPassed: passed, metrics };
}

/** Page-level field data when Chrome has enough of it, else the whole origin's. */
function bestField(page, origin) {
  const hasMetrics = (f) => f && Object.keys(f.metrics).length > 0;
  const best = hasMetrics(page) ? page : hasMetrics(origin) ? { ...origin, originFallback: true } : null;
  return { page, origin, best };
}

function categoryFailures(lhr, cat) {
  const c = lhr.categories?.[cat];
  if (!c) return null;
  return c.auditRefs
    .map((r) => ({ id: r.id, a: lhr.audits[r.id] }))
    .filter(({ a }) => a && a.score != null && a.score < 1 && a.scoreDisplayMode !== 'notApplicable' && a.scoreDisplayMode !== 'informative' && a.scoreDisplayMode !== 'manual')
    .map(({ id, a }) => ({ id, title: a.title, score: a.score, samples: tableItems(a.details).slice(0, 5).map((i) => i.node?.snippet || i.url || i.label || null).filter(Boolean) }));
}

export function extract(psi) {
  const lhr = psi.lighthouseResult;
  if (!lhr) throw new Error('response has no lighthouseResult');
  const audits = lhr.audits || {};
  const score = (k) => (lhr.categories?.[k]?.score == null ? null : Math.round(lhr.categories[k].score * 100));
  const lab = {};
  for (const m of LAB_METRICS) {
    const a = audits[m.id];
    lab[m.key] = a ? { value: a.numericValue ?? null, display: a.displayValue || null, score: a.score ?? null, rating: rating(a.score) } : null;
  }
  const sections = Object.fromEntries(Object.entries(SECTIONS).map(([k, ids]) => [k, section(audits, ids)]));
  const lcpNode = SECTIONS.lcpElement.map((id) => findNode(audits[id]?.details)).find(Boolean) || null;
  const insights = Object.entries(audits)
    .filter(([id, a]) => (id.endsWith('-insight') || a.details?.type === 'opportunity') && a.score != null && a.score < 1 && a.scoreDisplayMode !== 'notApplicable')
    .map(([id, a]) => ({ id, title: a.title, displayValue: a.displayValue || null, metricSavings: a.metricSavings || null, score: a.score }))
    .sort((x, y) => (y.metricSavings?.LCP || 0) + (y.metricSavings?.FCP || 0) + (y.metricSavings?.TBT || 0) - ((x.metricSavings?.LCP || 0) + (x.metricSavings?.FCP || 0) + (x.metricSavings?.TBT || 0)));
  const missingSections = Object.entries(sections).filter(([, s]) => s.used.length === 0).map(([k]) => k);
  return {
    url: lhr.finalDisplayedUrl || lhr.finalUrl || psi.id || null,
    requestedUrl: lhr.requestedUrl || psi.id || null,
    fetchTime: lhr.fetchTime || null,
    lighthouseVersion: lhr.lighthouseVersion || null,
    strategy: lhr.configSettings?.formFactor || null,
    runWarnings: lhr.runWarnings || [],
    scores: { performance: score('performance'), accessibility: score('accessibility'), bestPractices: score('best-practices'), seo: score('seo') },
    lab,
    field: bestField(field(psi.loadingExperience), field(psi.originLoadingExperience)),
    lcp: { node: lcpNode, phases: lcpPhases(audits) },
    insights,
    sections,
    missingSections,
    failures: { accessibility: categoryFailures(lhr, 'accessibility'), bestPractices: categoryFailures(lhr, 'best-practices'), seo: categoryFailures(lhr, 'seo') },
  };
}

export function rating(score) {
  if (score == null) return null;
  if (score >= 0.9) return 'Good';
  if (score >= 0.5) return 'Needs improvement';
  return 'Poor';
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Index of the run whose performance score is the median — its details represent the page. */
export function medianRunIndex(extracts) {
  const scored = extracts.map((e, i) => ({ i, s: e.scores.performance ?? -1 })).sort((a, b) => a.s - b.s);
  return scored[Math.floor((scored.length - 1) / 2)].i;
}

/** Median of each lab metric and score across runs, plus the spread. */
export function combineRuns(extracts) {
  const lab = {};
  for (const m of LAB_METRICS) {
    const values = extracts.map((e) => e.lab[m.key]?.value).filter((x) => x != null);
    const scores = extracts.map((e) => e.lab[m.key]?.score).filter((x) => x != null);
    const s = median(scores);
    lab[m.key] = values.length ? { value: median(values), min: Math.min(...values), max: Math.max(...values), score: s, rating: rating(s) } : null;
  }
  const scores = {};
  for (const k of ['performance', 'accessibility', 'bestPractices', 'seo']) {
    const v = extracts.map((e) => e.scores[k]).filter((x) => x != null);
    scores[k] = v.length ? { value: Math.round(median(v)), min: Math.min(...v), max: Math.max(...v) } : null;
  }
  return { runs: extracts.length, lab, scores, medianRun: medianRunIndex(extracts) };
}
