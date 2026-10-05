/**
 * page-map.mjs — which storefront pages does this release actually touch?
 *
 * Builds a file-level dependency graph of the theme at the staging ref
 * (template JSON → sections → blocks/snippets → assets, layout → everything
 * it renders), then maps the diff onto the configured pages. The result
 * drives which pages performance/analytics test, and which changed templates
 * have no page configured at all (a coverage gap — reported, never silently
 * ignored).
 *
 * The graph is static and conservative: a reference built dynamically at
 * runtime (e.g. `render block.type`) cannot be seen. Changed theme files the
 * graph cannot place are returned as `unmapped` so the caller can fall back
 * to the always-tested pages and say so.
 */

import { execFileSync } from 'node:child_process';

const THEME_DIRS = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];
const GLOBAL_PREFIXES = ['config/', 'locales/'];
export const DEFAULT_IGNORED_TEMPLATES = ['customers/*', 'gift_card*', 'robots.txt', 'password'];

/* ── reading the theme at a ref ───────────────────────────────────────── */

export function readThemeAtRef(root, ref) {
  const list = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', ...THEME_DIRS], { cwd: root, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 })
    .split('\n')
    .filter(Boolean);
  const files = new Map();
  if (list.length === 0) return files;
  const input = list.map((f) => `${ref}:${f}`).join('\n') + '\n';
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input, maxBuffer: 1024 * 1024 * 512 });
  let pos = 0;
  for (const file of list) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.slice(pos, nl).toString('utf-8');
    const size = parseInt(header.split(' ')[2], 10);
    pos = nl + 1;
    if (Number.isNaN(size)) continue; // "missing"
    const isText = /\.(liquid|json|css|js|svg|txt|md)$/.test(file);
    files.set(file, isText ? out.slice(pos, pos + size).toString('utf-8') : '');
    pos += size + 1;
  }
  return files;
}

/* ── dependency graph ─────────────────────────────────────────────────── */

function stripLeadingComment(content) {
  return content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
}

