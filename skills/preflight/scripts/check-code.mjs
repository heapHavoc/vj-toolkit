#!/usr/bin/env node
/**
 * check-code.mjs — /preflight checker 1: repo-only, no browser.
 *
 * Diffs the staging branch against the live branch and reports ONLY what
 * would change on merge — never pre-existing conditions on either branch.
 *
 * Usage:
 *   node check-code.mjs --live-branch main --staging-branch stage --root .
 *     [--config .buildspace/preflight/preflight.config.json]
 *
 * Prints one JSON object to stdout (see §8 of the preflight brief).
 * Exits 0 if no P0 check FAILs, 1 otherwise. Never throws to a bare stack
 * trace — an unexpected error becomes a SKIPPED check with a reason.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STANDARDS_RULES, PLACEHOLDER_PATTERNS, addedLinesWithNumbers, classifyPlaceholder, findCssCollisions, ruleHits } from './lib/code-rules.mjs';

/* ── CLI args ─────────────────────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback = null) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  return {
    liveBranch: get('--live-branch', 'main'),
    stagingBranch: get('--staging-branch', 'stage'),
    root: path.resolve(get('--root', '.')),
    configPath: get('--config', '.buildspace/preflight/preflight.config.json'),
    mode: get('--mode', 'pre-merge'), // pre-merge | post-merge | baseline
    baselineFile: get('--baseline-file'),
  };
}

/* ── git helpers ──────────────────────────────────────────────────────── */

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Like git(), but lets stderr through — use for calls whose failures should be visible (fetch, worktree add/remove). */
function gitVerbose(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 }).trim();
}

function gitSafe(root, args, fallback = '') {
  try {
    return git(root, args);
  } catch {
    return fallback;
  }
}

