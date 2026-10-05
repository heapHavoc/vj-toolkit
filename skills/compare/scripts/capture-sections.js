#!/usr/bin/env node
/**
 * capture-sections.js
 *
 * Usage:
 *   node capture-sections.js \
 *     --url "<preview-url>" --feature "<feature-name>" \
 *     --selectors "<path-to-selectors.json>" [--password "<storefront-password>"]
 *
 * Selectors file format:
 *   [{ "name": "hero", "selector": ".hero-banner" }]
 *
 * Output (.buildspace/artifacts/{feature}/screenshots/):
 *   code-{name}-desktop.png, code-{name}-mobile.png
 *   diff-{name}-{viewport}.png  (only when a Figma reference exists)
 *   capture-manifest.json
 *
 * Each captured section is compared against its figma-{name}-{viewport}.png
 * reference in two tiers: dimensions (exact, no dependency) and then a pixel
 * diff via pixelmatch. The manifest records a verdict per section so the
 * caller only needs to look at images for sections marked REVIEW.
 */

'use strict';

const { execSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { mkdir, open, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

/* ── Timeouts ─────────────────────────────────────────────────────────── */
const PER_IMAGE_TIMEOUT = 5000;   // max wait for a single image to load
const ALL_IMAGES_TIMEOUT = 15000; // max wait for all images in a section
const SECTION_TIMEOUT = 30000;    // max time to capture one section+viewport

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

/* ── Comparison thresholds ────────────────────────────────────────────── */
// Figma exports at 2x (see skills/figma/SKILL.md step 4c); we capture at 2x to match.
const DEVICE_SCALE = 2;
// Tier 1: a dimension is a match if within whichever of these is larger.
const DIM_TOLERANCE_PX = 4;
const DIM_TOLERANCE_PCT = 2;
// Tier 2: browser and Figma rasterise text differently, so a correct section
// never scores zero. This default is a starting point — calibrate it against
// sections already known good and pass --diff-threshold.
const DEFAULT_DIFF_THRESHOLD_PCT = 5;

const NAV_OPTIONS = { waitUntil: 'domcontentloaded', timeout: 60000 };

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };

  const url = get('--url');
  const feature = get('--feature');
  const selectorsFile = get('--selectors');
  const password = get('--password');
  const diffThreshold = Number(get('--diff-threshold') ?? DEFAULT_DIFF_THRESHOLD_PCT);

  if (!url || !feature || !selectorsFile) {
    console.error(
      'Usage: capture-sections.js --url <url> --feature <name> --selectors <file> [--password <pass>]\n' +
      '  --url        (required) Shopify preview URL\n' +
      '  --feature    (required) Feature name\n' +
      '  --selectors  (required) Path to selectors.json\n' +
      '  --password   (optional) Storefront password\n' +
      '  --diff-threshold (optional) Max pixel-diff %% before a section needs review ' +
      `(default ${DEFAULT_DIFF_THRESHOLD_PCT})`
    );
    process.exit(1);
  }

  return { url, feature, selectorsFile, password, diffThreshold };
}

/**
 * Resolve Playwright from multiple locations before falling back to install.
 * Search order: script's own node_modules → caller's cwd → NODE_PATH entries.
 */
function resolvePlaywright() {
  // 1. Standard resolution (script's own node_modules)
  try {
    return require('playwright');
  } catch {}

  // 2. Caller's working directory (covers `NODE_PATH=$(pwd)/node_modules` cases)
  try {
    const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
    return cwdRequire('playwright');
  } catch {}

  // 3. Explicit NODE_PATH directories
  if (process.env.NODE_PATH) {
    for (const dir of process.env.NODE_PATH.split(path.delimiter)) {
      try {
        const npRequire = createRequire(path.join(dir, 'package.json'));
        return npRequire('playwright');
      } catch {}
    }
  }

  // 4. Last resort — install into script's own directory
  console.error('[capture] Playwright not found in any resolution path — installing...');
  const scriptDir = __dirname;
  execSync(`npm install --prefix "${scriptDir}" playwright`, { stdio: 'inherit' });
  // Use the locally installed playwright binary (not npx from CWD)
  const pwBin = path.join(scriptDir, 'node_modules', '.bin', 'playwright');
  execSync(`"${pwBin}" install chromium`, { stdio: 'inherit' });
  console.error('[capture] Playwright installed');
  // Use createRequire to resolve from scriptDir explicitly
  const localRequire = createRequire(path.join(scriptDir, 'package.json'));
  return localRequire('playwright');
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
    // No password page
  }
}

