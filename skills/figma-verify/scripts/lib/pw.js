'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// ── Args ────────────────────────────────────────────────────────

function parseFlags(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function requireFlags(flags, names, usage) {
  const missing = names.filter((n) => !flags[n]);
  if (missing.length) {
    console.error(`Missing: ${missing.map((m) => `--${m}`).join(', ')}\nUsage: ${usage}`);
    process.exit(1);
  }
}

// ── Artifacts ───────────────────────────────────────────────────

function artifactsDir(feature) {
  return path.resolve(process.cwd(), '.buildspace/artifacts', feature);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function roundDir(feature, round) {
  const dir = path.join(artifactsDir(feature), 'verify', `round-${round}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Joins sections.json (names, dumps, Figma screenshots) with selectors.json
 * (CSS selector per section) and the figma-dumps indexes (frame widths).
 */
function loadFeature(feature, { only } = {}) {
  const dir = artifactsDir(feature);
  const sections = readJson(path.join(dir, 'sections.json'));
  const selectorsPath = path.join(dir, 'selectors.json');
  if (!fs.existsSync(selectorsPath)) {
    throw new Error(`selectors.json not found in ${dir} — map each section name to its CSS selector first`);
  }
  const selectors = new Map(readJson(selectorsPath).map((s) => [s.name, s.selector]));

  const viewports = {};
  for (const vp of ['desktop', 'mobile']) {
    const idx = path.join(dir, 'figma-dumps', `${vp}-index.json`);
    if (!fs.existsSync(idx)) continue;
    const index = readJson(idx);
    const [w, h] = String(index.rootSize).split('×').map(Number);
    viewports[vp] = { name: vp, width: Math.round(w), height: Math.min(Math.round(h) || 900, vp === 'mobile' ? 874 : 900) };
  }

  const wanted = only ? new Set(String(only).split(',').map((s) => s.trim())) : null;
  const list = sections
    .filter((s) => !wanted || wanted.has(s.name))
    .map((s) => ({ ...s, selector: selectors.get(s.name) ?? null }));
  return { dir, sections: list, viewports };
}

// ── Playwright ──────────────────────────────────────────────────

// Errors produced by Shopify's platform scripts / dev proxy, not the theme.
const PLATFORM_NOISE = /(shop\.app|frame-ancestors|monorail|shopifycloud|web-pixels|wpm@|checkout\.shopify|shopify-perf-kit|trekkie|\/api\/collect|\/\.well-known\/|sf_private_access_tokens|captcha|hcaptcha|recaptcha)/i;

function resolvePlaywright() {
  const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    for (const req of [cwdRequire, require]) {
      try {
        const mod = req(name);
        if (mod?.chromium) return mod;
      } catch {
        // try next
      }
    }
  }
  console.error('Playwright not found. Install it in the project: npm i -D @playwright/test && npx playwright install chromium');
  process.exit(1);
}

async function launch() {
  const pw = resolvePlaywright();
  try {
    return await pw.chromium.launch({ headless: true });
  } catch (err) {
    console.error(`Chromium failed to launch: ${err.message}\nRun: npx playwright install chromium`);
    process.exit(1);
  }
}

function joinUrl(base, route = '/') {
  return new URL(route || '/', base.endsWith('/') ? base : `${base}/`).toString();
}

async function handlePassword(page, password) {
  if (!password) return;
  const input = await page.$('input[type="password"]');
  if (!input) return;
  await input.fill(password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.keyboard.press('Enter'),
  ]);
}

/**
 * Opens a page and makes it deterministic enough to measure: scrolls through
 * to trigger lazy content, waits for fonts and images, returns to the top.
 */
async function openPage(browser, { url, route, viewport, password, deviceScaleFactor = 1, freeze = true }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height ?? 900 },
    deviceScaleFactor,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const platformNoise = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text().slice(0, 300);
    // Resource failures are tracked (with URLs) via responses below.
    if (/^Failed to load resource/i.test(text)) return;
    (PLATFORM_NOISE.test(text) ? platformNoise : consoleErrors).push(text);
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err.message).slice(0, 300)}`));
  const failedRequests = [];
  const host = new URL(url).host;
  page.on('response', (res) => {
    if (res.status() < 400) return;
    const u = res.url();
    const themeAsset = new URL(u).host === host || /\/cdn\/shop\/t\/|\/assets\//.test(u);
    if (themeAsset && !PLATFORM_NOISE.test(u)) failedRequests.push(`${res.status()} ${u.slice(0, 200)}`);
    else platformNoise.push(`${res.status()} ${u.slice(0, 120)}`);
  });

  await page.goto(joinUrl(url, route), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await handlePassword(page, password);
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  if (freeze) {
    await page.addStyleTag({
      content: '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}',
    });
  }
  await settle(page);
  return { context, page, consoleErrors, failedRequests, platformNoise };
}

async function settle(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const max = document.documentElement.scrollHeight;
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await document.fonts?.ready;
  }).catch(() => {});
  await waitForImages(page);
  await page.waitForTimeout(150);
}

async function waitForImages(page, scope = null, timeout = 12000) {
  await Promise.race([
    page.evaluate(async (sel) => {
      const root = sel ? document.querySelector(sel) : document;
      if (!root) return;
      const pending = [...root.querySelectorAll('img')].filter((img) => !img.complete);
      await Promise.all(pending.map((img) => new Promise((r) => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
        setTimeout(r, 5000);
      })));
    }, scope).catch(() => {}),
    new Promise((r) => setTimeout(r, timeout)),
  ]);
}

/**
 * Hides fixed/sticky elements outside the target so they don't paint over an
 * element screenshot. Returns a restore function.
 */
async function hideOverlays(page, selector) {
  await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    window.__verifyHidden = [];
    for (const el of document.querySelectorAll('body *')) {
      if (target && (target.contains(el) || el.contains(target))) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        window.__verifyHidden.push([el, el.style.visibility]);
        el.style.visibility = 'hidden';
      }
    }
  }, selector);
  return () => page.evaluate(() => {
    for (const [el, v] of window.__verifyHidden ?? []) el.style.visibility = v;
    window.__verifyHidden = [];
  });
}

function resolveViewport(spec, viewports) {
  if (typeof spec === 'number' || /^\d+$/.test(String(spec))) {
    return { name: `${spec}`, width: Number(spec), height: 900 };
  }
  const vp = viewports[spec];
  if (!vp) throw new Error(`Unknown viewport "${spec}" (have: ${Object.keys(viewports).join(', ')})`);
  return vp;
}

module.exports = {
  parseFlags,
  requireFlags,
  artifactsDir,
  readJson,
  roundDir,
  loadFeature,
  launch,
  openPage,
  settle,
  waitForImages,
  hideOverlays,
  resolveViewport,
  joinUrl,
};
