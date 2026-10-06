#!/usr/bin/env node
/**
 * sweep.js — Layout health across breakpoints
 *
 * At each width (default: 320 375 390 414 768 820 1024 1280 1440 1920 2560)
 * checks the page and every section for:
 *   - page-level horizontal overflow (document wider than the viewport)
 *   - elements poking outside the viewport that are not inside an
 *     intentionally clipped/scrolling container (sliders are fine)
 *   - text overflowing its own box (clipped/cut text)
 *   - broken images, console errors, failed asset requests
 * Screenshots are saved only for sections with problems.
 *
 * Usage:
 *   node sweep.js --feature <name> --url <dev-server> [--route /path]
 *     [--round 1] [--sections a,b] [--widths 320,768,1440] [--password pw]
 *
 * Output: verify/round-{n}/sweep.json, sweep-{section}-{width}.png (failures only)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseFlags, requireFlags, loadFeature, roundDir, launch, openPage, hideOverlays, sectionPage,
} = require('./lib/pw');

const USAGE = 'sweep.js --feature <name> --url <dev-server> [--route /path] [--round 1] [--sections a,b] [--widths 320,768] [--password pw]';
const DEFAULT_WIDTHS = [320, 375, 390, 414, 768, 820, 1024, 1280, 1440, 1920, 2560];

function inspect({ selector, vw }) {
  const root = document.querySelector(selector);
  if (!root) return null;
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(hidden|auto|scroll|clip)/.test(cs.overflowX) || /(hidden|clip)/.test(cs.overflow)) return true;
    }
    return false;
  };
  const describe = (el) => {
    const cls = String(el.className?.baseVal ?? el.className ?? '').trim().split(/\s+/).slice(0, 2).join('.');
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const issues = [];
  const rr = root.getBoundingClientRect();
  if (rr.width > vw + 1) issues.push({ type: 'section-wider-than-viewport', detail: `${Math.round(rr.width)}px > ${vw}px` });

  let outside = 0;
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) {
      if (outside++ < 8) issues.push({ type: 'outside-viewport', element: describe(el), detail: `left ${Math.round(r.left)} right ${Math.round(r.right)} (viewport ${vw})` });
    }
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const visuallyHidden = r.width <= 1 && r.height <= 1;
    if (own && !visuallyHidden && el.scrollWidth > el.clientWidth + 2 && /(hidden|clip)/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis') {
      issues.push({ type: 'text-cut', element: describe(el), detail: `content ${el.scrollWidth}px in ${el.clientWidth}px box` });
    }
  }
  if (outside > 8) issues.push({ type: 'outside-viewport', detail: `…and ${outside - 8} more` });

  for (const img of root.querySelectorAll('img')) {
    if ((img.getAttribute('src') || img.getAttribute('srcset')) && img.complete && img.naturalWidth === 0 && img.getBoundingClientRect().width > 0) {
      issues.push({ type: 'broken-image', element: (img.currentSrc || img.src || '').slice(0, 120) });
    }
  }
  return { height: Math.round(rr.height), issues };
}

async function main() {
  const flags = parseFlags();
  requireFlags(flags, ['feature', 'url'], USAGE);
  const round = flags.round ?? '1';
  const widths = flags.widths ? String(flags.widths).split(',').map(Number) : DEFAULT_WIDTHS;
  const { dir, sections } = loadFeature(flags.feature, { only: flags.sections });
  const outDir = roundDir(flags.feature, round);
  const browser = await launch();
  const results = [];

  try {
    for (const width of widths) {
      const vp = { name: String(width), width, height: width < 600 ? 844 : 900 };
      const pageOpts = { url: flags.url, route: flags.route, password: flags.password };
      const { context, page: sharedPage, consoleErrors, failedRequests, platformNoise } = await openPage(browser, { ...pageOpts, viewport: vp });
      const pageOverflow = await sharedPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const row = { width, pageOverflow, sections: [] };
      for (const section of sections) {
        if (!section.selector) continue;
        const sp = await sectionPage(browser, sharedPage, section, vp, pageOpts);
        const { page } = sp;
        try {
          if (sp.error) {
            row.sections.push({ section: section.name, status: 'BEFORE_FAILED', issues: [{ type: 'before', detail: sp.error }] });
            continue;
          }
          const data = await page.evaluate(inspect, { selector: section.selector, vw: width });
          if (!data) {
            row.sections.push({ section: section.name, status: 'NOT_FOUND' });
            continue;
          }
          const entry = { section: section.name, status: data.issues.length ? 'FAIL' : 'PASS', issues: data.issues };
          if (data.issues.length) {
            const loc = page.locator(section.selector).first();
            await loc.scrollIntoViewIfNeeded();
            const restore = await hideOverlays(page, section.selector);
            const shot = path.join(outDir, `sweep-${section.name}-${width}.png`);
            await loc.screenshot({ path: shot, animations: 'disabled' }).catch(() => {});
            await restore();
            entry.screenshot = path.relative(dir, shot);
          }
          row.sections.push(entry);
        } finally {
          await sp.close();
        }
      }
      row.consoleErrors = [...new Set(consoleErrors)].slice(0, 10);
      row.failedRequests = [...new Set(failedRequests)].slice(0, 10);
      row.platformNoise = platformNoise.length;
      results.push(row);
      const fails = row.sections.filter((s) => s.status !== 'PASS').length;
      console.error(`[sweep] ${width}px: page overflow ${pageOverflow}px, ${fails} section problem(s), ${row.consoleErrors.length} console error(s)`);
      await context.close();
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(outDir, 'sweep.json'), JSON.stringify(results, null, 2) + '\n');
  const lines = [];
  for (const r of results) {
    const bad = r.sections.filter((s) => s.status !== 'PASS');
    if (!r.pageOverflow && !bad.length && !r.consoleErrors.length && !r.failedRequests.length) {
      lines.push(`${r.width}px: PASS`);
      continue;
    }
    lines.push(`${r.width}px:${r.pageOverflow > 0 ? ` page overflows by ${r.pageOverflow}px;` : ''}`);
    for (const s of bad) {
      lines.push(`  - ${s.section}: ${s.status}${s.screenshot ? ` (${s.screenshot})` : ''}`);
      for (const i of s.issues ?? []) lines.push(`      ${i.type}${i.element ? ` ${i.element}` : ''}${i.detail ? ` — ${i.detail}` : ''}`);
    }
    for (const e of r.consoleErrors) lines.push(`  - console: ${e}`);
    for (const f of r.failedRequests) lines.push(`  - request: ${f}`);
  }
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(`[sweep] Fatal: ${err.message}`);
  process.exit(1);
});