/**
 * Wait for images to load within a scoped container.
 *
 * - Skips already-loaded images.
 * - Skips lazy images that are still off-screen (they haven't started loading
 *   and won't until scrolled into view — waiting for them hangs forever).
 * - Each individual image gets a per-image timeout so one slow CDN doesn't stall everything.
 * - The entire wait has an overall timeout as a safety net.
 */
async function waitForImages(page, { selector = null, timeout = ALL_IMAGES_TIMEOUT } = {}) {
  try {
    await Promise.race([
      page.evaluate(({ scope, imgTimeout }) => {
        const root = scope ? document.querySelector(scope) : document;
        if (!root) return;

        const images = Array.from(root.querySelectorAll('img'));
        const pending = images.filter((img) => {
          // Already loaded successfully
          if (img.complete && img.naturalWidth > 0) return false;
          // Already failed (broken src etc.)
          if (img.complete) return false;
          // Lazy image that is still off-screen — hasn't started loading
          if (img.loading === 'lazy') {
            const rect = img.getBoundingClientRect();
            const inViewport = rect.top < window.innerHeight && rect.bottom > 0;
            if (!inViewport) return false;
          }
          return true;
        });

        if (pending.length === 0) return;

        return Promise.all(
          pending.map((img) =>
            Promise.race([
              new Promise((r) => { img.onload = r; img.onerror = r; }),
              new Promise((r) => setTimeout(r, imgTimeout)),
            ])
          )
        );
      }, { scope: selector, imgTimeout: PER_IMAGE_TIMEOUT }),
      // Overall timeout — if evaluate itself hangs, we move on
      new Promise((resolve) => setTimeout(resolve, timeout)),
    ]);
  } catch {
    // page.evaluate can throw if the page/context is closed — safe to continue
  }
}

