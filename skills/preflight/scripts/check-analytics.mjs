#!/usr/bin/env node
/**
 * check-analytics.mjs — /preflight checker 2: Playwright, live vs preview, event-set diff.
 *
 * Runs the same scripted journey on both URLs — home → collection → PDP →
 * add to cart → cart → checkout boundary (never proceeds into checkout) —
 * capturing GTM/GA4/Meta activity via page.addInitScript hooks, then diffs
 * what fired.
 *
 * Usage:
 *   node check-analytics.mjs --config .buildspace/preflight/preflight.config.json --root .
 *     [--live-url https://store.com] [--preview-url "https://store.com?preview_theme_id=123"]
 *     [--artifacts-dir path]
 *
 * Journeys come from config.analytics.journeys (one or more), else from
 * --live-url/--preview-url (a product URL becomes the journey's PDP), else
 * from config.fixtures. Preview-side query params (preview_theme_id, pb, and
 * a PDP `view`) are carried onto every step, not just the first navigation.
 *
 * Every step records whether it actually happened (nav status, add-to-cart
 * confirmed via /cart.js item_count, checkout intent observed), with a
 * screenshot on failure. A step that could not be driven on either side
 * makes the checks that depend on it SKIPPED — never a silent PASS.
 *
 * Prints one JSON object to stdout (see §8 of the preflight brief). Exits
 * non-zero on any P0 fail. Per §6 of the brief: A6 (network beacons) is
 * P1 only, never P0 — preview themes are not a reliable analytics
 * environment. Script presence and dataLayer pushes are the reliable
 * signals; those are what gate.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/* ── CLI args ─────────────────────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback = null) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  return {
    root: path.resolve(get('--root', '.')),
    config: get('--config', '.buildspace/preflight/preflight.config.json'),
    liveUrl: get('--live-url'),
    previewUrl: get('--preview-url'),
    mode: get('--mode', 'pre-merge'), // pre-merge | post-merge | baseline
    baselineFile: get('--baseline-file'),
    artifactsDir: get('--artifacts-dir'),
  };
}

function loadConfig(root, configPath) {
  const full = path.isAbsolute(configPath) ? configPath : path.join(root, configPath);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf-8'));
  } catch {
    return null;
  }
}

/* ── result accumulator (same shape as check-code.mjs / check-performance.mjs) ── */

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

/* ── Playwright resolution (mirrors compare/scripts/capture-sections.js) ── */

