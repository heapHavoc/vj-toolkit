/**
 * paths.mjs — where scans and reports live.
 *
 * One folder per site, theme and page, so a product-page scan never shadows a
 * homepage scan (the old psi-scan keyed folders on site + theme only):
 *   .buildspace/artifacts/perf/scans/<site>/<theme>/<page>/<YYYY-MM-DD-HHMM>/
 *   .buildspace/artifacts/perf/reports/<site>/<kind>-<page>-<YYYY-MM-DD>[-N].md
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const PERF_ROOT = path.join('.buildspace', 'artifacts', 'perf');

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';

export function describeUrl(rawUrl) {
  const u = new URL(rawUrl);
  const site = slug(u.hostname.replace(/^www\./, ''));
  const previewId = u.searchParams.get('preview_theme_id');
  const theme = previewId ? `preview-${previewId}` : 'live';
  const parts = u.pathname.split('/').filter(Boolean);
  let page;
  let pageType;
  if (parts.length === 0) [page, pageType] = ['home', 'Homepage'];
  else if (parts[0] === 'products') [page, pageType] = [`product-${slug(parts[1] || 'all')}`, 'Product page'];
  else if (parts[0] === 'collections' && parts.includes('products')) [page, pageType] = [`product-${slug(parts[parts.length - 1])}`, 'Product page'];
  else if (parts[0] === 'collections') [page, pageType] = [`collection-${slug(parts[1] || 'all')}`, 'Collection page'];
  else if (parts[0] === 'pages') [page, pageType] = [`page-${slug(parts[1] || '')}`, 'Page'];
  else if (parts[0] === 'blogs' && parts.length > 2) [page, pageType] = [`article-${slug(parts[2])}`, 'Article'];
  else if (parts[0] === 'blogs') [page, pageType] = [`blog-${slug(parts[1] || '')}`, 'Blog'];
  else if (parts[0] === 'cart') [page, pageType] = ['cart', 'Cart'];
  else if (parts[0] === 'search') [page, pageType] = ['search', 'Search'];
  else [page, pageType] = [slug(parts.join('-')), 'Page'];
  if (u.searchParams.get('view')) page += `-view-${slug(u.searchParams.get('view'))}`;
  return { site, siteHost: u.hostname, theme, page, pageType, previewId };
}

export function scanDir(root, rawUrl) {
  const d = describeUrl(rawUrl);
  return path.join(root, PERF_ROOT, 'scans', d.site, d.theme, d.page);
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/** Newest finished scan folder for a URL (one that has summary.json), or null. */
export function latestScan(root, rawUrl) {
  const dir = scanDir(root, rawUrl);
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir)
    .filter((n) => existsSync(path.join(dir, n, 'summary.json')))
    .sort();
  return runs.length ? path.join(dir, runs[runs.length - 1]) : null;
}

/** First free report path: <kind>-<page>-<date>.md, then -2, -3… */
export function reportPath(root, site, kind, page, date = new Date()) {
  const dir = path.join(root, PERF_ROOT, 'reports', site);
  const base = `${kind}-${page}-${stamp(date).slice(0, 10)}`;
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${base}${n === 1 ? '' : `-${n}`}.md`);
    if (!existsSync(file)) return file;
  }
}