/** Resolve a branch name to the ref that actually exists (origin/<b> preferred, else local <b>). */
function resolveRef(root, branch) {
  for (const candidate of [`origin/${branch}`, branch]) {
    try {
      git(root, ['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {}
  }
  return null;
}

function fetchBranch(root, branch) {
  try {
    gitVerbose(root, ['fetch', 'origin', branch]);
    return true;
  } catch {
    return false;
  }
}

/** Read a file's content at a given ref. Returns null if the file doesn't exist at that ref. */
function showFile(root, ref, filePath) {
  try {
    return git(root, ['show', `${ref}:${filePath}`]);
  } catch {
    return null;
  }
}

function listFilesAtRef(root, ref, globDir = '') {
  const args = ['ls-tree', '-r', '--name-only', ref];
  if (globDir) args.push('--', globDir);
  const out = gitSafe(root, args);
  return out ? out.split('\n').filter(Boolean) : [];
}

function diffNameStatus(root, liveRef, stagingRef) {
  const out = gitSafe(root, ['diff', '--name-status', `${liveRef}...${stagingRef}`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status[0], file: rest[rest.length - 1], renamedFrom: rest.length > 1 ? rest[0] : null };
    });
}

/** Directories that make up the deployed theme. Docs, roadmap notes, scripts, etc. are excluded. */
const THEME_DIRS = ['sections/', 'snippets/', 'templates/', 'assets/', 'config/', 'locales/', 'layout/', 'blocks/'];
function isThemeFile(filePath) {
  return THEME_DIRS.some((d) => filePath.startsWith(d));
}
// tailwind.css is compiled output (src/input.css -> assets/tailwind.css); never hand-edited, never worth flagging.
const GENERATED_ASSETS = new Set(['assets/tailwind.css']);

/* ── result accumulator ───────────────────────────────────────────────── */

class Checks {
  constructor() {
    this.checks = [];
  }
  push(id, name, priority, status, summary, evidence = {}, risk = '') {
    this.checks.push({ id, name, priority, status, summary, evidence, risk });
  }
  pass(id, name, priority, summary, evidence = {}) {
    this.push(id, name, priority, 'PASS', summary, evidence, '');
  }
  fail(id, name, priority, summary, evidence, risk) {
    this.push(id, name, priority, 'FAIL', summary, evidence, risk);
  }
  info(id, name, summary, evidence = {}) {
    this.push(id, name, 'info', 'INFO', summary, evidence, '');
  }
  skip(id, name, priority, reason) {
    this.push(id, name, priority, 'SKIPPED', reason, {}, '');
  }
  summary() {
    const s = { pass: 0, fail: 0, skipped: 0, p0Fail: 0, p1Fail: 0 };
    for (const c of this.checks) {
      if (c.status === 'PASS') s.pass++;
      else if (c.status === 'SKIPPED') s.skipped++;
      else if (c.status === 'FAIL') {
        s.fail++;
        if (c.priority === 'P0') s.p0Fail++;
        if (c.priority === 'P1') s.p1Fail++;
      }
    }
    return s;
  }
}

/* ── config ───────────────────────────────────────────────────────────── */

async function loadConfig(root, configPath) {
  const full = path.isAbsolute(configPath) ? configPath : path.join(root, configPath);
  if (!existsSync(full)) return { ignore: { codeRules: [], consoleErrorPatterns: [] } };
  try {
    return JSON.parse(await readFile(full, 'utf-8'));
  } catch {
    return { ignore: { codeRules: [], consoleErrorPatterns: [] } };
  }
}

/* ── G1: merchant customizer edits about to be reverted ─────────────────── */

const CUSTOMIZER_PATH_PATTERNS = [
  /^config\/settings_data\.json$/,
  /^templates\/.*\.json$/,
  /^sections\/.*\.json$/,
  /^locales\//,
];

function checkG1(root, checks, liveRef, stagingRef) {
  const log = gitSafe(root, [
    'log',
    '--pretty=format:%H|%ad|%an|%s',
    '--date=short',
    '--name-only',
    `${stagingRef}..${liveRef}`,
  ]);
  if (!log) {
    checks.pass('G1', 'Merchant customizer edits about to be reverted', 'P0', 'No commits on live are missing from staging.');
    return;
  }

  const commits = [];
  let current = null;
  for (const line of log.split('\n')) {
    if (line.includes('|')) {
      if (current) commits.push(current);
      const [sha, date, author, ...rest] = line.split('|');
      current = { sha, date, author, subject: rest.join('|'), files: [] };
    } else if (line.trim() && current) {
      current.files.push(line.trim());
    }
  }
  if (current) commits.push(current);

  const offenders = commits
    .map((c) => ({ ...c, files: c.files.filter((f) => CUSTOMIZER_PATH_PATTERNS.some((re) => re.test(f))) }))
    .filter((c) => c.files.length > 0);

  if (offenders.length === 0) {
    checks.pass('G1', 'Merchant customizer edits about to be reverted', 'P0', 'No merchant-editable files are exclusive to live.');
    return;
  }

  checks.fail(
    'G1',
    'Merchant customizer edits about to be reverted',
    'P0',
    `${offenders.length} commit(s) on live touch merchant-editable files (settings, templates, sections, locales) and are absent from staging.`,
    { commits: offenders.map((c) => ({ sha: c.sha, date: c.date, author: c.author, subject: c.subject, files: c.files })) },
    'These commits are almost certainly Shopify customizer edits written back to the live branch by the GitHub integration. Merging staging into live will silently revert merchant content changes (homepage layout, banners, copy).'
  );
}

/* ── G2: app embeds lost ──────────────────────────────────────────────── */

/** Shopify auto-generates a leading /* ... *\/ comment block on config/settings_data.json and
 * every templates/*.json file on any GitHub-connected theme. Real JSON has no comment syntax,
 * so a bare JSON.parse throws on every one of these files — strip it first. Without this, the
 * parse failure was being silently swallowed by a catch and misread as "file is fine, contains
 * nothing" instead of "this file couldn't be read at all". */
function stripLeadingComment(content) {
  return content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
}

function parseSettingsBlocks(content) {
  if (!content) return null;
  let data;
  try {
    data = JSON.parse(stripLeadingComment(content));
  } catch {
    return null;
  }
  const current = data.current;
  if (typeof current === 'string') return { presetName: current, blocks: null };
  if (current && typeof current === 'object') return { presetName: null, blocks: current.blocks || {} };
  return null;
}

function checkG2(root, checks, liveRef, stagingRef) {
  const liveContent = showFile(root, liveRef, 'config/settings_data.json');
  const stagingContent = showFile(root, stagingRef, 'config/settings_data.json');

  if (!liveContent || !stagingContent) {
    checks.skip('G2', 'App embeds lost', 'P0', 'config/settings_data.json missing on one or both refs.');
    return;
  }

  const live = parseSettingsBlocks(liveContent);
  const staging = parseSettingsBlocks(stagingContent);

  if (!live || !staging) {
    checks.skip('G2', 'App embeds lost', 'P0', 'Could not parse config/settings_data.json on one or both refs.');
    return;
  }
  if (live.presetName || staging.presetName) {
    checks.skip(
      'G2',
      'App embeds lost',
      'P0',
      `"current" is a named preset ("${live.presetName || staging.presetName}") on at least one ref, not the live block map — cannot diff blocks. Verify manually.`
    );
    return;
  }

  const lost = [];
  for (const [blockId, block] of Object.entries(live.blocks || {})) {
    const enabledOnLive = block && block.disabled !== true;
    if (!enabledOnLive) continue;
    const stagingBlock = staging.blocks ? staging.blocks[blockId] : undefined;
    const missingOrDisabled = !stagingBlock || stagingBlock.disabled === true;
    if (missingOrDisabled) {
      lost.push({ blockId, type: block.type || 'unknown', status: !stagingBlock ? 'removed' : 'disabled' });
    }
  }

  if (lost.length === 0) {
    checks.pass('G2', 'App embeds lost', 'P0', 'Every enabled app embed block on live is present and enabled on staging.');
    return;
  }

  checks.fail(
    'G2',
    'App embeds lost',
    'P0',
    `${lost.length} app embed block(s) enabled on live are missing or disabled on staging.`,
    { blocks: lost },
    'The associated app(s) will stop rendering storefront-side after merge (e.g. reviews widget, chat, upsell, tracking pixel embed).'
  );
}

/* ── G3: robots.txt.liquid modified ──────────────────────────────────── */

function checkG3(root, checks, changedFiles) {
  const hit = changedFiles.find((f) => f.file === 'templates/robots.txt.liquid' || f.file.endsWith('/robots.txt.liquid'));
  if (!hit) {
    checks.pass('G3', 'robots.txt.liquid modified', 'P0', 'robots.txt.liquid is unchanged.');
    return;
  }
  checks.fail(
    'G3',
    'robots.txt.liquid modified',
    'P0',
    `robots.txt.liquid is changed on staging (${hit.status === 'D' ? 'deleted' : hit.status === 'A' ? 'added' : 'modified'}).`,
    { file: hit.file, status: hit.status },
    'A wrong robots.txt on merge can de-index the entire store. Always hand-verify this diff before releasing, regardless of intent.'
  );
}

/* ── G4: deleted files still referenced ─────────────────────────────────── */

function fileStem(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function checkG4(root, checks, liveRef, stagingRef, changedFiles) {
  const deleted = changedFiles.filter((c) => c.status === 'D');
  if (deleted.length === 0) {
    checks.pass('G4', 'Deleted files still referenced', 'P0', 'No files are deleted on staging.');
    return;
  }

  const templateFiles = listFilesAtRef(root, liveRef, 'templates').filter((f) => f.endsWith('.json'));
  const sectionGroupFiles = ['sections/header-group.json', 'sections/footer-group.json'].filter(
    (f) => showFile(root, liveRef, f) !== null
  );
  const haystackFiles = [...templateFiles, ...sectionGroupFiles];
  const haystack = haystackFiles.map((f) => ({ file: f, content: showFile(root, liveRef, f) || '' }));

  const dangling = [];
  for (const del of deleted) {
    const stem = fileStem(del.file);
    if (!stem) continue;
    const refs = haystack.filter((h) => h.content.includes(`"${stem}"`) || h.content.includes(`/${stem}"`));
    if (refs.length > 0) {
      dangling.push({ deletedFile: del.file, stem, referencedIn: refs.map((r) => r.file) });
    }
  }

  if (dangling.length === 0) {
    checks.pass('G4', 'Deleted files still referenced', 'P0', `${deleted.length} file(s) deleted on staging; none are referenced by live's templates or section groups.`);
    return;
  }

  checks.fail(
    'G4',
    'Deleted files still referenced',
    'P0',
    `${dangling.length} deleted file(s) are still referenced by live's JSON templates or section groups.`,
    { dangling },
    'These references will resolve to nothing after merge — the section/snippet renders empty or Liquid errors on affected pages.'
  );
}

/* ── G5: blast radius (info only) ───────────────────────────────────────── */

function checkG5(checks, changedFiles) {
  const buckets = { sections: [], snippets: [], templates: [], assets: [], locales: [], config: [], other: [] };
  for (const c of changedFiles) {
    if (c.file.startsWith('sections/')) buckets.sections.push(c.file);
    else if (c.file.startsWith('snippets/')) buckets.snippets.push(c.file);
    else if (c.file.startsWith('templates/')) buckets.templates.push(c.file);
    else if (c.file.startsWith('assets/')) buckets.assets.push(c.file);
    else if (c.file.startsWith('locales/')) buckets.locales.push(c.file);
    else if (c.file.startsWith('config/')) buckets.config.push(c.file);
    else buckets.other.push(c.file);
  }
  checks.info('G5', 'Blast radius', `${changedFiles.length} file(s) changed on staging vs live.`, buckets);
}

/* ── S1: theme check delta (temp worktrees) ─────────────────────────────── */

function hasThemeCheckCli() {
  try {
    execFileSync('shopify', ['theme', 'check', '--version'], { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

function withWorktree(root, ref, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'preflight-wt-'));
  try {
    gitVerbose(root, ['worktree', 'add', '--detach', dir, ref]);
    return fn(dir);
  } finally {
    try {
      gitVerbose(root, ['worktree', 'remove', '--force', dir]);
    } catch {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

function runThemeCheckJson(dir) {
  try {
    const out = execFileSync('shopify', ['theme', 'check', '--path', dir, '--output', 'json'], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 64,
    });
    return JSON.parse(out);
  } catch (err) {
    // theme check exits non-zero when it finds offenses; stdout still has JSON.
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {}
    }
    return null;
  }
}

function violationKey(offense) {
  return `${offense.check}|${offense.path}|${offense.line ?? offense.start_row ?? ''}|${offense.message}`;
}

function checkS1(root, checks, liveRef, stagingRef) {
  if (!hasThemeCheckCli()) {
    checks.skip('S1', 'Theme check delta', 'P0', 'Shopify CLI `theme check` is not available on PATH.');
    return;
  }

  let liveResult, stagingResult;
  try {
    liveResult = withWorktree(root, liveRef, runThemeCheckJson);
    stagingResult = withWorktree(root, stagingRef, runThemeCheckJson);
  } catch (err) {
    checks.skip('S1', 'Theme check delta', 'P0', `Failed to run theme check in a temp worktree: ${err.message}`);
    return;
  }

  const liveOffenses = liveResult?.offenses || [];
  const stagingOffenses = stagingResult?.offenses || [];
  const liveKeys = new Set(liveOffenses.map(violationKey));
  const newOffenses = stagingOffenses.filter((o) => !liveKeys.has(violationKey(o)));

  if (newOffenses.length === 0) {
    checks.pass('S1', 'Theme check delta', 'P0', 'No new theme-check violations on staging.');
    return;
  }

  const newErrors = newOffenses.filter((o) => o.severity === 0 || o.severity === 'error');
  const newWarnings = newOffenses.filter((o) => o !== newErrors && (o.severity === 1 || o.severity === 'warning'));
  const priority = newErrors.length > 0 ? 'P0' : 'P1';

  checks.fail(
    'S1',
    'Theme check delta',
    priority,
    `${newOffenses.length} new theme-check violation(s) on staging (${newErrors.length} error, ${newOffenses.length - newErrors.length} warning).`,
    { offenses: newOffenses.map((o) => ({ check: o.check, path: o.path, line: o.line ?? o.start_row, message: o.message, severity: o.severity })) },
    'New errors can break Liquid rendering; new warnings indicate standards drift introduced by this release.'
  );
}

/* ── S2: integration (release-scoped) ──────────────────────────────────── */
/*
 * verify-integration.mjs does not exist yet in this toolkit (assess/SKILL.md
 * does this inline, per-feature, via Grep/Glob). Until it is extracted as a
 * shared script, S2 reimplements the same class of check at release scope:
 * every {% render 'x' %} / {% section 'x' %} / asset_url('x') reference in
 * the staging worktree must resolve to a real file, and every changed
 * section/template must be reachable from at least one template or group.
 */

const RENDER_RE = /\{%-?\s*render\s+'([^']+)'/g;
const SECTION_TAG_RE = /\{%-?\s*section\s+'([^']+)'/g;
const ASSET_URL_RE = /'([\w.\-\/]+)'\s*\|\s*asset_url/g;

function collectMatches(content, re) {
  const out = new Set();
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(content))) out.add(m[1]);
  return out;
}

function checkS2(root, checks, liveRef, stagingRef, changedFiles) {
  let broken;
  try {
    broken = withWorktree(root, stagingRef, (dir) => {
      const allFiles = listFilesAtRef(root, stagingRef).filter((f) => f.startsWith('sections/') || f.startsWith('snippets/') || f.startsWith('templates/'));
      const findings = [];
      for (const f of allFiles) {
        const content = readFileSync(path.join(dir, f), 'utf-8');
        for (const name of collectMatches(content, RENDER_RE)) {
          if (!existsSync(path.join(dir, 'snippets', `${name}.liquid`))) {
            findings.push({ file: f, kind: 'render', target: name });
          }
        }
        for (const name of collectMatches(content, SECTION_TAG_RE)) {
          if (!existsSync(path.join(dir, 'sections', `${name}.liquid`))) {
            findings.push({ file: f, kind: 'section', target: name });
          }
        }
        for (const name of collectMatches(content, ASSET_URL_RE)) {
          if (!existsSync(path.join(dir, 'assets', name))) {
            findings.push({ file: f, kind: 'asset_url', target: name });
          }
        }
      }
      return findings;
    });
  } catch (err) {
    checks.skip('S2', 'Integration', 'P0', `Could not materialise staging worktree: ${err.message}`);
    return;
  }

  // Suppress anything that was already broken on live (delta philosophy).
  let liveBroken;
  try {
    liveBroken = withWorktree(root, liveRef, (dir) => {
      const set = new Set();
      const allFiles = listFilesAtRef(root, liveRef).filter((f) => f.startsWith('sections/') || f.startsWith('snippets/') || f.startsWith('templates/'));
      for (const f of allFiles) {
        const content = readFileSync(path.join(dir, f), 'utf-8');
        for (const name of collectMatches(content, RENDER_RE)) {
          if (!existsSync(path.join(dir, 'snippets', `${name}.liquid`))) set.add(`${f}|render|${name}`);
        }
        for (const name of collectMatches(content, SECTION_TAG_RE)) {
          if (!existsSync(path.join(dir, 'sections', `${name}.liquid`))) set.add(`${f}|section|${name}`);
        }
        for (const name of collectMatches(content, ASSET_URL_RE)) {
          if (!existsSync(path.join(dir, 'assets', name))) set.add(`${f}|asset_url|${name}`);
        }
      }
      return set;
    });
  } catch {
    liveBroken = new Set();
  }

  const newBroken = broken.filter((b) => !liveBroken.has(`${b.file}|${b.kind}|${b.target}`));

  if (newBroken.length === 0) {
    checks.pass('S2', 'Integration', 'P0', 'Every render/section/asset_url reference in staging resolves.');
    return;
  }

  checks.fail(
    'S2',
    'Integration',
    'P0',
    `${newBroken.length} new unresolved reference(s) introduced on staging.`,
    { findings: newBroken },
    'A missing render/section/asset target fails silently or throws a Liquid error at request time on the affected page.'
  );
}

/* ── S3: schema ↔ settings drift ────────────────────────────────────────── */

function extractSchemaBlock(content) {
  if (!content) return null;
  const m = content.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function collectSectionTypesAndSettings(content) {
  const types = new Set();
  const settingRefs = new Set();
  if (!content) return { types, settingRefs };
  let data;
  try {
    data = JSON.parse(stripLeadingComment(content));
  } catch {
    return { types, settingRefs };
  }
  const sections = data.sections || {};
  for (const [id, sec] of Object.entries(sections)) {
    if (sec.type) types.add(sec.type);
    for (const key of Object.keys(sec.settings || {})) settingRefs.add(`${sec.type}:${key}`);
    for (const block of Object.values(sec.blocks || {})) {
      for (const key of Object.keys(block.settings || {})) settingRefs.add(`${sec.type}:${block.type}:${key}`);
    }
  }
  return { types, settingRefs };
}

/** Resolve every referenced section type/setting against one ref's own section schemas.
 * Ref-agnostic on purpose — called once against staging, once against live, so the same
 * pre-existing-vs-new split used by S4/S5 works here too. Issue text never names a ref;
 * the caller decides what "pre-existing" vs "new" means for the pair of results. */
function resolveSectionDrift(root, ref, referencedTypes, referencedSettings) {
  const unresolved = [];
  for (const type of referencedTypes) {
    const sectionContent = showFile(root, ref, `sections/${type}.liquid`);
    if (!sectionContent) {
      unresolved.push({ type, issue: 'section file missing' });
      continue;
    }
    const schema = extractSchemaBlock(sectionContent);
    if (!schema) {
      unresolved.push({ type, issue: 'schema block missing or invalid JSON' });
      continue;
    }
    const settingIds = new Set((schema.settings || []).map((s) => s.id).filter(Boolean));
    const blockSettingIds = {};
    for (const block of schema.blocks || []) {
      blockSettingIds[block.type] = new Set((block.settings || []).map((s) => s.id).filter(Boolean));
    }
    for (const ref2 of referencedSettings) {
      const parts = ref2.split(':');
      if (parts[0] !== type) continue;
      if (parts.length === 2) {
        if (!settingIds.has(parts[1])) unresolved.push({ type, issue: `setting "${parts[1]}" referenced but not in schema.settings` });
      } else if (parts.length === 3) {
        const blockIds = blockSettingIds[parts[1]];
        if (!blockIds) unresolved.push({ type, issue: `block type "${parts[1]}" referenced but not in schema.blocks` });
        else if (!blockIds.has(parts[2])) unresolved.push({ type, issue: `block "${parts[1]}" setting "${parts[2]}" referenced but not in its schema` });
      }
    }
  }
  return unresolved;
}

function driftKey(f) {
  return `${f.type}:${f.issue}`;
}

function checkS3(root, checks, liveRef, stagingRef) {
  const templateFiles = listFilesAtRef(root, liveRef, 'templates').filter((f) => f.endsWith('.json'));
  const groupFiles = ['sections/header-group.json', 'sections/footer-group.json'];

  const referencedTypes = new Set();
  const referencedSettings = new Set();
  for (const f of [...templateFiles, ...groupFiles]) {
    const content = showFile(root, liveRef, f);
    const { types, settingRefs } = collectSectionTypesAndSettings(content);
    types.forEach((t) => referencedTypes.add(t));
    settingRefs.forEach((s) => referencedSettings.add(s));
  }

  // Resolve the same referenced types/settings against staging's schemas AND live's own —
  // a type untouched by this release resolves identically either way, so anything that fails
  // both is pre-existing drift this release didn't cause (e.g. a schema with a trailing comma
  // that's been there for months). Only what staging breaks that live's own schema didn't is new.
  const stagingUnresolved = resolveSectionDrift(root, stagingRef, referencedTypes, referencedSettings);
  const liveUnresolved = resolveSectionDrift(root, liveRef, referencedTypes, referencedSettings);
  const liveKeys = new Set(liveUnresolved.map(driftKey));
  const newFindings = stagingUnresolved.filter((f) => !liveKeys.has(driftKey(f)));
  const preExisting = stagingUnresolved.filter((f) => liveKeys.has(driftKey(f)));

  if (preExisting.length > 0) {
    checks.info(
      'S3-PREEXISTING',
      'Schema ↔ settings drift (pre-existing)',
      `${preExisting.length} unresolved reference(s) already broken against live's own schemas — reported for visibility, not gating this release.`,
      { findings: preExisting }
    );
  }

  if (newFindings.length === 0) {
    checks.pass('S3', 'Schema ↔ settings drift', 'P0', `${referencedTypes.size} section type(s) referenced by live's templates: no new unresolved schema/setting references introduced by this diff.`);
    return;
  }

  checks.fail(
    'S3',
    'Schema ↔ settings drift',
    'P0',
    `${newFindings.length} new unresolved schema/setting reference(s) introduced by this diff.`,
    { findings: newFindings },
    'An unresolvable reference means a section renders empty, drops a setting silently, or errors after merge.'
  );
}

/* ── S4: cross-feature collisions (release-scoped: report all, gate on new only) ── */

/** Raw schema-ID / JS-global collision scan against one ref's materialised worktree. No pass/fail decision here. */
function scanCollisions(root, ref, dir) {
  const findings = [];

  // Duplicate schema setting IDs within a single section's own schema.
  const sectionFiles = listFilesAtRef(root, ref, 'sections').filter((f) => f.endsWith('.liquid'));
  for (const f of sectionFiles) {
    const content = readFileSync(path.join(dir, f), 'utf-8');
    const schema = extractSchemaBlock(content);
    if (!schema) continue;
    const ids = (schema.settings || []).map((s) => s.id).filter(Boolean);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) findings.push({ kind: 'duplicate-schema-setting-id', file: f, ids: [...new Set(dupes)].sort() });
  }

  // CSS collisions are selector-aware and diff-scoped — see findCssCollisions (checkS4).

  // JS globals assigned in two different asset files.
  const jsFiles = listFilesAtRef(root, ref, 'assets').filter((f) => f.endsWith('.js'));
  const globalOwners = new Map();
  for (const f of jsFiles) {
    const content = readFileSync(path.join(dir, f), 'utf-8');
    const globalRe = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
    let m;
    while ((m = globalRe.exec(content))) {
      const name = m[1];
      if (!globalOwners.has(name)) globalOwners.set(name, new Set());
      globalOwners.get(name).add(f);
    }
  }
  for (const [name, files] of globalOwners) {
    if (files.size > 1) findings.push({ kind: 'js-global-collision', global: name, files: [...files].sort() });
  }

  return findings;
}

/** Identity of a collision finding for live-vs-staging comparison — same kind + subject + exact file set means "the same collision". A changed file set for an already-colliding class/global is treated as new (the overwrite relationship itself changed). */
function collisionKey(f) {
  if (f.kind === 'duplicate-schema-setting-id') return `dup:${f.file}:${f.ids.join(',')}`;
  if (f.kind === 'js-global-collision') return `js:${f.global}:${f.files.join(',')}`;
  return JSON.stringify(f);
}

function checkS4(root, checks, liveRef, stagingRef, changedFiles) {
  let liveFindings;
  try {
    liveFindings = withWorktree(root, liveRef, (dir) => scanCollisions(root, liveRef, dir));
  } catch (err) {
    checks.skip('S4', 'Cross-feature collisions', 'P1', `Could not materialise live worktree: ${err.message}`);
    return;
  }
  let stagingFindings;
  let cssFindings;
  const changedCss = changedFiles.filter((c) => c.status !== 'D' && c.file.startsWith('assets/') && c.file.endsWith('.css') && !GENERATED_ASSETS.has(c.file) && !c.file.endsWith('.min.css')).map((c) => c.file);
  try {
    [stagingFindings, cssFindings] = withWorktree(root, stagingRef, (dir) => {
      const stagingCss = new Map(listFilesAtRef(root, stagingRef, 'assets').filter((f) => f.endsWith('.css') && !GENERATED_ASSETS.has(f)).map((f) => [f, readFileSync(path.join(dir, f), 'utf-8')]));
      const liveCss = new Map(changedCss.map((f) => [f, showFile(root, liveRef, f)]).filter(([, c]) => c != null));
      return [scanCollisions(root, stagingRef, dir), findCssCollisions(stagingCss, liveCss, changedCss)];
    });
  } catch (err) {
    checks.skip('S4', 'Cross-feature collisions', 'P1', `Could not materialise staging worktree: ${err.message}`);
    return;
  }

  const liveKeys = new Set(liveFindings.map(collisionKey));
  // Schema-ID / JS-global collisions keyed live-vs-staging; CSS findings are already diff-scoped
  // (only rules this diff added or changed are ever compared).
  const newFindings = [...stagingFindings.filter((f) => !liveKeys.has(collisionKey(f))), ...cssFindings];
  const preExisting = stagingFindings.filter((f) => liveKeys.has(collisionKey(f)));

  if (preExisting.length > 0) {
    checks.info(
      'S4-PREEXISTING',
      'Cross-feature collisions (pre-existing)',
      `${preExisting.length} collision(s) already present on live — reported for visibility, not gating this release.`,
      { findings: preExisting }
    );
  }

  if (newFindings.length === 0) {
    checks.pass('S4', 'Cross-feature collisions', 'P1', 'No new duplicate schema setting IDs, CSS selector collisions, or JS global collisions introduced by this diff.');
  } else {
    const byKind = newFindings.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {});
    checks.fail(
      'S4',
      'Cross-feature collisions',
      worstPriority(newFindings.map((f) => f.priority || 'P1')),
      `${newFindings.length} new collision(s) introduced by this diff (${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ')}).`,
      { findings: newFindings },
      'Two features silently overwrite each other at runtime — last-loaded file wins, causing intermittent or environment-dependent bugs.'
    );
  }
}

const PRIORITY_ORDER = ['info', 'P2', 'P1', 'P0'];
function worstPriority(priorities) {
  return priorities.reduce((worst, p) => (PRIORITY_ORDER.indexOf(p) > PRIORITY_ORDER.indexOf(worst) ? p : worst), 'P2');
}

/* ── S5: secrets ─────────────────────────────────────────────────────────── */

const SECRET_PATTERNS = [
  { name: 'Generic API key assignment', re: /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Shopify private/custom app token', re: /shpat_[a-f0-9]{32}/g },
  { name: 'Stripe secret key', re: /sk_live_[A-Za-z0-9]{16,}/g },
  { name: 'Generic bearer token', re: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g },
];
// Shopify's public storefront/app-proxy tokens are intentionally client-side and excluded.
const KNOWN_PUBLIC_TOKEN_RE = /shpca_|shpss_/;

/** Raw secret scan against one ref's materialised worktree. Keeps the matched text only for
 * live-vs-staging keying below — never persisted into a check's evidence (see checkS5). */
function scanSecrets(root, ref, dir) {
  const targets = [
    ...listFilesAtRef(root, ref, 'assets').filter((f) => f.endsWith('.js')),
    ...listFilesAtRef(root, ref, 'snippets').filter((f) => f.endsWith('.liquid')),
  ];
  const findings = [];
  for (const f of targets) {
    const content = readFileSync(path.join(dir, f), 'utf-8');
    for (const { name, re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content))) {
        if (KNOWN_PUBLIC_TOKEN_RE.test(m[0])) continue;
        const line = content.slice(0, m.index).split('\n').length;
        findings.push({ file: f, line, pattern: name, match: m[0] });
      }
    }
  }
  return findings;
}

