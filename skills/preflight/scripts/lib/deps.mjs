/**
 * deps.mjs — make Playwright, Lighthouse and Chromium available to the checkers.
 *
 * The plugin ships without node_modules, and the plugin folder is replaced on every
 * update, so dependencies are installed once into a per-user folder that survives
 * updates and is shared by every project:
 *   $PREFLIGHT_DEPS_DIR, else $CLAUDE_PLUGIN_DATA/preflight-deps, else ~/.cache/shopify-theme-toolkit/preflight-deps
 *
 * run-preflight.mjs calls ensureDeps() once and exports NODE_PATH to the checker
 * processes, so every require('playwright' | 'lighthouse' | 'chrome-launcher') resolves.
 * A failed install never fails the run: the browser checkers then SKIP with their usual reason.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['playwright', 'lighthouse', 'chrome-launcher'];

export function depsDir(env = process.env) {
  if (env.PREFLIGHT_DEPS_DIR) return env.PREFLIGHT_DEPS_DIR;
  if (env.CLAUDE_PLUGIN_DATA) return path.join(env.CLAUDE_PLUGIN_DATA, 'preflight-deps');
  return path.join(os.homedir(), '.cache', 'shopify-theme-toolkit', 'preflight-deps');
}

function wantedDependencies() {
  return JSON.parse(readFileSync(path.join(SCRIPTS_DIR, 'package.json'), 'utf-8')).dependencies || {};
}

function stamp() {
  const lock = path.join(SCRIPTS_DIR, 'package-lock.json');
  const hash = createHash('sha1').update(readFileSync(path.join(SCRIPTS_DIR, 'package.json')));
  if (existsSync(lock)) hash.update(readFileSync(lock));
  return hash.digest('hex').slice(0, 12);
}

function resolveFrom(dir, name) {
  try {
    return createRequire(path.join(dir, 'package.json'))(name);
  } catch {
    return null;
  }
}

function chromiumReady(playwright) {
  try {
    const exe = playwright?.chromium?.executablePath();
    return Boolean(exe && existsSync(exe));
  } catch {
    return false;
  }
}

/** Where the packages already resolve from, or null. The scripts folder wins (a local `npm install` there). */
export function locateDeps(env = process.env) {
  for (const dir of [SCRIPTS_DIR, depsDir(env)]) {
    const playwright = resolveFrom(dir, 'playwright');
    if (!playwright || PACKAGES.some((p) => !resolveFrom(dir, p))) continue;
    return { dir, nodeModules: path.join(dir, 'node_modules'), chromium: chromiumReady(playwright) };
  }
  return null;
}

/**
 * Returns { ok, dir, nodeModules, installed, error }. Installs only what is missing:
 * npm packages when absent or when scripts/package.json changed, Chromium when absent.
 */
export function ensureDeps({ install = true, env = process.env, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const deps = wantedDependencies();
  const dir = depsDir(env);
  const stampFile = path.join(dir, '.preflight-deps');
  const current = existsSync(stampFile) ? readFileSync(stampFile, 'utf-8').trim() : null;
  const found = locateDeps(env);
  const stale = found?.dir === dir && current !== stamp();

  if (found && found.chromium && !stale) return { ok: true, dir: found.dir, nodeModules: found.nodeModules, installed: false };
  if (!install) return { ok: false, dir, nodeModules: path.join(dir, 'node_modules'), installed: false, error: found ? 'Chromium is not installed' : 'packages are not installed' };

  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8', timeout: 15 * 60 * 1000 });
  try {
    if (!found || stale || found.dir !== dir) {
      log(`[preflight] installing ${Object.keys(deps).join(', ')} into ${dir} (one time, ~1-3 min)…`);
      mkdirSync(dir, { recursive: true });
      copyFileSync(path.join(SCRIPTS_DIR, 'package.json'), path.join(dir, 'package.json'));
      const lock = path.join(SCRIPTS_DIR, 'package-lock.json');
      if (existsSync(lock)) {
        copyFileSync(lock, path.join(dir, 'package-lock.json'));
        try {
          run('npm', ['ci', '--no-audit', '--no-fund', '--omit=dev'], dir);
        } catch {
          run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], dir);
        }
      } else run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], dir);
    }
    log('[preflight] installing Chromium for Playwright (one time)…');
    run('npx', ['--yes', 'playwright', 'install', 'chromium'], dir);
    writeFileSync(stampFile, stamp());
    const after = locateDeps(env);
    if (!after?.chromium) return { ok: false, dir, nodeModules: path.join(dir, 'node_modules'), installed: true, error: 'install finished but Playwright/Chromium still not found' };
    return { ok: true, dir: after.dir, nodeModules: after.nodeModules, installed: true };
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' | ');
    log(`[preflight] dependency install failed — browser checks will be SKIPPED: ${detail}`);
    return { ok: false, dir, nodeModules: path.join(dir, 'node_modules'), installed: false, error: detail };
  }
}

/** NODE_PATH value with the deps folder first, keeping anything already set. */
export function nodePathWith(nodeModules, current = process.env.NODE_PATH) {
  const parts = [nodeModules, ...(current ? current.split(path.delimiter) : [])].filter(Boolean);
  return [...new Set(parts)].join(path.delimiter);
}