function resolvePlaywright() {
  try {
    return require('playwright');
  } catch {}
  try {
    return createRequire(path.join(process.cwd(), 'package.json'))('playwright');
  } catch {}
  if (process.env.NODE_PATH) {
    for (const dir of process.env.NODE_PATH.split(path.delimiter)) {
      try {
        return createRequire(path.join(dir, 'package.json'))('playwright');
      } catch {}
    }
  }
  console.error('[check-analytics] Playwright not found — installing...');
  try {
    // stdio must route to stderr, never inherit stdout — this script's own stdout is a
    // strict JSON channel when invoked by run-preflight.mjs, and npm's/playwright's install
    // chatter would corrupt it (confirmed: broke the orchestrator's JSON.parse in practice).
    execFileSync('npm', ['install', 'playwright'], { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('npx', ['playwright', 'install', 'chromium'], { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'] });
    return createRequire(path.join(__dirname, 'package.json'))('playwright');
  } catch {
    return null;
  }
}

async function handlePassword(page, password) {
  if (!password) return;
  try {
    const input = await page.$('input[type="password"]');
    if (input) {
      await input.fill(password);
      const btn = await page.$('button[type="submit"]');
      if (btn) {
        await btn.click();
        await page.waitForLoadState('domcontentloaded');
      }
    }
  } catch {
    // No password page.
  }
}

/* ── capture instrumentation ─────────────────────────────────────────────
 * Installed via addInitScript, before any page script runs. GTM/gtag/fbq
 * assign these globals asynchronously and sometimes *replace* the array/
 * function outright, so plain wrapping at init time is not enough — we use
 * accessor properties on `window` so a later reassignment is caught and
 * re-wrapped, per §6 of the brief ("handle both cases"). */

function captureInitScript() {
  const captured = { dataLayer: [], gtag: [], fbq: [], sendBeacon: [] };
  window.__preflightCapture = captured;

  function patchArrayPush(arr) {
    if (arr.__preflightPatched) return arr;
    const origPush = arr.push.bind(arr);
    arr.push = (...items) => {
      items.forEach((item) => captured.dataLayer.push(item));
      return origPush(...items);
    };
    arr.__preflightPatched = true;
    return arr;
  }

  let _dataLayer = patchArrayPush(window.dataLayer || []);
  Object.defineProperty(window, 'dataLayer', {
    configurable: true,
    get() {
      return _dataLayer;
    },
    set(newArr) {
      if (Array.isArray(newArr) && newArr !== _dataLayer) {
        newArr.forEach((item) => captured.dataLayer.push(item));
        _dataLayer = patchArrayPush(newArr);
      } else {
        _dataLayer = newArr;
      }
    },
  });

  let _gtag;
  Object.defineProperty(window, 'gtag', {
    configurable: true,
    get() {
      return _gtag;
    },
    set(fn) {
      _gtag = (...args) => {
        captured.gtag.push(args);
        return fn ? fn(...args) : undefined;
      };
    },
  });

  let _fbq;
  Object.defineProperty(window, 'fbq', {
    configurable: true,
    get() {
      return _fbq;
    },
    set(fn) {
      _fbq = (...args) => {
        captured.fbq.push(args);
        return fn ? fn(...args) : undefined;
      };
    },
  });

  if (navigator.sendBeacon) {
    const origSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      captured.sendBeacon.push({ url: String(url) });
      return origSendBeacon(url, data);
    };
  }
}

/* ── network endpoint classification ─────────────────────────────────── */

const GA_REQUEST_PATTERNS = [/google-analytics\.com/, /analytics\.google\.com/, /\/g\/collect/];
const META_REQUEST_PATTERNS = [/facebook\.com\/tr/];
const GTM_SCRIPT_PATTERN = /googletagmanager\.com\/gtm\.js/;
const GA4_SCRIPT_PATTERN = /googletagmanager\.com\/gtag\/js/;
const META_PIXEL_SCRIPT_PATTERN = /connect\.facebook\.net\/.*\/fbevents\.js/;

function classifyRequest(url) {
  const tags = [];
  if (GA_REQUEST_PATTERNS.some((re) => re.test(url))) tags.push('ga');
  if (META_REQUEST_PATTERNS.some((re) => re.test(url))) tags.push('meta');
  if (GTM_SCRIPT_PATTERN.test(url)) tags.push('gtm-script');
  if (GA4_SCRIPT_PATTERN.test(url)) tags.push('ga4-script');
  if (META_PIXEL_SCRIPT_PATTERN.test(url)) tags.push('meta-script');
  return tags;
}

/* ── journey specs ───────────────────────────────────────────────────── */

const PLACEHOLDER_HANDLE = /^(handle|your-handle|todo|x)?$/i;

function toPath(value, prefix) {
  if (!value || PLACEHOLDER_HANDLE.test(String(value).trim())) return null;
  const v = String(value).trim();
  return v.startsWith('/') ? v : `${prefix}${v}`;
}

/**
 * Journey specs, in precedence order:
 *   1. config.analytics.journeys[] — { name, collection?, product?, productView?, productPreviewView? }
 *   2. --live-url/--preview-url — a product URL becomes the PDP step (with each side's `view`)
 *   3. config.fixtures — productInStock / collection
 * Collection/product accept a handle or a full path. Placeholder handles ("handle") count as unset.
 */
export function resolveJourneys(config, args) {
  const fixtures = config?.fixtures || {};
  const configured = config?.analytics?.journeys;
  if (Array.isArray(configured) && configured.length > 0) {
    return configured.map((j, i) => ({
      name: j.name || `journey-${i + 1}`,
      collection: toPath(j.collection, '/collections/'),
      product: toPath(j.product, '/products/'),
      productView: j.productView || null,
      productPreviewView: j.productPreviewView ?? j.productView ?? null,
    }));
  }
  const fromUrl = (u) => {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  };
  const live = args.liveUrl ? fromUrl(args.liveUrl) : null;
  const preview = args.previewUrl ? fromUrl(args.previewUrl) : null;
  const isProduct = (u) => u && /\/products\//.test(u.pathname);
  return [
    {
      name: 'default',
      collection: toPath(fixtures.collection, '/collections/'),
      product: isProduct(live) ? live.pathname : isProduct(preview) ? preview.pathname : toPath(fixtures.productInStock, '/products/'),
      productView: live?.searchParams.get('view') || null,
      productPreviewView: preview?.searchParams.get('view') || live?.searchParams.get('view') || null,
    },
  ];
}

/** A side of the comparison: where it lives and which query params pin it to its theme. */
export function resolveSide(url, fallbackOrigin, extraParams = {}) {
  let origin = fallbackOrigin;
  const params = { ...extraParams };
  if (url) {
    try {
      const u = new URL(url);
      origin = u.origin;
      for (const key of ['preview_theme_id', 'pb', '_fd', '_ab']) if (u.searchParams.has(key)) params[key] = u.searchParams.get(key);
    } catch {}
  }
  return origin ? { origin, params } : null;
}

export function stepUrl(side, pathname, view) {
  const u = new URL(pathname, side.origin);
  for (const [k, v] of Object.entries(side.params)) u.searchParams.set(k, v);
  if (view) u.searchParams.set('view', view);
  return u.toString();
}

const DEFAULT_ADD_TO_CART_SELECTORS = [
  'form[action*="/cart/add"] button[type="submit"]',
  'form[action*="/cart/add"] [type="submit"]',
  'button[name="add"]',
  '[data-add-to-cart]',
  'button:has-text("Add to cart")',
  'button:has-text("Add to bag")',
  // Apps and custom themes often render the control as a div/span (e.g. cart-drawer apps) —
  // fall back to the smallest element whose text starts with the label.
  'text=/^\\s*add to (cart|bag)/i',
];
const DEFAULT_CHECKOUT_SELECTORS = ['button[name="checkout"]', 'input[name="checkout"]', 'a[href*="/checkout"]', 'button:has-text("Checkout")', 'a:has-text("Checkout")', 'text=/^\\s*(check ?out|proceed to checkout)\\b/i'];

// Marketing popups / newsletter modals routinely appear after a page or two and swallow clicks.
const DEFAULT_DISMISS_SELECTORS = [
  '[role="dialog"] [aria-label*="close" i]',
  '[aria-modal="true"] [aria-label*="close" i]',
  '[class*="popup" i] [class*="close" i]',
  '[class*="modal" i] [class*="close" i]',
  'button[aria-label*="close" i]',
  '.needsclick.klaviyo-close-form',
];

/* ── the journey ──────────────────────────────────────────────────────── */

/** Close whatever overlay is up (Escape, then any visible close control). Returns what it closed. */
async function dismissOverlays(page, selectors) {
  const closed = [];
  await page.keyboard.press('Escape').catch(() => {});
  for (const sel of [...(selectors.dismiss || []), ...DEFAULT_DISMISS_SELECTORS]) {
    try {
      const loc = page.locator(`${sel} >> visible=true`);
      const n = Math.min(await loc.count(), 3);
      for (let i = 0; i < n; i++) {
        if (await loc.nth(i).click({ timeout: 1500 }).then(() => true).catch(() => false)) closed.push(sel);
      }
    } catch {}
  }
  if (closed.length) await page.waitForTimeout(400);
  return closed;
}

/**
 * Click like a shopper. Try the real click first — closing "overlays" up front is harmful when the
 * thing on screen is the flow itself (a cart drawer holding the checkout button). Only if the click
 * is intercepted: close overlays and retry, then dispatch the click on the control itself. The path
 * taken is recorded so a verifier can see the control was covered.
 */
async function shopperClick(page, locator, selectors, clickOpts = {}) {
  try {
    await locator.click({ timeout: 6000, ...clickOpts });
    return { how: 'click', dismissed: [] };
  } catch (first) {
    const dismissed = await dismissOverlays(page, selectors);
    try {
      await locator.click({ timeout: 3000, ...clickOpts });
      return { how: 'click after closing overlay', dismissed };
    } catch {
      await locator.dispatchEvent('click');
      return { how: `dispatched click (a real click was intercepted: ${first.message.split('\n')[0]})`, dismissed };
    }
  }
}

async function cartItemCount(page) {
  return page
    .evaluate(async () => {
      try {
        const res = await fetch('/cart.js', { credentials: 'same-origin', headers: { accept: 'application/json' } });
        return (await res.json()).item_count ?? null;
      } catch {
        return null;
      }
    })
    .catch(() => null);
}

/** First selector with a visible match. Also returns per-selector match counts for diagnosis. */
async function firstVisible(page, selectors) {
  const tried = [];
  for (const sel of selectors) {
    try {
      const total = await page.locator(sel).count();
      const visible = page.locator(`${sel} >> visible=true`).first();
      const isVisible = total > 0 && (await visible.count()) > 0;
      tried.push({ selector: sel, matches: total, visible: isVisible });
      if (isVisible) return { locator: visible, selector: sel, tried };
    } catch (e) {
      tried.push({ selector: sel, error: e.message.split('\n')[0] });
    }
  }
  return { locator: null, selector: null, tried };
}

async function runJourney(browser, side, journey, { password, selectors, artifactsDir, sideLabel }) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const requestHits = { ga: [], meta: [], gtmScript: false, ga4Script: false, metaPixelScript: false };
  const cartAdds = [];
  page.on('request', (req) => {
    const url = req.url();
    const tags = classifyRequest(url);
    if (tags.includes('ga')) requestHits.ga.push(url);
    if (tags.includes('meta')) requestHits.meta.push(url);
    if (tags.includes('gtm-script')) requestHits.gtmScript = true;
    if (tags.includes('ga4-script')) requestHits.ga4Script = true;
    if (tags.includes('meta-script')) requestHits.metaPixelScript = true;
  });
  page.on('response', (res) => {
    if (/\/cart\/add(\.js)?(\?|$)/.test(res.url())) cartAdds.push(res.status());
  });

  await page.addInitScript(captureInitScript);

  // window.__preflightCapture lives on `window` and is wiped by every
  // navigation (addInitScript re-runs fresh, discarding whatever the
  // previous page captured). This is a multi-page journey, so capture state
  // must be pulled and merged into this Node-side accumulator after every
  // step — reading it only once at the end silently drops every event that
  // fired on an earlier page (e.g. add_to_cart on the PDP, before the
  // journey navigates on to /cart).
  const captured = { dataLayer: [], gtag: [], fbq: [], sendBeacon: [] };
  async function pullCapture() {
    const pageCapture = await page.evaluate(() => window.__preflightCapture || { dataLayer: [], gtag: [], fbq: [], sendBeacon: [] }).catch(() => null);
    if (!pageCapture) return;
    captured.dataLayer.push(...pageCapture.dataLayer);
    captured.gtag.push(...pageCapture.gtag);
    captured.fbq.push(...pageCapture.fbq);
    captured.sendBeacon.push(...pageCapture.sendBeacon);
  }

  const nav = { waitUntil: 'domcontentloaded', timeout: 45000 };
  const notes = [];
  const steps = [];

  async function screenshot(step) {
    if (!artifactsDir) return null;
    try {
      mkdirSync(artifactsDir, { recursive: true });
      const file = path.join(artifactsDir, `${journey.name}-${sideLabel}-${step}.png`);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return null;
    }
  }
  async function record(step, status, detail, extra = {}) {
    const entry = { step, status, detail, url: page.url(), ...extra };
    if (status === 'failed') entry.screenshot = await screenshot(step);
    steps.push(entry);
    if (status !== 'ok') notes.push(`${step} ${status}: ${detail}`);
  }
  async function visit(step, target) {
    try {
      const res = await page.goto(target, nav);
      if (step === 'home') await handlePassword(page, password);
      const status = res?.status() ?? null;
      const finalUrl = page.url();
      // Shopify names the rendering theme in server-timing — proof of which theme this step ran on.
      const renderedTheme = ((res?.headers()['server-timing'] || '').match(/theme;desc="?(\d+)/) || [])[1] || null;
      if (status != null && status >= 400) return record(step, 'failed', `HTTP ${status}`, { requested: target, httpStatus: status, theme: renderedTheme });
      if (/\/password(\?|$)/.test(new URL(finalUrl).pathname)) return record(step, 'failed', 'landed on the storefront password page', { requested: target, theme: renderedTheme });
      return record(step, 'ok', `HTTP ${status ?? 'n/a'}`, { requested: target, httpStatus: status, theme: renderedTheme });
    } catch (e) {
      return record(step, 'failed', `navigation error: ${e.message.split('\n')[0]}`, { requested: target });
    }
  }

  // Home
  await visit('home', stepUrl(side, '/'));
  await page.waitForTimeout(1500); // let GTM/GA4/Meta scripts finish initializing
  let consentBannerVisible = false;
  try {
    const consent = page.locator('text=/cookie|consent/i').first();
    consentBannerVisible = await consent.isVisible({ timeout: 2000 });
  } catch {
    consentBannerVisible = false;
  }
  await pullCapture();

  // Collection
  if (journey.collection) {
    await visit('collection', stepUrl(side, journey.collection));
    await page.waitForTimeout(1000);
    await pullCapture();
  } else {
    await record('collection', 'skipped', 'no collection configured for this journey');
  }

  // PDP + add to cart
  if (journey.product) {
    const view = sideLabel === 'preview' ? journey.productPreviewView : journey.productView;
    await visit('pdp', stepUrl(side, journey.product, view));
    await page.waitForTimeout(1000);
    await pullCapture();

    const before = await cartItemCount(page);
    const { locator, selector, tried } = await firstVisible(page, [...(selectors.addToCart || []), ...DEFAULT_ADD_TO_CART_SELECTORS]);
    if (!locator) {
      await record('addToCart', 'failed', 'no visible add-to-cart control matched any selector', { selectorsTried: tried });
    } else {
      try {
        const disabled = await locator.isDisabled().catch(() => false);
        const clicked = await shopperClick(page, locator, selectors);
        await page.waitForTimeout(2500);
        await pullCapture(); // the click may itself navigate (e.g. a non-AJAX add-to-cart form) — pull before the next step's nav can wipe it
        const after = await cartItemCount(page);
        const addOk = cartAdds.some((st) => st >= 200 && st < 300);
        if ((before != null && after != null && after > before) || addOk) {
          await record('addToCart', 'ok', `cart item_count ${before ?? '?'} → ${after ?? '?'}${addOk ? ', /cart/add responded 2xx' : ''} (${clicked.how}${clicked.dismissed.length ? `; closed overlay: ${clicked.dismissed[0]}` : ''})`, { selector, click: clicked });
        } else {
          await record('addToCart', 'failed', `clicked "${selector}" (${clicked.how}) but the cart did not change (item_count ${before ?? '?'} → ${after ?? '?'}, /cart/add responses: ${cartAdds.join(',') || 'none'})${disabled ? ' — control was disabled (sold out / no variant?)' : ''}`, { selector, selectorsTried: tried, click: clicked });
        }
      } catch (e) {
        await record('addToCart', 'failed', `click on "${selector}" failed: ${e.message.split('\n')[0]}`, { selector, selectorsTried: tried });
      }
    }
  } else {
    await record('pdp', 'skipped', 'no product configured for this journey');
    await record('addToCart', 'skipped', 'no product configured for this journey');
  }

  // Cart
  await visit('cart', stepUrl(side, '/cart'));
  await page.waitForTimeout(1000);
  await pullCapture();

  // Checkout boundary — click, capture the intent, never actually enter checkout.
  let checkoutRequested = false;
  await page
    .route('**/checkout**', (route) => {
      checkoutRequested = true;
      return route.abort();
    })
    .catch(() => {});
  const { locator: checkoutBtn, selector: checkoutSelector, tried: checkoutTried } = await firstVisible(page, [...(selectors.checkout || []), ...DEFAULT_CHECKOUT_SELECTORS]);
  if (!checkoutBtn) {
    await record('checkout', 'failed', 'no visible checkout control matched any selector (empty cart, or a cart drawer/third-party checkout button?)', { selectorsTried: checkoutTried });
  } else {
    const eventsBefore = captured.dataLayer.length;
    const urlBefore = page.url();
    const popupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
    const clicked = await shopperClick(page, checkoutBtn, selectors, { noWaitAfter: true }).catch((e) => ({ how: `click error: ${e.message.split('\n')[0]}`, dismissed: [] }));
    await page.waitForTimeout(1500);
    const popup = await popupPromise;
    await pullCapture();
    const signals = [checkoutRequested && '/checkout request intercepted', captured.dataLayer.length > eventsBefore && 'new dataLayer event(s)', page.url() !== urlBefore && 'navigation', popup && 'popup/new tab'].filter(Boolean);
    if (signals.length > 0) await record('checkout', 'ok', `${signals.join(', ')} (${clicked.how})`, { selector: checkoutSelector, click: clicked });
    else await record('checkout', 'failed', `clicked "${checkoutSelector}" (${clicked.how}) but saw no checkout intent (no /checkout request, event, navigation, or popup)`, { selector: checkoutSelector, selectorsTried: checkoutTried, click: clicked });
  }

  await context.close();
  return { captured, requestHits, consentBannerVisible, notes, steps };
}

/* ── event extraction ────────────────────────────────────────────────── */

function extractEvents(captured) {
  const events = new Map(); // eventName -> first payload (key set)
  for (const entry of captured.dataLayer) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.event === 'string') {
      if (!events.has(entry.event)) events.set(entry.event, entry);
    }
    // gtag's own implementation is `dataLayer.push(arguments)` — an array-like {0:'event',1:name,2:{...}}
    if (entry && (Array.isArray(entry) || typeof entry === 'object') && entry[0] === 'event' && typeof entry[1] === 'string') {
      if (!events.has(entry[1])) events.set(entry[1], entry[2] || {});
    }
  }
  for (const args of captured.gtag) {
    if (args[0] === 'event' && typeof args[1] === 'string' && !events.has(args[1])) {
      events.set(args[1], args[2] || {});
    }
  }
  return events;
}

/* ── main ─────────────────────────────────────────────────────────────── */

/** Human-readable "how is this actually wired" note, built only from signals already proven
 * reliable (network request classification, captured globals) — deliberately does NOT use
 * window.Shopify.analytics or Shopify's own monorail-edge relay as a presence signal for a
 * specific vendor, because both exist on every Shopify storefront regardless of whether the
 * merchant configured GA4/Meta at all; using either would make every store report "present"
 * unconditionally, which is worse than not detecting a delivery mechanism at all. */
function describeGtmDelivery(hits) {
  return hits.gtmScript ? 'GTM container script tag' : 'not detected';
}
function describeGa4Delivery(hits, eventsMapSize) {
  if (hits.ga4Script) return 'direct gtag.js script tag';
  if (hits.ga.length > 0) return 'network beacon observed, no gtag.js script tag seen (likely a Shopify native pixel, Customer Events, or an app-injected script)';
  if (eventsMapSize > 0) return 'dataLayer/gtag activity observed, no network beacon or script tag confirmed';
  return 'not detected';
}
function describeMetaDelivery(hits, fbqCount) {
  if (hits.metaPixelScript) return 'direct fbevents.js script tag';
  if (hits.meta.length > 0) return 'network beacon observed, no fbevents.js script tag seen (likely a Shopify native pixel, Customer Events, or an app-injected script)';
  if (fbqCount > 0) return 'fbq global activity observed, no network beacon or script tag confirmed';
  return 'not detected';
}

/**
 * Reduce a raw runJourney() result to a plain-JSON-serializable shape — this
 * is what both gets diffed live-vs-preview (pre-merge) and written to/read
 * from preflight-baseline.json (baseline/post-merge). Event payloads are
 * reduced to their key sets only (never values) — the brief is explicit that
 * A5 compares shape, not content, and this also keeps no customer/order data
 * in a file that gets committed.
 */
function normalizeResult(journeyResult) {
  const eventsMap = extractEvents(journeyResult.captured);
  const events = {};
  for (const [name, payload] of eventsMap) {
    events[name] = Object.keys(payload || {}).filter((k) => k !== 'event').sort();
  }
  return {
    scripts: {
      gtm: !!journeyResult.requestHits.gtmScript,
      ga4: !!(journeyResult.requestHits.ga4Script || journeyResult.requestHits.ga.length > 0 || eventsMap.size > 0),
      metaPixel: !!(journeyResult.requestHits.metaPixelScript || journeyResult.captured.fbq.length > 0),
    },
    scriptDelivery: {
      gtm: describeGtmDelivery(journeyResult.requestHits),
      ga4: describeGa4Delivery(journeyResult.requestHits, eventsMap.size),
      metaPixel: describeMetaDelivery(journeyResult.requestHits, journeyResult.captured.fbq.length),
    },
    events,
    consentBannerVisible: !!journeyResult.consentBannerVisible,
    gaBeaconHits: journeyResult.requestHits.ga.length,
    metaBeaconHits: journeyResult.requestHits.meta.length,
    notes: journeyResult.notes,
    steps: journeyResult.steps,
  };
}

export const JOURNEY_STEPS = ['home', 'collection', 'pdp', 'addToCart', 'cart', 'checkout'];
/** Which journey step an expected event depends on. Overridable via config.analytics.eventSteps. */
export const DEFAULT_EVENT_STEPS = { page_view: 'home', view_item_list: 'collection', view_item: 'pdp', add_to_cart: 'addToCart', view_cart: 'cart', begin_checkout: 'checkout' };

/** Step status on one side. A result without step data (a pre-step-tracking baseline) is treated as ok. */
function stepStatus(result, step) {
  if (!Array.isArray(result?.steps)) return 'ok';
  return result.steps.find((s) => s.step === step)?.status || 'skipped';
}

const stepDetail = (result, step) => result?.steps?.find((s) => s.step === step) || null;

/**
 * A1–A8, generic over "reference" vs "current" — shared by pre-merge (live vs preview) and
 * post-merge (baseline vs current-live). `idSuffix` distinguishes journeys when there are several.
 */
export function evaluateAnalytics(checks, analyticsConfig, reference, current, labels, idSuffix = '', journeyName = null) {
  const ev = (refVal, curVal) => ({ [labels.referenceKey]: refVal, [labels.currentKey]: curVal });
  const cid = (base) => `${base}${idSuffix}`;
  const nm = (name) => (journeyName ? `${name} [${journeyName}]` : name);
  const c = {
    fail: (id, name, priority, summary, evidence, risk) => checks.push(cid(id), nm(name), priority, 'FAIL', summary, evidence, risk),
    pass: (id, name, priority, summary, evidence = {}) => checks.push(cid(id), nm(name), priority, 'PASS', summary, evidence, ''),
    info: (id, name, summary, evidence = {}) => checks.push(cid(id), nm(name), 'info', 'INFO', summary, evidence, ''),
    skip: (id, name, priority, summary, evidence = {}) => checks.push(cid(id), nm(name), priority, 'SKIPPED', summary, evidence, ''),
  };

  // A8 — did the journey itself work? A step that works on reference but not on current is a
  // storefront regression (the flow broke, or the control changed). A step that fails on BOTH is
  // a harness gap — the checks that depend on it below become SKIPPED, never a silent PASS.
  const regressedSteps = [];
  const bothFailed = [];
  for (const step of JOURNEY_STEPS) {
    const r = stepStatus(reference, step);
    const cur = stepStatus(current, step);
    const pair = { step, [labels.referenceKey]: stepDetail(reference, step), [labels.currentKey]: stepDetail(current, step) };
    if (r === 'ok' && cur !== 'ok') regressedSteps.push(pair);
    else if (r === 'failed' && cur === 'failed') bothFailed.push(pair);
  }
  if (regressedSteps.length > 0) {
    c.fail(
      'A8',
      'Journey steps complete',
      'P0',
      `${regressedSteps.length} journey step(s) work on ${labels.referenceLabel} but not on ${labels.currentLabel}: ${regressedSteps.map((r) => `${r.step} (${r[labels.currentKey]?.detail || 'not reached'})`).join('; ')}.`,
      { regressedSteps },
      'Either the shopper flow itself broke on this release (add to cart / checkout no longer works), or its markup changed so the journey can no longer drive it — both need a human look before release. Screenshots are linked per step.'
    );
  } else if (bothFailed.length > 0) {
    c.skip('A8', 'Journey steps complete', 'P1', `${bothFailed.length} journey step(s) could not be driven on either side — ${bothFailed.map((b) => `${b.step}: ${b[labels.referenceKey]?.detail}`).join('; ')}. Configure analytics.selectors / journeys so the harness can reach them.`, { bothFailed });
  } else {
    c.pass('A8', 'Journey steps complete', 'P0', `Every journey step that works on ${labels.referenceLabel} also works on ${labels.currentLabel}.`, ev(reference.steps?.map((s) => `${s.step}:${s.status}`), current.steps?.map((s) => `${s.step}:${s.status}`)));
  }

  // A1-A3 — diff-based, not gated on a human-set config assumption. Every store wires its
  // analytics differently (classic GTM, direct gtag/fbq, an app, or Shopify's native Customer
  // Events/Web Pixels sandbox) — a hardcoded expectGTM/expectGA4/expectMetaPixel flag has to be
  // manually calibrated per store and silently goes stale the moment the config file gets
  // regenerated from the template. The question that's actually robust across every store is
  // "does whatever was already working on the reference side still work on current" — same
  // pre-existing-vs-regression principle already used for A6/A7 and the code-layer checks.
  // config.analytics.expect* is intentionally no longer read here; it's retained in the config
  // schema only as a documentation hint / for a future baseline-mode assertion, not a gate.
  const evaluateScriptPresence = (id, name, key, riskIfRegressed) => {
    const wasPresent = reference.scripts[key];
    const isPresent = current.scripts[key];
    const delivery = current.scriptDelivery?.[key];
    if (wasPresent && !isPresent) {
      c.fail(id, name, 'P0', `Present on ${labels.referenceLabel} but did not load on ${labels.currentLabel}.`, { ...ev(true, false), referenceDelivery: reference.scriptDelivery?.[key] }, riskIfRegressed);
    } else if (!wasPresent && !isPresent) {
      c.info(id, name, `Not present on ${labels.referenceLabel} or ${labels.currentLabel} — not part of this store's stack (or delivered through a mechanism this journey didn't observe).`);
    } else {
      const addedNote = !wasPresent && isPresent ? ` (newly present vs ${labels.referenceLabel} — not a regression, just new)` : '';
      c.pass(id, name, 'P0', `Present on ${labels.currentLabel}${addedNote}. Delivery: ${delivery}.`, ev(reference.scripts[key], current.scripts[key]));
    }
  };

  evaluateScriptPresence('A1', 'GTM container script present', 'gtm', "GTM-managed tags (most of a client's analytics/marketing stack) will not fire.");
  evaluateScriptPresence('A2', 'GA4 tag present and initialised', 'ga4', 'GA4 tracking is blind — no view/conversion data.');
  evaluateScriptPresence('A3', 'Meta pixel script present', 'metaPixel', 'Meta ad campaigns lose conversion tracking and audience signals.');

  // A4 — every expected event that fires on reference also fires on current. An event whose
  // journey step didn't run on one side can't be compared at all — that's untestable, not a pass.
  const expectedEvents = analyticsConfig.expectedEvents || [];
  const eventSteps = { ...DEFAULT_EVENT_STEPS, ...(analyticsConfig.eventSteps || {}) };
  if (expectedEvents.length === 0) {
    c.info('A4', 'Event parity', 'No analytics.expectedEvents configured — nothing to check.');
  } else {
    const regressed = [];
    const notFiredOnReference = [];
    const untestable = [];
    for (const eventName of expectedEvents) {
      const step = eventSteps[eventName];
      if (step) {
        const r = stepStatus(reference, step);
        const cur = stepStatus(current, step);
        if (r !== 'ok' || cur !== 'ok') {
          untestable.push({ event: eventName, dependsOnStep: step, [labels.referenceKey]: r, [labels.currentKey]: cur });
          continue;
        }
      }
      const firedOnReference = eventName in reference.events;
      const firedOnCurrent = eventName in current.events;
      if (!firedOnReference) {
        notFiredOnReference.push(eventName);
        continue; // pre-existing gap — not this release's regression to report
      }
      if (!firedOnCurrent) regressed.push(eventName);
    }
    const base = { ...ev(Object.keys(reference.events), Object.keys(current.events)), notFiredOnReference, untestable };
    if (regressed.length > 0) {
      c.fail('A4', 'Event parity', 'P0', `${regressed.length} event(s) fire on ${labels.referenceLabel} but not on ${labels.currentLabel}: ${regressed.join(', ')}.${untestable.length ? ` (${untestable.length} more could not be tested.)` : ''}`, { regressed, ...base }, 'Analytics/remarketing/conversion tracking for these events goes dark.');
    } else if (untestable.length > 0) {
      c.skip('A4', 'Event parity', 'P0', `${untestable.length} expected event(s) could not be compared because the journey step they depend on did not run on both sides: ${untestable.map((u) => `${u.event} (needs ${u.dependsOnStep}: ${labels.referenceLabel} ${u[labels.referenceKey]}, ${labels.currentLabel} ${u[labels.currentKey]})`).join('; ')}.`, base);
    } else {
      c.pass(
        'A4',
        'Event parity',
        'P0',
        `Every expected event that fires on ${labels.referenceLabel} also fires on ${labels.currentLabel}.${notFiredOnReference.length ? ` (${notFiredOnReference.length} expected event(s) did not fire on ${labels.referenceLabel} either — pre-existing, not reported as a regression.)` : ''}`,
        base
      );
    }
  }

  // A5 — payload shape preserved (key sets, not values), for events present on both sides
  const shapeMismatches = [];
  for (const [eventName, referenceKeys] of Object.entries(reference.events)) {
    if (!(eventName in current.events)) continue;
    const currentKeys = current.events[eventName];
    const missing = referenceKeys.filter((k) => !currentKeys.includes(k));
    if (missing.length > 0) shapeMismatches.push({ event: eventName, missingKeys: missing, ...ev(referenceKeys, currentKeys) });
  }
  if (shapeMismatches.length === 0) {
    c.pass('A5', 'Event payload shape preserved', 'P1', `Payload key sets match for every event present on both ${labels.referenceLabel} and ${labels.currentLabel}.`);
  } else {
    c.fail('A5', 'Event payload shape preserved', 'P1', `${shapeMismatches.length} event(s) dropped payload keys on ${labels.currentLabel}.`, { shapeMismatches }, 'A dropped key (e.g. value, currency, item_id) silently breaks downstream reporting/attribution for that event.');
  }

  // A6 — network beacons reach GA/Meta endpoints. P1 only, per §6 — never P0.
  // Same pre-existing-vs-new principle as A4: only a regression (reference had beacon traffic,
  // current doesn't) gates. "Was this expected" is derived from whether reference.scripts itself
  // was present (A1-A3's own diff-based finding), not a separate config flag.
  const gaPreExistingGap = reference.scripts.ga4 && reference.gaBeaconHits === 0;
  const metaPreExistingGap = reference.scripts.metaPixel && reference.metaBeaconHits === 0;
  const gaRegressed = reference.scripts.ga4 && !gaPreExistingGap && current.gaBeaconHits === 0;
  const metaRegressed = reference.scripts.metaPixel && !metaPreExistingGap && current.metaBeaconHits === 0;
  const beaconEvidence = { gaHits: current.gaBeaconHits, metaHits: current.metaBeaconHits, referenceGaHits: reference.gaBeaconHits, referenceMetaHits: reference.metaBeaconHits };

  if (!gaRegressed && !metaRegressed) {
    const gapNames = [gaPreExistingGap && 'GA', metaPreExistingGap && 'Meta'].filter(Boolean).join(' and ');
    const preExistingNote = gapNames ? ` (${gapNames} beacon traffic wasn't observed on ${labels.referenceLabel} either — pre-existing, not reported as a regression.)` : '';
    c.pass('A6', 'Network beacons reach GA/Meta endpoints', 'P1', `No new beacon-traffic regression on ${labels.currentLabel}.${preExistingNote}`, beaconEvidence);
  } else {
    const regressedNames = [gaRegressed && 'GA', metaRegressed && 'Meta'].filter(Boolean).join(' and ');
    c.fail(
      'A6',
      'Network beacons reach GA/Meta endpoints',
      'P1',
      `${regressedNames} beacon traffic reached ${labels.referenceLabel} but not ${labels.currentLabel}.`,
      beaconEvidence,
      'Preview themes are not a reliable analytics environment (consent gating, app behavior differs from published themes) — this is a P1 signal to double-check, not a release blocker on its own.'
    );
  }

  // A7 — cookie consent banner renders on first load. Only a regression (present on reference,
  // missing on current) gates. Absent on both sides is a pre-existing compliance gap.
  if (current.consentBannerVisible || !reference.consentBannerVisible) {
    const preExistingNote = !current.consentBannerVisible && !reference.consentBannerVisible ? ` No consent banner was detected on ${labels.referenceLabel} either — pre-existing, not reported as a regression (still worth flagging separately as a compliance gap).` : '';
    c.pass('A7', 'Cookie consent banner renders on first load', 'P1', `No new consent-banner regression on ${labels.currentLabel}.${preExistingNote}`, ev(reference.consentBannerVisible, current.consentBannerVisible));
  } else {
    c.fail(
      'A7',
      'Cookie consent banner renders on first load',
      'P1',
      `A cookie/consent element was visible on ${labels.referenceLabel} but not on ${labels.currentLabel}'s first paint (heuristic text match — verify manually).`,
      ev(true, false),
      "Missing consent UI is a compliance risk (GDPR/CCPA) depending on the client's markets."
    );
  }

  if (reference.notes?.length || current.notes?.length) {
    c.info('A-NOTES', 'Journey notes', 'Non-fatal issues encountered while running the journey — treat findings above with extra scrutiny if a relevant step was skipped.', { [labels.referenceKey]: reference.notes, [labels.currentKey]: current.notes });
  }
}

async function main() {
  const args = parseArgs();
  const checks = new Checks();
  const startedAt = new Date().toISOString();
  const config = loadConfig(args.root, args.config);
  const singleUrlGiven = args.mode !== 'pre-merge' ? args.liveUrl : args.liveUrl && args.previewUrl;
  const emit = (mode, context) => console.log(JSON.stringify({ checker: 'analytics', mode, startedAt, context, checks: checks.checks, summary: checks.summary() }, null, 2));

  if (!config && !singleUrlGiven) {
    checks.skip('A-CONFIG', 'Config resolution', 'P0', 'No preflight.config.json found and no --live-url (/--preview-url) given.');
    emit(args.mode, {});
    process.exitCode = 0; return;
  }

  const analyticsConfig = config?.analytics || {};
  const selectors = analyticsConfig.selectors || {};
  const password = process.env.PREFLIGHT_STOREFRONT_PASSWORD || null;
  const storeOrigin = config?.store ? `https://${String(config.store).replace(/^https?:\/\//, '').replace(/\/$/, '')}` : null;
  const previewThemeId = config?.themes?.preview?.themeId || null;
  const artifactsDir = args.artifactsDir || path.join(args.root, '.buildspace', 'preflight', 'artifacts', 'analytics');
  const journeys = resolveJourneys(config, args);
  const live = resolveSide(args.liveUrl, storeOrigin);

  if (!live) {
    checks.skip('A-URL', 'URL resolution', 'P0', 'Could not resolve a live URL from config or --live-url.');
    emit(args.mode, {});
    process.exitCode = 0; return;
  }

  const playwright = resolvePlaywright();
  if (!playwright) {
    checks.skip('A-DEPS', 'Playwright availability', 'P0', 'Playwright could not be installed or resolved.');
    emit(args.mode, { liveBase: live.origin });
    process.exitCode = 0; return;
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const journeyContext = (j) => ({ name: j.name, steps: `home → ${j.collection || '(no collection)'} → ${j.product || '(no product)'} → add to cart → cart → checkout boundary`, productView: j.productView, productPreviewView: j.productPreviewView });
  const opts = (sideLabel) => ({ password, selectors, artifactsDir, sideLabel });

  try {
    /* ── baseline mode: run the first journey on live only, snapshot it ─── */
    if (args.mode === 'baseline') {
      const journey = journeys[0];
      let liveResult;
      try {
        liveResult = await runJourney(browser, live, journey, opts('live'));
      } catch (err) {
        checks.skip('A-JOURNEY', 'Scripted journey', 'P0', `Journey failed to complete on live: ${err.message}`);
        emit('baseline', { liveBase: live.origin });
        process.exitCode = 0; return;
      }
      const snapshot = { ...normalizeResult(liveResult), journey: journey.name, generatedAt: new Date().toISOString() };
      checks.info('A-BASELINE', 'Analytics baseline captured', `Captured GTM=${snapshot.scripts.gtm}, GA4=${snapshot.scripts.ga4}, MetaPixel=${snapshot.scripts.metaPixel}, ${Object.keys(snapshot.events).length} event(s), steps ${snapshot.steps.map((s) => `${s.step}:${s.status}`).join(' ')}.`, snapshot);
      console.log(JSON.stringify({ checker: 'analytics', mode: 'baseline', startedAt, context: { liveBase: live.origin, journey: journeyContext(journey) }, checks: checks.checks, summary: checks.summary(), snapshot }, null, 2));
      process.exitCode = 0; return;
    }

    /* ── post-merge mode: re-run the baselined journey on live, diff vs baseline ── */
    if (args.mode === 'post-merge') {
      let baseline = null;
      if (args.baselineFile && existsSync(args.baselineFile)) {
        try {
          baseline = JSON.parse(readFileSync(args.baselineFile, 'utf-8')).analytics?.snapshot || null;
        } catch {}
      }
      if (!baseline) {
        checks.skip('A-BASELINE', 'Baseline availability', 'P0', 'No analytics baseline found — run `/preflight --mode baseline` after a known-good release before using post-merge mode.');
        emit('post-merge', { liveBase: live.origin });
        process.exitCode = 0; return;
      }
      const journey = journeys.find((j) => j.name === baseline.journey) || journeys[0];
      let liveResultNow;
      try {
        liveResultNow = await runJourney(browser, live, journey, opts('live'));
      } catch (err) {
        checks.skip('A-JOURNEY', 'Scripted journey', 'P0', `Journey failed to complete on live: ${err.message}`);
        emit('post-merge', { liveBase: live.origin });
        process.exitCode = 0; return;
      }
      evaluateAnalytics(checks, analyticsConfig, baseline, normalizeResult(liveResultNow), { referenceLabel: 'baseline', currentLabel: 'live now', referenceKey: 'baseline', currentKey: 'liveNow' });
      emit('post-merge', { liveBase: live.origin, journey: journeyContext(journey), baselineGeneratedAt: baseline.generatedAt });
      process.exitCode = checks.summary().p0Fail > 0 ? 1 : 0; return;
    }

    /* ── pre-merge (default): live vs preview, the branch axis, every journey ── */
    const previewParams = { ...(config?.themes?.preview?.params || {}), ...(previewThemeId ? { preview_theme_id: String(previewThemeId) } : {}) };
    // Explicit --preview-url params win; config params (e.g. pb=0 to hide the preview bar) fill the gaps.
    const preview = resolveSide(args.previewUrl, storeOrigin, args.previewUrl ? { ...(config?.themes?.preview?.params || {}) } : previewParams);
    if (!preview || (!preview.params.preview_theme_id && !args.previewUrl)) {
      checks.skip('A-URL', 'URL resolution', 'P0', 'Could not resolve a preview URL — pass --preview-url or set config.themes.preview.themeId.');
      emit('pre-merge', { liveBase: live.origin });
      process.exitCode = 0; return;
    }

    const journeyResults = [];
    for (const journey of journeys) {
      const suffix = journeys.length > 1 ? `-${journey.name}` : '';
      let liveResult, previewResult;
      try {
        liveResult = normalizeResult(await runJourney(browser, live, journey, opts('live')));
        previewResult = normalizeResult(await runJourney(browser, preview, journey, opts('preview')));
      } catch (err) {
        checks.skip(`A-JOURNEY${suffix}`, `Scripted journey${suffix ? ` [${journey.name}]` : ''}`, 'P0', `Journey "${journey.name}" failed to complete on one or both sides: ${err.message}`);
        continue;
      }
      evaluateAnalytics(checks, analyticsConfig, liveResult, previewResult, { referenceLabel: 'live', currentLabel: 'preview', referenceKey: 'live', currentKey: 'preview' }, suffix, journeys.length > 1 ? journey.name : null);
      // A-THEME — prove each side's navigations rendered the theme they were meant to.
      const themesOf = (res) => [...new Set((res.steps || []).filter((x) => x.theme).map((x) => x.theme))];
      const lt = themesOf(liveResult);
      const pt = themesOf(previewResult);
      const expectedPreview = previewThemeId ? String(previewThemeId) : preview.params.preview_theme_id || null;
      const themeProblems = [
        lt.length !== 1 && `live steps rendered ${lt.join(', ') || 'no identifiable theme'}`,
        pt.length !== 1 && `preview steps rendered ${pt.join(', ') || 'no identifiable theme'}`,
        expectedPreview && pt.length === 1 && pt[0] !== expectedPreview && `preview steps rendered ${pt[0]}, expected ${expectedPreview}`,
        lt.length === 1 && pt.length === 1 && lt[0] === pt[0] && 'live and preview rendered the same theme',
      ].filter(Boolean);
      checks.push(`A-THEME${suffix}`, `Journey ran on the intended themes${suffix ? ` [${journey.name}]` : ''}`, 'P0', themeProblems.length ? 'SKIPPED' : 'PASS', themeProblems.length ? `Results above can't be trusted: ${themeProblems.join('; ')}.` : `Every live step rendered theme ${lt[0]}; every preview step rendered theme ${pt[0]} (server-timing).`, { live: lt, preview: pt }, '');
      journeyResults.push({ ...journeyContext(journey), live: liveResult.steps, preview: previewResult.steps });
    }

    emit('pre-merge', { liveBase: live.origin, previewBase: preview.origin, previewParams: preview.params, journeys: journeyResults, artifactsDir });
    process.exitCode = checks.summary().p0Fail > 0 ? 1 : 0; return;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Only auto-run when executed directly — the regression tests import the pure helpers above.
// Realpath both sides: this script is normally reached through a symlinked skill directory.
function isRunDirectly() {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch((err) => {
    console.log(
      JSON.stringify({
        checker: 'analytics',
        startedAt: new Date().toISOString(),
        context: {},
        checks: [],
        summary: { pass: 0, fail: 0, skipped: 1, p0Fail: 0, p1Fail: 0 },
        error: `Unhandled error: ${err.stack || err.message}`,
      })
    );
    process.exitCode = 1; return;
  });
}