/** Same exact secret text in the same file on both refs means "the same exposure", not new. */
function secretKey(f) {
  return `${f.file}:${f.match}`;
}

function checkS5(root, checks, liveRef, stagingRef) {
  let liveFindings;
  try {
    liveFindings = withWorktree(root, liveRef, (dir) => scanSecrets(root, liveRef, dir));
  } catch (err) {
    checks.skip('S5', 'Secrets', 'P0', `Could not materialise live worktree: ${err.message}`);
    return;
  }
  let stagingFindings;
  try {
    stagingFindings = withWorktree(root, stagingRef, (dir) => scanSecrets(root, stagingRef, dir));
  } catch (err) {
    checks.skip('S5', 'Secrets', 'P0', `Could not materialise staging worktree: ${err.message}`);
    return;
  }

  const liveKeys = new Set(liveFindings.map(secretKey));
  // Strip the raw matched secret text before it ever lands in a check's persisted evidence —
  // file/line/pattern is enough to locate and fix it without duplicating the credential itself.
  const strip = (f) => ({ file: f.file, line: f.line, pattern: f.pattern });
  const newFindings = stagingFindings.filter((f) => !liveKeys.has(secretKey(f))).map(strip);
  const preExisting = stagingFindings.filter((f) => liveKeys.has(secretKey(f))).map(strip);

  if (preExisting.length > 0) {
    checks.info(
      'S5-PREEXISTING',
      'Secrets (pre-existing)',
      `${preExisting.length} secret-shaped string(s) already present on live — reported for visibility, not gating this release, but still worth rotating separately.`,
      { findings: preExisting }
    );
  }

  if (newFindings.length === 0) {
    checks.pass('S5', 'Secrets', 'P0', 'No new secret-shaped strings introduced by this diff.');
  } else {
    checks.fail('S5', 'Secrets', 'P0', `${newFindings.length} new possible secret(s) introduced by this diff.`, { findings: newFindings }, 'A newly committed credential in theme assets is publicly served to every storefront visitor.');
  }
}