function extractSchema(content) {
  const m = content.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function jsonBlockTypes(blocks, out) {
  if (!blocks || typeof blocks !== 'object') return;
  for (const block of Object.values(blocks)) {
    if (block && typeof block.type === 'string') out.add(block.type);
    if (block && block.blocks) jsonBlockTypes(block.blocks, out);
  }
}

function liquidDeps(content, files, addDep) {
  const add = (p) => files.has(p) && addDep(p);
  for (const m of content.matchAll(/(?:\{%-?|\n)\s*(?:render|include)\s+['"]([^'"]+)['"]/g)) add(`snippets/${m[1]}.liquid`);
  for (const m of content.matchAll(/\{%-?\s*section\s+['"]([^'"]+)['"]/g)) add(`sections/${m[1]}.liquid`);
  for (const m of content.matchAll(/\{%-?\s*sections\s+['"]([^'"]+)['"]/g)) add(`sections/${m[1]}.json`);
  for (const m of content.matchAll(/content_for\s+['"]block['"]\s*,\s*type:\s*['"]([^'"]+)['"]/g)) add(`blocks/${m[1]}.liquid`);
  // Any quoted asset filename — covers `'x.css' | asset_url`, `filename: 'x.css'`, and similar loaders.
  for (const m of content.matchAll(/['"]([\w.\-]+\.(?:css|js|svg|png|jpe?g|webp|gif|woff2?|json))['"]/g)) {
    add(`assets/${m[1]}`);
    add(`assets/${m[1]}.liquid`);
  }
  const schema = extractSchema(content);
  for (const b of schema?.blocks || []) {
    if (b?.type === '@theme') {
      for (const f of files.keys()) if (f.startsWith('blocks/')) addDep(f);
    } else if (typeof b?.type === 'string' && !b.type.startsWith('@')) add(`blocks/${b.type}.liquid`);
  }
}

export function buildDependencyGraph(files) {
  const graph = new Map();
  for (const [file, content] of files) {
    const deps = new Set();
    const addDep = (p) => p !== file && deps.add(p);
    if (file.endsWith('.json') && (file.startsWith('templates/') || file.startsWith('sections/'))) {
      let data = null;
      try {
        data = JSON.parse(stripLeadingComment(content));
      } catch {}
      if (data) {
        for (const sec of Object.values(data.sections || {})) {
          if (typeof sec?.type === 'string' && !sec.type.startsWith('shopify://')) {
            if (files.has(`sections/${sec.type}.liquid`)) addDep(`sections/${sec.type}.liquid`);
          }
          const types = new Set();
          jsonBlockTypes(sec?.blocks, types);
          for (const t of types) if (!t.startsWith('@') && !t.startsWith('shopify://') && files.has(`blocks/${t}.liquid`)) addDep(`blocks/${t}.liquid`);
        }
      }
    } else if (file.endsWith('.liquid')) {
      liquidDeps(content, files, addDep);
    }
    if (file.startsWith('assets/') && /\.(css|js)(\.liquid)?$/.test(file)) {
      // url(...) in stylesheets and import/export specifiers in modules.
      const refs = [...content.matchAll(/url\(\s*['"]?([^'")?#]+)/g), ...content.matchAll(/(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)];
      for (const m of refs) {
        const name = m[1].split('/').pop();
        if (name && files.has(`assets/${name}`)) addDep(`assets/${name}`);
      }
    }
    graph.set(file, deps);
  }
  return graph;
}

export function closureOf(graph, starts) {
  const seen = new Set();
  const queue = starts.filter((s) => graph.has(s));
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of graph.get(f) || []) if (!seen.has(d)) queue.push(d);
  }
  return seen;
}

/* ── templates and pages ──────────────────────────────────────────────── */

/** Page type from a storefront path — used when a page has no explicit `template`. */
export function templateTypeForPath(pathname) {
  const p = (pathname || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (p === '/') return 'index';
  if (/^\/products\//.test(p)) return 'product';
  if (/^\/collections\/[^/]+\/products\//.test(p)) return 'product';
  if (/^\/collections$/.test(p)) return 'list-collections';
  if (/^\/collections\//.test(p)) return 'collection';
  if (/^\/cart$/.test(p)) return 'cart';
  if (/^\/search$/.test(p)) return 'search';
  if (/^\/pages\//.test(p)) return 'page';
  if (/^\/blogs\/[^/]+\/[^/]+/.test(p)) return 'article';
  if (/^\/blogs\//.test(p)) return 'blog';
  return '404';
}

/** Template name the PREVIEW side of a page renders (`product.revamp`). */
export function previewTemplateOf(page) {
  if (page.template) return page.template;
  const type = templateTypeForPath(page.path);
  const view = page.previewView ?? page.view;
  return view ? `${type}.${view}` : type;
}

function templateFile(files, template) {
  for (const ext of ['.json', '.liquid']) if (files.has(`templates/${template}${ext}`)) return `templates/${template}${ext}`;
  return null;
}

function layoutFileFor(files, tmplFile) {
  const content = files.get(tmplFile) || '';
  let layout = 'theme';
  if (tmplFile.endsWith('.json')) {
    try {
      const data = JSON.parse(stripLeadingComment(content));
      if (data.layout === false) layout = null;
      else if (typeof data.layout === 'string') layout = data.layout;
    } catch {}
  } else {
    const m = content.match(/\{%-?\s*layout\s+(none|['"]([^'"]+)['"])/);
    if (m) layout = m[1] === 'none' ? null : m[2];
  }
  return layout && files.has(`layout/${layout}.liquid`) ? `layout/${layout}.liquid` : null;
}

function templateNameOf(file) {
  return file.replace(/^templates\//, '').replace(/\.(json|liquid)$/, '');
}

function isIgnored(template, patterns) {
  return patterns.some((p) => (p.endsWith('*') ? template.startsWith(p.slice(0, -1)) : template === p));
}

/**
 * @param files        Map path→content at the staging ref
 * @param changed      [{status, file}] from `git diff --name-status live...staging`
 * @param pages        config.pages (each { name, path, template?, view?, previewView?, always? })
 * @param ignoreTemplates templates never expected to have a page (customers/*, …)
 */
export function selectPages({ files, changed, pages, ignoreTemplates = DEFAULT_IGNORED_TEMPLATES }) {
  const graph = buildDependencyGraph(files);
  const changedTheme = changed.filter((c) => THEME_DIRS.some((d) => c.file.startsWith(`${d}/`)));
  const changedSet = new Set(changedTheme.map((c) => c.file));
  const globalChanges = changedTheme.filter((c) => GLOBAL_PREFIXES.some((p) => c.file.startsWith(p))).map((c) => c.file);

  // Closure of every template on staging — what each template renders.
  const templateClosures = new Map();
  for (const f of files.keys()) {
    if (!f.startsWith('templates/')) continue;
    const layout = layoutFileFor(files, f);
    templateClosures.set(templateNameOf(f), closureOf(graph, [f, layout].filter(Boolean)));
  }

  const hitsFor = (closure) => [...changedSet].filter((f) => closure.has(f));

  const selected = [];
  const skipped = [];
  for (const page of pages) {
    const template = previewTemplateOf(page);
    const tmplFile = templateFile(files, template);
    if (!tmplFile) {
      skipped.push({ page: page.name, reason: `template "${template}" not found on staging` });
      continue;
    }
    const closure = templateClosures.get(template) || new Set();
    const hits = hitsFor(closure);
    const reasons = [...hits.slice(0, 6).map((f) => `${f} changed`), ...globalChanges.slice(0, 3).map((f) => `${f} changed (global)`)];
    if (hits.length > hits.slice(0, 6).length) reasons.push(`…and ${hits.length - 6} more rendered file(s)`);
    if (reasons.length > 0 || page.always) {
      selected.push({ ...page, template, reasons: reasons.length ? reasons : ['always tested (smoke page)'] });
    } else {
      skipped.push({ page: page.name, reason: 'nothing it renders changed' });
    }
  }

  // Coverage gaps — templates this release affects that no selected page exercises.
  const selectedTemplates = new Set(selected.map((p) => p.template));
  const selectedTypes = new Set(selected.map((p) => p.template.split('.')[0]));
  const gaps = [];
  const directTemplates = changedTheme.filter((c) => c.status !== 'D' && c.file.startsWith('templates/')).map((c) => templateNameOf(c.file));
  for (const t of directTemplates) {
    if (isIgnored(t, ignoreTemplates) || selectedTemplates.has(t)) continue;
    gaps.push({ template: t, direct: true, reason: `templates/${t} itself changed but no configured page renders it` });
  }
  const gapTypes = new Set();
  for (const [t, closure] of templateClosures) {
    if (isIgnored(t, ignoreTemplates) || directTemplates.includes(t)) continue;
    if (hitsFor(closure).length === 0 && globalChanges.length === 0) continue;
    const type = t.split('.')[0];
    if (selectedTypes.has(type) || gapTypes.has(type)) continue;
    gapTypes.add(type);
    gaps.push({ template: type, direct: false, reason: `"${type}" templates render changed files but no configured page of that type exists` });
  }

  // Changed theme files no template reaches (dynamic renders, orphans, deletions).
  const reachable = new Set();
  for (const c of templateClosures.values()) for (const f of c) reachable.add(f);
  const unmapped = changedTheme.filter((c) => !reachable.has(c.file) && !GLOBAL_PREFIXES.some((p) => c.file.startsWith(p))).map((c) => `${c.file}${c.status === 'D' ? ' (deleted)' : ''}`);

  return { selected, skipped, gaps, unmapped, globalChanges };
}

/* ── URL building ─────────────────────────────────────────────────────── */

/** Live and preview URLs for a configured page. */
export function pageUrls(page, { store, previewThemeId, previewParams = {} }) {
  const base = `https://${String(store).replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const live = new URL(page.path || '/', base);
  const preview = new URL(page.path || '/', base);
  if (page.view) live.searchParams.set('view', page.view);
  const previewView = page.previewView ?? page.view;
  if (previewView) preview.searchParams.set('view', previewView);
  if (previewThemeId) preview.searchParams.set('preview_theme_id', String(previewThemeId));
  for (const [k, v] of Object.entries(previewParams)) preview.searchParams.set(k, String(v));
  return { liveUrl: live.toString(), previewUrl: preview.toString() };
}