async function waitForAnimations(page) {
  await page.evaluate(() =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

/* ── Comparison against the Figma reference ───────────────────────────── */

/** Read width/height straight from the PNG IHDR chunk. No dependency needed. */
async function pngSize(filepath) {
  let fd;
  try {
    fd = await open(filepath, 'r');
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fd.read(buf, 0, 24, 0);
    if (bytesRead < 24) return null;
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/**
 * Resolve an optional module from the usual places, installing into the
 * script's own directory as a last resort. Returns null if unavailable —
 * tier 2 is a bonus, never a hard requirement.
 */
let optionalInstallAttempted = false;
function resolveOptional(names) {
  const tryLoad = (name) => {
    try { return require(name); } catch {}
    try { return createRequire(path.join(process.cwd(), 'package.json'))(name); } catch {}
    try { return createRequire(path.join(__dirname, 'package.json'))(name); } catch {}
    return null;
  };

  let mods = names.map(tryLoad);
  if (mods.every(Boolean)) return mods;

  if (!optionalInstallAttempted) {
    optionalInstallAttempted = true;
    try {
      console.error(`[capture] Installing pixel-diff deps (${names.join(', ')})...`);
      execSync(`npm install --prefix "${__dirname}" --no-save ${names.join(' ')}`, { stdio: 'inherit' });
    } catch {
      console.error('[capture] Could not install pixel-diff deps — dimension check only');
    }
    mods = names.map(tryLoad);
  }
  return mods.every(Boolean) ? mods : null;
}

function dimensionVerdict(code, figma) {
  const within = (a, b) => {
    const delta = Math.abs(a - b);
    return delta <= Math.max(DIM_TOLERANCE_PX, (b * DIM_TOLERANCE_PCT) / 100);
  };
  return within(code.w, figma.w) && within(code.h, figma.h) ? 'MATCH' : 'DIFFERS';
}

/**
 * Two-tier comparison against the Figma reference for this section+viewport.
 * Tier 1 (dimensions) is exact and free. Tier 2 (pixel diff) only runs when
 * dimensions already agree — comparing differently-sized images is meaningless.
 */
async function compareToFigma(name, vpName, outputDir, diffThreshold) {
  const codePath = path.join(outputDir, `code-${name}-${vpName}.png`);
  const figmaPath = path.join(outputDir, `figma-${name}-${vpName}.png`);

  const [codeSize, figmaSize] = await Promise.all([pngSize(codePath), pngSize(figmaPath)]);
  if (!codeSize) return { verdict: 'NO_CODE_IMAGE' };
  if (!figmaSize) return { verdict: 'NO_FIGMA_REFERENCE', codeSize };

  const dimVerdict = dimensionVerdict(codeSize, figmaSize);
  const out = {
    codeSize,
    figmaSize,
    dimensionDelta: { w: codeSize.w - figmaSize.w, h: codeSize.h - figmaSize.h },
    dimensionVerdict: dimVerdict,
  };

  if (dimVerdict !== 'MATCH') {
    out.verdict = 'REVIEW';
    out.reason = `dimensions differ: code ${codeSize.w}x${codeSize.h} vs figma ${figmaSize.w}x${figmaSize.h}`;
    return out;
  }

  const mods = resolveOptional(['pixelmatch', 'pngjs']);
  if (!mods) {
    out.verdict = 'DIMENSIONS_ONLY';
    out.reason = 'pixelmatch/pngjs unavailable — tier 2 skipped';
    return out;
  }

  const [pixelmatchMod, pngjs] = mods;
  const pixelmatch = pixelmatchMod.default || pixelmatchMod;
  const { PNG } = pngjs;

  try {
    const [codeBuf, figmaBuf] = await Promise.all([readFile(codePath), readFile(figmaPath)]);
    const codeImg = PNG.sync.read(codeBuf);
    const figmaImg = PNG.sync.read(figmaBuf);
    const { width, height } = codeImg;
    const diffImg = new PNG({ width, height });

    const changed = pixelmatch(
      codeImg.data, figmaImg.data, diffImg.data, width, height,
      { threshold: 0.15, includeAA: false }
    );

    const pct = Number(((changed / (width * height)) * 100).toFixed(2));
    const diffName = `diff-${name}-${vpName}.png`;
    await writeFile(path.join(outputDir, diffName), PNG.sync.write(diffImg));

    out.pixelDiffPct = pct;
    out.diffImage = diffName;
    out.verdict = pct <= diffThreshold ? 'PASS' : 'REVIEW';
    if (out.verdict === 'REVIEW') out.reason = `pixel diff ${pct}% exceeds ${diffThreshold}%`;
  } catch (err) {
    out.verdict = 'DIMENSIONS_ONLY';
    out.reason = `pixel diff failed: ${err.message}`;
  }

  return out;
}

async function captureSectionInner(page, section, viewport, outputDir) {
  const { name, selector } = section;
  const { name: vpName, width, height } = viewport;

  await page.setViewportSize({ width, height });
  await waitForAnimations(page);

  const locator = page.locator(selector).first();

  const count = await locator.count();
  if (count === 0) {
    return {
      section: name,
      viewport: vpName,
      status: 'NOT_FOUND',
      error: `Selector "${selector}" not found on page`,
    };
  }

  const visible = await locator.isVisible();
  if (!visible) {
    return {
      section: name,
      viewport: vpName,
      status: 'NOT_VISIBLE',
      error: `Selector "${selector}" exists but is not visible`,
    };
  }

  // Scroll into view — this triggers lazy-loaded images within the section
  await locator.scrollIntoViewIfNeeded();
  await waitForAnimations(page);

  // Wait for images scoped to this section only (not the entire page)
  await waitForImages(page, { selector });

  const filename = `code-${name}-${vpName}.png`;
  const filepath = path.join(outputDir, filename);

  await locator.screenshot({
    path: filepath,
    animations: 'disabled',
  });

  return {
    section: name,
    viewport: vpName,
    status: 'CAPTURED',
    filename,
    path: path.relative('.', filepath),
  };
}

/**
 * Capture a single section with a timeout guard.
 * If the section hangs (e.g. an image wait that slips through), we return
 * a TIMEOUT status instead of blocking the entire run.
 */
async function captureSection(page, section, viewport, outputDir) {
  try {
    return await Promise.race([
      captureSectionInner(page, section, viewport, outputDir),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${SECTION_TIMEOUT / 1000}s`)),
          SECTION_TIMEOUT
        )
      ),
    ]);
  } catch (err) {
    return {
      section: section.name,
      viewport: viewport.name,
      status: 'TIMEOUT',
      error: err.message,
    };
  }
}

async function main() {
  const { url, feature, selectorsFile, password, diffThreshold } = parseArgs();

  let selectors;
  try {
    const raw = await readFile(selectorsFile, 'utf-8');
    selectors = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not read selectors file: ${err.message}`);
  }

  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new Error('Selectors file is empty or not an array');
  }

  for (const s of selectors) {
    if (!s.name || !s.selector) {
      throw new Error(`Invalid selector entry: ${JSON.stringify(s)} — needs "name" and "selector"`);
    }
  }

  const playwright = resolvePlaywright();

  const outputDir = path.resolve(`.buildspace/artifacts/${feature}/screenshots`);
  await mkdir(outputDir, { recursive: true });

  console.error(`[capture] URL: ${url}`);
  console.error(`[capture] Feature: ${feature}`);
  console.error(`[capture] Sections: ${selectors.map((s) => s.name).join(', ')}`);
  console.error(`[capture] Viewports: ${VIEWPORTS.map((v) => `${v.name} (${v.width}px)`).join(', ')}`);

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `Failed to launch Chromium: ${err.message}\nRun: npx playwright install chromium`
    );
  }

  const results = [];

  try {
    for (const viewport of VIEWPORTS) {
      // A fresh context and a real navigation per viewport. Resizing is not the
      // same as loading — a script that measured on load at 1440px is stale at 390px.
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: DEVICE_SCALE,
      });
      const page = await context.newPage();

      try {
        await page.goto(url, NAV_OPTIONS);
        await handlePassword(page, password);

        // Let the page settle. Per-section image waits happen inside
        // captureSection after scrolling each section into view.
        await waitForAnimations(page);

        for (const section of selectors) {
          console.error(`[capture] ${viewport.name}/${section.name}...`);
          const result = await captureSection(page, section, viewport, outputDir);

          if (result.status === 'CAPTURED') {
            result.compare = await compareToFigma(
              section.name, viewport.name, outputDir, diffThreshold
            );
            const pct = result.compare.pixelDiffPct;
            const detail = pct === undefined ? '' : ` (${pct}% diff)`;
            console.error(`[capture]   saved: ${result.filename} — ${result.compare.verdict}${detail}`);
          } else {
            console.error(`[capture]   ${result.status}: ${result.error}`);
          }

          results.push(result);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const manifest = {
    feature,
    url,
    timestamp: new Date().toISOString(),
    viewports: VIEWPORTS,
    deviceScaleFactor: DEVICE_SCALE,
    diffThreshold,
    selectors,
    results,
  };

  await writeFile(
    path.join(outputDir, 'capture-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  const captured = results.filter((r) => r.status === 'CAPTURED').length;
  const notFound = results.filter((r) => r.status === 'NOT_FOUND').length;
  const notVisible = results.filter((r) => r.status === 'NOT_VISIBLE').length;
  const timedOut = results.filter((r) => r.status === 'TIMEOUT').length;

  const needsReview = results.filter((r) => r.compare && r.compare.verdict === 'REVIEW');

  console.error(
    `[capture] Done: ${captured} captured, ${notFound} not found, ${notVisible} not visible` +
    (timedOut > 0 ? `, ${timedOut} timed out` : '')
  );
  if (needsReview.length > 0) {
    console.error(`[capture] Needs review (${needsReview.length}):`);
    for (const r of needsReview) {
      console.error(`[capture]   ${r.viewport}/${r.section} — ${r.compare.reason}`);
    }
  } else if (captured > 0) {
    console.error('[capture] All captured sections within threshold — no image review needed');
  }
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(`[capture] Fatal: ${err.message}`);
  process.exit(1);
});