/* ── S6: placeholder content (diff only, classified by where it lives) ──── */

function checkS6(root, checks, liveRef, stagingRef, changedFiles) {
  const findings = [];
  for (const c of changedFiles) {
    if (c.status === 'D' || !isThemeFile(c.file)) continue;
    const patch = gitSafe(root, ['diff', '-U0', `${liveRef}...${stagingRef}`, '--', c.file]);
    const added = addedLinesWithNumbers(patch);
    if (added.length === 0) continue;
    let stagingContent = null;
    for (const { line, text } of added) {
      for (const re of PLACEHOLDER_PATTERNS) {
        if (!re.test(text)) continue;
        if (stagingContent === null) stagingContent = showFile(root, stagingRef, c.file) || '';
        const { location, priority } = classifyPlaceholder(c.file, line, text, stagingContent);
        findings.push({ file: c.file, line, pattern: re.source, location, priority, text: text.trim().slice(0, 160) });
      }
    }
  }
  if (findings.length === 0) {
    checks.pass('S6', 'Placeholder content', 'P1', 'No placeholder markers introduced by this diff.');
    return;
  }
  const visible = findings.filter((f) => f.priority !== 'P2');
  checks.fail(
    'S6',
    'Placeholder content',
    worstPriority(findings.map((f) => f.priority)),
    `${findings.length} placeholder marker(s) introduced by this diff — ${visible.length} in shopper-visible content, ${findings.length - visible.length} in schema defaults/comments/editor strings.`,
    { findings },
    'Placeholder copy or dead links reach production. Saved template/section-group content and storefront locales render as-is; schema defaults only appear when a merchant adds the section fresh.'
  );
}

