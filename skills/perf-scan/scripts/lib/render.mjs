/**
 * render.mjs — scan.md, the human-readable scan every perf report reads.
 *
 * Column order is always Mobile | Desktop. A section whose audits don't exist in
 * this Lighthouse version says so, instead of rendering an empty table.
 */

import { LAB_METRICS } from './extract.mjs';

const kib = (b) => (b == null ? '—' : `${(b / 1024).toFixed(1)} KiB`);
const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const metricVal = (key, v) => (v == null ? '—' : key === 'CLS' ? Number(v).toFixed(3) : ms(v));
const cell = (s) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '_None._');
const short = (u, n = 90) => {
  if (!u) return '—';
  const s = String(u).replace(/^https?:\/\//, '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function fieldBlock(f) {
  if (!f) return '_No real-user (CrUX) data for this page or its origin. Lab results below are a controlled test, not what visitors experience._';
  const lines = [];
  lines.push(`Source: **${f.originFallback ? 'whole site (origin)' : 'this page'}** — 75th percentile of real Chrome users over the last 28 days.`);
  lines.push('');
  lines.push(`**Core Web Vitals assessment: ${f.cwvPassed == null ? 'Not enough data' : f.cwvPassed ? 'PASSED' : 'FAILED'}**`);
  lines.push('');
  lines.push(table(['Metric', 'p75', 'Rating', 'Core Web Vital'], Object.entries(f.metrics).map(([k, m]) => [k, k === 'CLS' ? m.p75.toFixed(2) : ms(m.p75), m.rating, m.cwv ? 'Yes' : 'No'])));
  return lines.join('\n');
}

function itemsTable(section, cols) {
  const rows = section.audits.flatMap((a) => a.items.map((i) => cols.map((c) => c.get(i, a))));
  return table(cols.map((c) => c.head), rows.slice(0, 25));
}

function sectionOrMissing(section, render) {
  if (!section.used.length) return `_Not reported by this Lighthouse version (looked for: ${section.ids.join(', ')})._`;
  return render(section);
}

function deviceBlock(label, d) {
  const e = d.median;
  const c = d.combined;
  const out = [];
  out.push(`## ${label}`);
  out.push('');
  out.push(`Performance score: **${c.scores.performance?.value ?? '—'}/100** (median of ${c.runs} run${c.runs === 1 ? '' : 's'}${c.runs > 1 ? `, range ${c.scores.performance?.min}–${c.scores.performance?.max}` : ''}). Details below come from the median run.`);
  out.push('');
  out.push('### Lab metrics');
  out.push(table(['Metric', 'Median', 'Range', 'Rating'], LAB_METRICS.map((m) => {
    const v = c.lab[m.key];
    return [`${m.name} (${m.key})`, metricVal(m.key, v?.value), v && c.runs > 1 ? `${metricVal(m.key, v.min)} – ${metricVal(m.key, v.max)}` : '—', v?.rating];
  })));
  out.push('');
  out.push('### LCP element');
  out.push(e.lcp.node ? `\`${short(e.lcp.node.snippet || e.lcp.node.selector, 200)}\`${e.lcp.node.selector ? ` (selector: \`${e.lcp.node.selector}\`)` : ''}` : '_Not reported._');
  if (e.lcp.phases.length) {
    out.push('');
    out.push(table(['LCP phase', 'Time'], e.lcp.phases.map((p) => [p.phase, ms(p.ms)])));
  }
  out.push('');
  out.push('### Insights and opportunities (failing, biggest estimated savings first)');
  out.push(table(['Audit', 'Estimate', 'Est. savings'], e.insights.map((i) => [i.title, i.displayValue, Object.entries(i.metricSavings || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${k === 'CLS' ? v : ms(v)}`).join(', ') || '—'])));
  const s = e.sections;
  out.push('');
  out.push('### Render-blocking resources');
  out.push(sectionOrMissing(s.renderBlocking, (x) => itemsTable(x, [{ head: 'Resource', get: (i) => short(i.url) }, { head: 'Size', get: (i) => kib(i.totalBytes ?? i.transferSize) }, { head: 'Blocking', get: (i) => ms(i.wastedMs) }])));
  out.push('');
  out.push('### Images');
  out.push(sectionOrMissing(s.imageDelivery, (x) => itemsTable(x, [{ head: 'Audit', get: (_, a) => a.id }, { head: 'Image', get: (i) => short(i.url || i.node?.snippet) }, { head: 'Size', get: (i) => kib(i.totalBytes) }, { head: 'Wasted', get: (i) => kib(i.wastedBytes) }])));
  out.push('');
  out.push('### Third parties');
  out.push(sectionOrMissing(s.thirdParties, (x) => itemsTable({ ...x, audits: x.audits.map((a) => ({ ...a, items: a.items.filter((i) => !i.parent) })) }, [{ head: 'Entity', get: (i) => i.entity || short(i.url) }, { head: 'Transfer', get: (i) => kib(i.transferSize) }, { head: 'Main thread', get: (i) => ms(i.mainThreadTime) }, { head: 'Blocking', get: (i) => ms(i.blockingTime) }])));
  out.push('');
  out.push('### Third-party resources');
  out.push(sectionOrMissing(s.thirdParties, (x) => itemsTable({ ...x, audits: x.audits.map((a) => ({ ...a, items: a.items.filter((i) => i.parent) })) }, [{ head: 'Entity', get: (i) => i.parent }, { head: 'Resource', get: (i) => short(i.url) }, { head: 'Transfer', get: (i) => kib(i.transferSize) }, { head: 'Main thread', get: (i) => ms(i.mainThreadTime) }])));
  out.push('');
  out.push('### JavaScript execution time (per script)');
  out.push(sectionOrMissing(s.bootup, (x) => itemsTable(x, [{ head: 'Script', get: (i) => short(i.url) }, { head: 'Total CPU', get: (i) => ms(i.total) }, { head: 'Scripting', get: (i) => ms(i.scripting) }])));
  out.push('');
  out.push('### Main-thread work');
  out.push(sectionOrMissing(s.mainThread, (x) => itemsTable(x, [{ head: 'Category', get: (i) => i.groupLabel || i.group }, { head: 'Time', get: (i) => ms(i.duration) }])));
  out.push('');
  out.push('### Unused JavaScript');
  out.push(sectionOrMissing(s.unusedJs, (x) => itemsTable(x, [{ head: 'Script', get: (i) => short(i.url) }, { head: 'Size', get: (i) => kib(i.totalBytes) }, { head: 'Unused', get: (i) => kib(i.wastedBytes) }])));
  out.push('');
  out.push('### Unused CSS');
  out.push(sectionOrMissing(s.unusedCss, (x) => itemsTable(x, [{ head: 'Stylesheet', get: (i) => short(i.url) }, { head: 'Size', get: (i) => kib(i.totalBytes) }, { head: 'Unused', get: (i) => kib(i.wastedBytes) }])));
  out.push('');
  out.push('### Caching');
  out.push(sectionOrMissing(s.cache, (x) => itemsTable(x, [{ head: 'Resource', get: (i) => short(i.url) }, { head: 'Cache TTL', get: (i) => (i.cacheLifetimeMs ? ms(i.cacheLifetimeMs) : 'none') }, { head: 'Size', get: (i) => kib(i.totalBytes ?? i.transferSize) }])));
  out.push('');
  out.push('### Layout shifts');
  out.push(sectionOrMissing(s.layoutShifts, (x) => itemsTable(x, [{ head: 'Element / cause', get: (i) => short(i.node?.snippet || i.node?.label || i.label || i.url) }, { head: 'Score', get: (i) => (i.score == null ? '—' : Number(i.score).toFixed(3)) }])));
  out.push('');
  out.push('### Fonts');
  out.push(sectionOrMissing(s.fonts, (x) => itemsTable(x, [{ head: 'Font', get: (i) => short(i.url) }, { head: 'Wasted', get: (i) => ms(i.wastedMs) }])));
  out.push('');
  out.push('### Page weight (largest resources)');
  out.push(sectionOrMissing(s.payload, (x) => `Total: **${x.audits[0].displayValue || '—'}**\n\n${itemsTable(x, [{ head: 'Resource', get: (i) => short(i.url) }, { head: 'Size', get: (i) => kib(i.totalBytes) }])}`));
  out.push('');
  out.push('### DOM size, duplicated and legacy JavaScript, server response');
  out.push(table(['Audit', 'Result'], [s.domSize, s.duplicatedJs, s.legacyJs, s.documentLatency].flatMap((x) => x.audits.map((a) => [a.title, a.displayValue || (a.score === 1 ? 'Passed' : a.score == null ? '—' : 'Needs work')]))));
  for (const [cat, label] of [['accessibility', 'Accessibility'], ['bestPractices', 'Best practices'], ['seo', 'SEO']]) {
    out.push('');
    out.push(`### ${label} — failing audits (score ${c.scores[cat]?.value ?? '—'}/100)`);
    const f = e.failures[cat];
    out.push(f == null ? '_Category not run._' : table(['Audit', 'Score', 'Sample elements'], f.map((x) => [x.title, x.score, x.samples.map((s) => short(s, 60)).join('; ') || '—'])));
  }
  if (e.missingSections.length) {
    out.push('');
    out.push(`> Not available in Lighthouse ${e.lighthouseVersion}: ${e.missingSections.join(', ')}.`);
  }
  if (e.runWarnings.length) {
    out.push('');
    out.push(`> Lighthouse warnings: ${e.runWarnings.map((w) => w.replace(/\s+/g, ' ')).join(' / ')}`);
  }
  return out.join('\n');
}

