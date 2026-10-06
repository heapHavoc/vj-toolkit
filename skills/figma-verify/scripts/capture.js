#!/usr/bin/env node
/**
 * capture.js — Section screenshots at the Figma frame widths + side-by-side images
 *
 * For every section in sections.json (with a selector in selectors.json) and
 * every Figma viewport (frame widths from figma-dumps/*-index.json), captures
 * the built section at 2x (same scale as the Figma exports) and renders a
 * "Figma | Code" side-by-side image for review.
 *
 * Usage:
 *   node capture.js --feature <name> --url <dev-server> [--route /products/x]
 *     [--round 1] [--sections a,b] [--password <pw>]
 *
 * Output: .buildspace/artifacts/{feature}/verify/round-{n}/
 *   code-{section}-{viewport}.png, compare-{section}-{viewport}.png, capture.json
 *
 * selectors.json entries may add `route` (a page other than --route) and
 * `before` (steps from behaviour.js run first, e.g. open a menu or drawer).
 * Such sections get their own fresh page.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseFlags, requireFlags, loadFeature, roundDir, launch, openPage, waitForImages, hideOverlays, sectionPage,
} = require('./lib/pw');

const USAGE = 'capture.js --feature <name> --url <dev-server> [--route /path] [--round 1] [--sections a,b] [--password pw]';

function dataUri(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

async function sideBySide(browser, { figma, code, out, title, crop }) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  // Figma exports overflowing sections at their render bounds; crop to what the frame shows.
  const cropStyle = crop ? ` style="width:${crop.w}px;height:${crop.h}px;overflow:hidden"` : '';
  const imgStyle = crop ? ` style="margin-left:-${crop.x}px;margin-top:-${crop.y}px"` : '';
  const col = (label, src, isFigma) => (src
    ? `<figure><figcaption>${label}</figcaption><div${isFigma ? cropStyle : ''}><img${isFigma ? imgStyle : ''} src="${src}"></div></figure>`
    : `<figure><figcaption>${label}</figcaption><div class="missing">missing</div></figure>`);
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;padding:16px;background:#d9d9d9;font:600 22px system-ui;display:inline-block}
    h1{font-size:24px;margin:0 0 12px}
    .row{display:flex;gap:24px;align-items:flex-start}
    figure{margin:0;background:#fff;padding:8px}
    figcaption{margin-bottom:8px}
    img{display:block;width:var(--w)}
    .missing{width:400px;height:200px;display:grid;place-items:center;color:#c00}
  </style></head><body><h1>${title}</h1><div class="row">${col('FIGMA', figma && dataUri(figma), true)}${col('CODE', code && dataUri(code), false)}</div></body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; })))));
  // Both screenshots are 2x; show them at CSS size so they line up 1:1.
  await page.evaluate(() => {
    for (const img of document.images) img.style.setProperty('--w', `${img.naturalWidth / 2}px`);
  });
  await page.locator('body').screenshot({ path: out });
  await page.close();
}

async function main() {
  const flags = parseFlags();
  requireFlags(flags, ['feature', 'url'], USAGE);
  const round = flags.round ?? '1';
  const { dir, sections, viewports } = loadFeature(flags.feature, { only: flags.sections });
  const outDir = roundDir(flags.feature, round);
  const browser = await launch();
  const results = [];

  try {
    for (const vp of Object.values(viewports)) {
      const pageOpts = { url: flags.url, route: flags.route, password: flags.password, deviceScaleFactor: 2 };
      const { context, page: sharedPage } = await openPage(browser, { ...pageOpts, viewport: vp });
      for (const section of sections) {
        const figmaRel = section.screenshots?.[vp.name];
        if (!figmaRel) continue;
        const record = { section: section.name, viewport: vp.name, width: vp.width };
        if (!section.selector) {
          results.push({ ...record, status: 'NO_SELECTOR' });
          continue;
        }
        const sp = await sectionPage(browser, sharedPage, section, vp, pageOpts);
        const { page } = sp;
        try {
          if (sp.error) {
            results.push({ ...record, status: 'BEFORE_FAILED', note: sp.error });
            continue;
          }
          const loc = page.locator(section.selector).first();
          if (!(await loc.count())) {
            results.push({ ...record, status: 'NOT_FOUND', selector: section.selector });
            continue;
          }
          if (!(await loc.isVisible())) {
            results.push({ ...record, status: 'NOT_VISIBLE', selector: section.selector });
            continue;
          }
          await loc.scrollIntoViewIfNeeded();
          await waitForImages(page, section.selector);
          const restore = await hideOverlays(page, section.selector);
          const code = path.join(outDir, `code-${section.name}-${vp.name}.png`);
          try {
            await loc.screenshot({ path: code, animations: 'disabled', timeout: 30000 });
        } finally {
          await restore();
        }
        const box = await loc.boundingBox();
        const out = path.join(outDir, `compare-${section.name}-${vp.name}.png`);
        const figma = path.join(dir, figmaRel);
        const specPath = section.dumps?.[vp.name]?.length === 1
          ? path.join(dir, section.dumps[vp.name][0].replace(/\.md$/, '.json'))
          : null;
        const visible = specPath && fs.existsSync(specPath) ? JSON.parse(fs.readFileSync(specPath, 'utf8')).section?.visible : null;
        const render = specPath && fs.existsSync(specPath) ? JSON.parse(fs.readFileSync(specPath, 'utf8')).section?.render : null;
        const crop = visible && render && (visible.w < render.w - 1 || visible.h < render.h - 1) ? visible : null;
        await sideBySide(browser, {
          crop,
          figma: fs.existsSync(figma) ? figma : null,
          code,
          out,
          title: `${section.name} — ${vp.name} ${vp.width}px`,
        });
        results.push({
          ...record,
          status: 'CAPTURED',
          code: path.relative(dir, code),
          compare: path.relative(dir, out),
          codeSize: box ? `${Math.round(box.width)}×${Math.round(box.height)}` : null,
        });
        console.error(`[capture] ${vp.name}/${section.name} ✓`);
        } finally {
          await sp.close();
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(outDir, 'capture.json'), JSON.stringify(results, null, 2) + '\n');
  const bad = results.filter((r) => r.status !== 'CAPTURED');
  console.error(`[capture] ${results.length - bad.length} captured, ${bad.length} problem(s)`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(`[capture] Fatal: ${err.message}`);
  process.exit(1);
});