/* ── S7: standards delta (liquid/js/css/section/theme-architecture) ────── */

function checkS7(root, checks, liveRef, stagingRef, changedFiles, config) {
  const ignoredRules = new Set(config?.ignore?.codeRules || []);
  const findings = [];
  for (const c of changedFiles) {
    if (c.status === 'D' || !isThemeFile(c.file) || GENERATED_ASSETS.has(c.file)) continue;
    const rules = STANDARDS_RULES.filter((r) => !ignoredRules.has(r.id) && c.file.endsWith(r.ext) && (!r.dir || c.file.startsWith(`${r.dir}/`)));
    if (rules.length === 0) continue;

    const liveContent = showFile(root, liveRef, c.file) || '';
    const stagingContent = showFile(root, stagingRef, c.file) || '';

    for (const rule of rules) {
      // Guards apply to both sides, so the delta compares like with like.
      const liveCount = ruleHits(rule, liveContent).length;
      const stagingHits = ruleHits(rule, stagingContent);
      // Delta by count: only flag if staging has more occurrences than live for this rule in this file.
      if (stagingHits.length > liveCount) {
        const newCount = stagingHits.length - liveCount;
        const sample = stagingHits.slice(-newCount).slice(0, 25).map(({ line, snippet }) => ({ line, snippet }));
        findings.push({ ruleId: rule.id, file: c.file, priority: rule.priority, message: rule.message, newCount, sample });
      }
    }
  }

  if (findings.length === 0) {
    checks.pass('S7', 'Standards delta', 'P1', `No new standards violations (liquid/js/css) introduced by this diff.${ignoredRules.size ? ` (${ignoredRules.size} rule(s) ignored via config.ignore.codeRules.)` : ''}`);
    return;
  }

  // Priority is the worst finding's own priority — P2-only findings (comments) are notes, not a gate.
  checks.fail(
    'S7',
    'Standards delta',
    worstPriority(findings.map((f) => f.priority)),
    `${findings.length} new standards violation(s) introduced by this diff, across ${new Set(findings.map((f) => f.file)).size} file(s).`,
    { findings },
    'These are new deviations from liquid-standards/js-standards/css-standards/section-standards/theme-architecture — code-reviewer would flag these on the individual feature, but nothing else catches them release-wide.'
  );
}

