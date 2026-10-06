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
  const selectors = new Map(readJson(selectorsPath).map((s) => [s.name, s]));

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
    .map((s) => {
      const entry = selectors.get(s.name) ?? {};
      return { ...s, selector: entry.selector ?? null, route: entry.route ?? null, before: entry.before ?? null, hooks: entry.hooks ?? null };
    });
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

async function readProps(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const css = {};
    for (const p of ['background-color', 'color', 'border-color', 'opacity', 'transform', 'max-height', 'visibility', 'display', 'text-decoration-line', 'box-shadow']) {
      css[p] = cs.getPropertyValue(p);
    }
    return {
      x: r.left, y: r.top, width: r.width, height: r.height,
      transform: cs.transform, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, css,
    };
  }, selector);
}

async function runStep(page, step, snapshots = {}) {
  const loc = step.selector ? page.locator(step.selector).first() : null;
  switch (step.do) {
    case 'click': await loc.scrollIntoViewIfNeeded(); await loc.click({ timeout: 5000 }); break;
    case 'hover': await loc.scrollIntoViewIfNeeded(); await loc.hover({ timeout: 5000 }); break;
    case 'focus': await loc.focus(); break;
    case 'press': await (loc ? loc.press(step.key) : page.keyboard.press(step.key)); break;
    case 'fill': await loc.fill(String(step.value ?? '')); break;
    case 'wait': await page.waitForTimeout(step.ms ?? 300); break;
    case 'waitFor': await page.locator(step.selector).first().waitFor({ state: step.state ?? 'visible', timeout: step.ms ?? 8000 }); break;
    case 'scroll':
      if (loc) await loc.scrollIntoViewIfNeeded();
      else await page.evaluate((y) => window.scrollTo(0, y), step.y ?? 0);
      await page.waitForTimeout(150);
      break;
    case 'swipe': {
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      const sx = box.x + box.width / 2;
      const sy = box.y + box.height / 2;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + (step.dx ?? -200), sy + (step.dy ?? 0), { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      break;
    }
    case 'snapshot': snapshots[step.as ?? 'before'] = await readProps(page, step.selector); break;
    default: throw new Error(`Unknown step "${step.do}"`);
  }
}

/**
 * The `before` steps for one viewport: an array, or { desktop: [...], mobile: [...], mobileBelow?: 1024 }.
 * Sweep widths pick mobile below `mobileBelow` (default 768).
 */
function beforeSteps(section, vp) {
  const b = section.before;
  if (!b) return [];
  if (Array.isArray(b)) return b;
  const key = vp.name === 'desktop' || vp.name === 'mobile' ? vp.name : (vp.width < (b.mobileBelow ?? 768) ? 'mobile' : 'desktop');
  return b[key] ?? [];
}

/**
 * Sections with their own route or `before` steps get a fresh page so their
 * state (an open menu, a drawer) doesn't leak into other sections. Returns
 * { page, close } — close() is a no-op for the shared page.
 */
async function sectionPage(browser, shared, section, vp, opts) {
  const steps = beforeSteps(section, vp);
  if (!section.route && !steps.length) return { page: shared, close: async () => {}, error: null };
  const { context, page } = await openPage(browser, { ...opts, route: section.route ?? opts.route, viewport: vp });
  try {
    for (const step of steps) await runStep(page, step);
    await page.waitForTimeout(200);
    return { page, close: () => context.close(), error: null };
  } catch (err) {
    return { page, close: () => context.close(), error: `before step failed: ${err.message.split('\n')[0]}` };
  }
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
  readProps,
  runStep,
  beforeSteps,
  sectionPage,
};
