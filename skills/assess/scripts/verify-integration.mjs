#!/usr/bin/env node
/**
 * verify-integration.mjs
 *
 * The single owner of the pipeline's integration checks. Previously these greps
 * ran in four places: /execute, output-validator, code-reviewer and /assess.
 *
 * Usage:
 *   node verify-integration.mjs --feature <name> [--root .]
 *   node verify-integration.mjs --files "sections/a.liquid,assets/b.css" [--root .]
 *
 * With --feature it reads the file list out of
 * .buildspace/artifacts/<feature>/execution-log.md by pulling every backticked
 * theme path out of the document, which survives the several heading formats
 * real execution logs use.
 *
 * Emits JSON on stdout. Exits 1 when any check fails, so it works as a build
 * smoke test as well as a report.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const THEME_DIRS = ['sections', 'snippets', 'assets', 'templates', 'layout', 'blocks', 'config', 'locales'];
const PATH_RE = new RegExp(`\`((?:${THEME_DIRS.join('|')})/[A-Za-z0-9._/-]+\\.(?:liquid|css|js|json))\``, 'g');

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (f) => {
    const i = args.indexOf(f);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  return {
    feature: get('--feature'),
    files: get('--files'),
    root: get('--root') || '.',
  };
}

const exists = (p) => access(p).then(() => true, () => false);

/** Every .liquid file in the theme, so we can search for references. */
async function liquidFiles(root) {
  const out = [];
  for (const dir of ['sections', 'snippets', 'layout', 'blocks', 'templates']) {
    const abs = path.join(root, dir);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.liquid')) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

async function jsonTemplates(root) {
  const out = [];
  for (const dir of ['templates', 'sections']) {
    const abs = path.join(root, dir);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.json')) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

async function readAll(root, rels) {
  const map = new Map();
  await Promise.all(rels.map(async (rel) => {
    try {
      map.set(rel, await readFile(path.join(root, rel), 'utf8'));
    } catch {}
  }));
  return map;
}

/** Which of `haystack` mention `needle`? */
function mentionedIn(haystack, needle) {
  const hits = [];
  for (const [rel, content] of haystack) {
    if (content.includes(needle)) hits.push(rel);
  }
  return hits;
}

async function filesFromExecutionLog(root, feature) {
  const logPath = path.join(root, '.buildspace/artifacts', feature, 'execution-log.md');
  const md = await readFile(logPath, 'utf8');
  return [...new Set([...md.matchAll(PATH_RE)].map((m) => m[1]))];
}

async function main() {
  const { feature, files, root } = parseArgs();

  let targets;
  if (files) {
    targets = files.split(',').map((f) => f.trim()).filter(Boolean);
  } else if (feature) {
    targets = await filesFromExecutionLog(root, feature);
  } else {
    console.error('Usage: verify-integration.mjs --feature <name> | --files "a,b" [--root .]');
    process.exit(2);
  }

  const [liquid, templates] = await Promise.all([liquidFiles(root), jsonTemplates(root)]);
  const [liquidContent, templateContent] = await Promise.all([
    readAll(root, liquid),
    readAll(root, templates),
  ]);

  const checks = [];
  const add = (check, target, status, detail) => checks.push({ check, target, status, detail });

  for (const target of targets) {
    const base = path.basename(target);
    const stem = base.replace(/\.(liquid|css|js|json)$/, '');

    // A new section must be reachable from a template or section group.
    if (target.startsWith('sections/') && target.endsWith('.liquid')) {
      const hits = mentionedIn(templateContent, stem);
      add('section-registered', target,
        hits.length ? 'PASS' : 'FAIL',
        hits.length ? hits.join(', ') : 'not referenced by any template or section group JSON');
    }

    // A snippet nobody renders is dead code.
    if (target.startsWith('snippets/') && target.endsWith('.liquid')) {
      const hits = mentionedIn(liquidContent, stem).filter((f) => f !== target);
      add('snippet-rendered', target,
        hits.length ? 'PASS' : 'FAIL',
        hits.length ? hits.join(', ') : 'never rendered by any liquid file');
    }

    // A stylesheet or script nobody loads never runs.
    if (target.startsWith('assets/') && /\.(css|js)$/.test(target)) {
      const hits = mentionedIn(liquidContent, base);
      add('asset-loaded', target,
        hits.length ? 'PASS' : 'FAIL',
        hits.length ? hits.join(', ') : 'not referenced by any liquid file');
    }

    // Whatever we changed must actually be on disk.
    add('file-exists', target,
      (await exists(path.join(root, target))) ? 'PASS' : 'FAIL',
      null);
  }

  // Every asset_url the changed liquid files reference must resolve.
  const changedLiquid = targets.filter((t) => t.endsWith('.liquid'));
  for (const rel of changedLiquid) {
    const content = liquidContent.get(rel);
    if (!content) continue;
    const refs = new Set(
      [...content.matchAll(/['"]([A-Za-z0-9._-]+\.(?:css|js))['"]\s*\|\s*asset_url/g)].map((m) => m[1])
    );
    for (const ref of refs) {
      add('referenced-asset-exists', `${rel} -> assets/${ref}`,
        (await exists(path.join(root, 'assets', ref))) ? 'PASS' : 'FAIL',
        null);
    }
  }

  const summary = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
  };

  console.log(JSON.stringify({ feature: feature ?? null, root, filesChecked: targets, checks, summary }, null, 2));
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[verify-integration] Fatal: ${err.message}`);
  process.exit(2);
});