/* ── baseline / post-merge (time axis, §10 of the brief) ──────────────────
 * Everything above compares two branches (the merge axis). Baseline mode
 * instead snapshots live's *current* state so a later post-merge run can
 * catch store-level drift that never touched theme code at all — a pixel
 * edited in admin, an app embed toggled off, a Customer Events change.
 * Both bypass the branch axis entirely, per the brief. */

function snapshotAppEmbeds(root, ref) {
  const content = showFile(root, ref, 'config/settings_data.json');
  const parsed = parseSettingsBlocks(content);
  if (!parsed || parsed.presetName) return null;
  return Object.entries(parsed.blocks || {})
    .filter(([, block]) => block && block.disabled !== true)
    .map(([blockId, block]) => ({ blockId, type: block.type || 'unknown' }));
}

function buildBaselineSnapshot(root, liveRef, liveSha) {
  const appEmbeds = snapshotAppEmbeds(root, liveRef);
  let themeCheckOffenseCount = null;
  if (hasThemeCheckCli()) {
    try {
      const result = withWorktree(root, liveRef, runThemeCheckJson);
      themeCheckOffenseCount = (result?.offenses || []).length;
    } catch {
      themeCheckOffenseCount = null;
    }
  }
  return { liveRef, liveSha, generatedAt: new Date().toISOString(), appEmbeds, themeCheckOffenseCount };
}