export function renderScan(summary) {
  const { meta, devices } = summary;
  const order = ['mobile', 'desktop'].filter((d) => devices[d]);
  const any = devices[order[0]].median;
  const out = [];
  out.push(`# PageSpeed scan: ${meta.siteHost} — ${meta.pageType}`);
  out.push('');
  out.push(table(['', ''], [
    ['URL', meta.url],
    ['Page', `${meta.pageType} (\`${meta.page}\`)`],
    ['Theme', meta.theme],
    ['Date', meta.date],
    ['Runs', `${meta.runs} per device, median reported`],
    ['Lighthouse', any.lighthouseVersion || '—'],
    ['Final URL', any.url || '—'],
  ]));
  if (any.url && meta.url && new URL(any.url).pathname !== new URL(meta.url).pathname) {
    out.push('');
    out.push(`> **Redirected:** PageSpeed measured \`${any.url}\`, not the requested URL. If this was a preview URL, the preview parameter may have been dropped and the live theme measured.`);
  }
  out.push('');
  out.push('## Scores');
  out.push(table(['Category', ...order.map((d) => d[0].toUpperCase() + d.slice(1))], [['Performance', 'performance'], ['Accessibility', 'accessibility'], ['Best practices', 'bestPractices'], ['SEO', 'seo']].map(([l, k]) => [l, ...order.map((d) => (devices[d].combined.scores[k] ? `${devices[d].combined.scores[k].value}/100` : '—'))])));
  out.push('');
  out.push('## Real users (field data, CrUX)');
  for (const d of order) {
    const f = devices[d].median.field;
    out.push('');
    out.push(`### ${d[0].toUpperCase() + d.slice(1)}`);
    out.push(fieldBlock(f.best));
  }
  for (const d of order) {
    out.push('');
    out.push(deviceBlock(`${d[0].toUpperCase() + d.slice(1)} (lab)`, devices[d]));
  }
  out.push('');
  return out.join('\n');
}