function checkPostMergeEmbedDrift(checks, baseline, root, liveRef) {
  if (!baseline || !baseline.appEmbeds) {
    checks.skip('G2-DRIFT', 'App embeds lost since baseline', 'P0', 'Baseline has no app-embed snapshot to compare against (was `current` a named preset when the baseline was written?).');
    return;
  }
  const current = snapshotAppEmbeds(root, liveRef);
  if (!current) {
    checks.skip('G2-DRIFT', 'App embeds lost since baseline', 'P0', 'Could not read config/settings_data.json blocks on live right now.');
    return;
  }
  const currentIds = new Set(current.map((b) => b.blockId));
  const lost = baseline.appEmbeds.filter((b) => !currentIds.has(b.blockId));
  if (lost.length === 0) {
    checks.pass('G2-DRIFT', 'App embeds lost since baseline', 'P0', 'Every app embed enabled at the last baseline is still enabled on live.');
    return;
  }
  checks.fail(
    'G2-DRIFT',
    'App embeds lost since baseline',
    'P0',
    `${lost.length} app embed block(s) enabled at the last baseline (${baseline.generatedAt}) are now missing or disabled — with no corresponding code change (this is the time axis, not the branch axis).`,
    { blocks: lost, baselineGeneratedAt: baseline.generatedAt },
    'Store-level drift: someone toggled an app embed off in the theme customizer, or an app uninstalled itself, since the last green release. Theme code is not the cause here.'
  );
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs();
  const checks = new Checks();
  const startedAt = new Date().toISOString();

  if (!existsSync(args.root) || !existsSync(path.join(args.root, '.git'))) {
    console.log(JSON.stringify({ checker: 'code', startedAt, context: {}, checks: [], summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 }, error: `Not a git repository: ${args.root}` }));
    process.exitCode = 1; return;
  }

  fetchBranch(args.root, args.liveBranch);
  const liveRefOnly = resolveRef(args.root, args.liveBranch);

  if (args.mode === 'baseline') {
    if (!liveRefOnly) {
      console.log(JSON.stringify({ checker: 'code', mode: 'baseline', startedAt, context: { liveBranch: args.liveBranch }, checks: [], summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 }, error: `Could not resolve ${args.liveBranch} to a ref.` }));
      process.exitCode = 0; return;
    }
    const liveSha = git(args.root, ['rev-parse', liveRefOnly]);
    const snapshot = buildBaselineSnapshot(args.root, liveRefOnly, liveSha);
    console.log(JSON.stringify({ checker: 'code', mode: 'baseline', startedAt, context: { liveBranch: args.liveBranch, liveRef: liveRefOnly, liveSha }, checks: [], summary: { pass: 0, fail: 0, skipped: 0, p0Fail: 0, p1Fail: 0 }, snapshot }, null, 2));
    process.exitCode = 0; return;
  }

  if (args.mode === 'post-merge') {
    if (!liveRefOnly) {
      console.log(JSON.stringify({ checker: 'code', mode: 'post-merge', startedAt, context: { liveBranch: args.liveBranch }, checks: [], summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 }, error: `Could not resolve ${args.liveBranch} to a ref.` }));
      process.exitCode = 0; return;
    }
    let baseline = null;
    if (args.baselineFile && existsSync(args.baselineFile)) {
      try {
        const full = JSON.parse(readFileSync(args.baselineFile, 'utf-8'));
        baseline = full.code?.snapshot || null;
      } catch {}
    }
    checkPostMergeEmbedDrift(checks, baseline, args.root, liveRefOnly);
    const output = { checker: 'code', mode: 'post-merge', startedAt, context: { liveBranch: args.liveBranch, liveRef: liveRefOnly }, checks: checks.checks, summary: checks.summary() };
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = output.summary.p0Fail > 0 ? 1 : 0; return;
  }

  // ── pre-merge (default): the branch axis, staging vs live ──────────────
  fetchBranch(args.root, args.stagingBranch);

  const liveRef = liveRefOnly;
  const stagingRef = resolveRef(args.root, args.stagingBranch);

  if (!liveRef || !stagingRef) {
    console.log(
      JSON.stringify({
        checker: 'code',
        startedAt,
        context: { liveBranch: args.liveBranch, stagingBranch: args.stagingBranch },
        checks: [],
        summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 },
        error: `Could not resolve ${!liveRef ? args.liveBranch : args.stagingBranch} to a ref (local or origin/).`,
      })
    );
    process.exitCode = 1; return;
  }

  const liveSha = git(args.root, ['rev-parse', liveRef]);
  const stagingSha = git(args.root, ['rev-parse', stagingRef]);
  const changedFiles = diffNameStatus(args.root, liveRef, stagingRef);
  const context = { liveBranch: args.liveBranch, stagingBranch: args.stagingBranch, liveRef, stagingRef, liveSha, stagingSha };

  // G0 — nothing to compare. Every diff-scoped check below would "pass" vacuously on an empty
  // diff (a real run did exactly this: staging had already been merged into live, 0 files
  // changed, 11/11 PASS, GREEN). An empty comparison is untested, never green.
  const changedThemeFiles = changedFiles.filter((c) => isThemeFile(c.file));
  if (changedThemeFiles.length === 0) {
    checks.skip(
      'G0',
      'Release has changes to check',
      'P0',
      changedFiles.length === 0
        ? `${stagingRef} (${stagingSha.slice(0, 7)}) has no changes relative to ${liveRef} (${liveSha.slice(0, 7)}) — nothing to compare. Is the staging branch already merged, or is --staging-branch wrong?`
        : `${changedFiles.length} file(s) differ, but none are theme files (${THEME_DIRS.join(', ')}) — nothing theme-related to check.`
    );
    const output = { checker: 'code', mode: 'pre-merge', startedAt, context: { ...context, changedFileCount: changedFiles.length }, checks: checks.checks, summary: checks.summary() };
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = 0; return;
  }
  checks.pass('G0', 'Release has changes to check', 'P0', `${changedThemeFiles.length} theme file(s) changed between ${liveRef} (${liveSha.slice(0, 7)}) and ${stagingRef} (${stagingSha.slice(0, 7)}).`);

  const config = await loadConfig(args.root, args.configPath);

  // Git checks — cheap, run first.
  checkG1(args.root, checks, liveRef, stagingRef);
  checkG2(args.root, checks, liveRef, stagingRef);
  checkG3(args.root, checks, changedFiles);
  checkG4(args.root, checks, liveRef, stagingRef, changedFiles);
  checkG5(checks, changedFiles);

  // Static checks — worktree-backed, run after.
  checkS1(args.root, checks, liveRef, stagingRef);
  checkS2(args.root, checks, liveRef, stagingRef, changedFiles);
  checkS3(args.root, checks, liveRef, stagingRef);
  checkS4(args.root, checks, liveRef, stagingRef, changedFiles);
  checkS5(args.root, checks, liveRef, stagingRef);
  checkS6(args.root, checks, liveRef, stagingRef, changedFiles);
  checkS7(args.root, checks, liveRef, stagingRef, changedFiles, config);

  const output = {
    checker: 'code',
    mode: 'pre-merge',
    startedAt,
    context,
    checks: checks.checks,
    summary: checks.summary(),
  };

  console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.summary.p0Fail > 0 ? 1 : 0; return;
}

main().catch((err) => {
  console.log(
    JSON.stringify({
      checker: 'code',
      startedAt: new Date().toISOString(),
      context: {},
      checks: [],
      summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 },
      error: `Unhandled error: ${err.stack || err.message}`,
    })
  );
  process.exitCode = 1; return;
});
