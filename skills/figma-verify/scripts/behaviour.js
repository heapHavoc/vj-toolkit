#!/usr/bin/env node
/**
 * behaviour.js — Run interaction tests in a real browser
 *
 * Tests live in .buildspace/artifacts/{feature}/verify/tests.json (written
 * from sections.json behaviour + clarify.md). Each test runs in a fresh page
 * with animations live.
 *
 * Test shape:
 * {
 *   "name": "FAQ item opens on click",
 *   "section": "faq",                       // for reporting
 *   "viewport": "mobile",                   // "desktop" | "mobile" (Figma widths) | number
 *   "route": "/products/x",                 // optional, overrides --route
 *   "steps": [
 *     { "do": "snapshot", "selector": ".faq__item:nth-child(2)", "as": "closed" },
 *     { "do": "click", "selector": ".faq__item:nth-child(2) summary" },
 *     { "do": "wait", "ms": 400 }
 *   ],
 *   "expect": [
 *     { "attr": ".faq__item:nth-child(2) details", "name": "open", "equals": "" },
 *     { "visible": ".faq__item:nth-child(2) .faq__answer" },
 *     { "changed": ".faq__item:nth-child(2)", "prop": "height", "from": "closed" }
 *   ],
 *   "screenshot": ".faq"                    // optional: capture the resulting state
 * }
 *
 * Steps: click, hover, focus, press {key}, fill {value}, scroll {y|selector},
 *        swipe {dx, dy}, wait {ms}, snapshot {as}
 * Expect: visible, hidden, count {equals|min}, attr {name, equals|notEquals|exists},
 *         style {prop, equals|notEquals}, text {contains|equals},
 *         changed {prop, from}  — prop: x|y|width|height|transform|scrollLeft|scrollTop|<css property>
 *         unchanged {prop, from},
 *         stuck {scrollBy, tolerance}  — viewport position stays (sticky/fixed),
 *         moving {durationMs}           — keeps moving on its own (marquee/autoplay)
 *
 * Usage:
 *   node behaviour.js --feature <name> --url <dev-server> [--route /path]
 *     [--round 1] [--tests path] [--only "name substring"] [--password pw]
 *
 * Output: verify/round-{n}/behaviour.json, behaviour-{n}.png (state screenshots)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseFlags, requireFlags, loadFeature, roundDir, readJson, launch, openPage, resolveViewport,
} = require('./lib/pw');

const USAGE = 'behaviour.js --feature <name> --url <dev-server> [--route /path] [--round 1] [--tests file] [--only text] [--password pw]';

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

const pick = (props, prop) => (props ? (prop in props ? props[prop] : props.css?.[prop]) : undefined);

async function runStep(page, step, snapshots) {
  const loc = step.selector ? page.locator(step.selector).first() : null;
  switch (step.do) {
    case 'click': await loc.scrollIntoViewIfNeeded(); await loc.click({ timeout: 5000 }); break;
    case 'hover': await loc.scrollIntoViewIfNeeded(); await loc.hover({ timeout: 5000 }); break;
    case 'focus': await loc.focus(); break;
    case 'press': await (loc ? loc.press(step.key) : page.keyboard.press(step.key)); break;
    case 'fill': await loc.fill(String(step.value ?? '')); break;
    case 'wait': await page.waitForTimeout(step.ms ?? 300); break;
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

async function check(page, exp, snapshots) {
  const fail = (msg) => ({ ok: false, expect: exp, message: msg });
  const pass = (msg) => ({ ok: true, expect: exp, message: msg });

  if (exp.visible) return (await page.locator(exp.visible).first().isVisible()) ? pass('visible') : fail('not visible');
  if (exp.hidden) {
    const loc = page.locator(exp.hidden).first();
    return !(await loc.count()) || !(await loc.isVisible()) ? pass('hidden') : fail('visible');
  }
  if (exp.count) {
    const n = await page.locator(exp.count).count();
    if (exp.equals != null) return n === exp.equals ? pass(`count ${n}`) : fail(`count ${n}, expected ${exp.equals}`);
    return n >= (exp.min ?? 1) ? pass(`count ${n}`) : fail(`count ${n}, expected ≥ ${exp.min ?? 1}`);
  }
  if (exp.attr) {
    const v = await page.locator(exp.attr).first().getAttribute(exp.name);
    if (exp.exists === false) return v === null ? pass('absent') : fail(`present (${v})`);
    if (exp.exists) return v !== null ? pass(`present (${v})`) : fail('absent');
    if ('notEquals' in exp) return v !== exp.notEquals ? pass(`= ${v}`) : fail(`= ${v}`);
    return v === exp.equals ? pass(`= ${v}`) : fail(`= ${v}, expected ${exp.equals}`);
  }
  if (exp.style) {
    const v = await page.locator(exp.style).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), exp.prop);
    if ('notEquals' in exp) return v !== exp.notEquals ? pass(`${exp.prop}: ${v}`) : fail(`${exp.prop}: ${v}`);
    return v === exp.equals ? pass(`${exp.prop}: ${v}`) : fail(`${exp.prop}: ${v}, expected ${exp.equals}`);
  }
  if (exp.text) {
    const t = (await page.locator(exp.text).first().innerText()).trim();
    if (exp.contains) return t.includes(exp.contains) ? pass('contains') : fail(`"${t.slice(0, 80)}"`);
    return t === exp.equals ? pass('equals') : fail(`"${t.slice(0, 80)}"`);
  }
  if (exp.changed || exp.unchanged) {
    const sel = exp.changed ?? exp.unchanged;
    const before = snapshots[exp.from ?? 'before'];
    if (!before) return fail(`no snapshot "${exp.from ?? 'before'}"`);
    const after = await readProps(page, sel);
    const a = pick(before, exp.prop);
    const b = pick(after, exp.prop);
    const same = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1 : a === b;
    const msg = `${exp.prop}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`;
    return (exp.changed ? !same : same) ? pass(msg) : fail(msg);
  }
  if (exp.stuck) {
    const loc = page.locator(exp.stuck).first();
    await loc.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const top1 = (await loc.boundingBox())?.y;
    await page.mouse.wheel(0, exp.scrollBy ?? 600);
    await page.waitForTimeout(400);
    const top2 = (await loc.boundingBox())?.y;
    const tol = exp.tolerance ?? 2;
    const msg = `top ${Math.round(top1)} → ${Math.round(top2)} after scrolling ${exp.scrollBy ?? 600}px`;
    return top1 != null && top2 != null && Math.abs(top1 - top2) <= tol ? pass(msg) : fail(msg);
  }
  if (exp.moving) {
    const loc = page.locator(exp.moving).first();
    await loc.scrollIntoViewIfNeeded();
    const read = () => loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)}|${Math.round(r.top)}|${getComputedStyle(el).transform}|${el.scrollLeft}`;
    });
    const a = await read();
    await page.waitForTimeout(exp.durationMs ?? 1500);
    const b = await read();
    return a !== b ? pass(`moved (${a} → ${b})`) : fail(`did not move in ${exp.durationMs ?? 1500}ms`);
  }
  return fail(`unknown expectation ${JSON.stringify(exp)}`);
}

async function main() {
  const flags = parseFlags();
  requireFlags(flags, ['feature', 'url'], USAGE);
  const round = flags.round ?? '1';
  const { dir, viewports } = loadFeature(flags.feature);
  const testsFile = flags.tests ?? path.join(dir, 'verify', 'tests.json');
  if (!fs.existsSync(testsFile)) {
    console.error(`No tests file at ${testsFile}`);
    process.exit(1);
  }
  let tests = readJson(testsFile);
  if (flags.only) tests = tests.filter((t) => t.name.toLowerCase().includes(String(flags.only).toLowerCase()));
  const outDir = roundDir(flags.feature, round);
  const browser = await launch();
  const results = [];

  try {
    for (const [i, test] of tests.entries()) {
      const vp = resolveViewport(test.viewport ?? 'desktop', viewports);
      const { context, page, consoleErrors } = await openPage(browser, {
        url: flags.url, route: test.route ?? flags.route, viewport: vp, password: flags.password, freeze: false,
      });
      const snapshots = {};
      const result = { name: test.name, section: test.section, viewport: vp.name, width: vp.width, checks: [] };
      try {
        for (const step of test.steps ?? []) await runStep(page, step, snapshots);
        for (const exp of test.expect ?? []) result.checks.push(await check(page, exp, snapshots));
        if (test.screenshot) {
          const shot = path.join(outDir, `behaviour-${i + 1}.png`);
          await page.locator(test.screenshot).first().screenshot({ path: shot }).catch(() => {});
          result.screenshot = path.relative(dir, shot);
        }
      } catch (err) {
        result.error = err.message.split('\n')[0];
      }
      result.consoleErrors = [...new Set(consoleErrors)].slice(0, 5);
      result.status = !result.error && result.checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
      results.push(result);
      console.error(`[behaviour] ${result.status} ${test.name}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(outDir, 'behaviour.json'), JSON.stringify(results, null, 2) + '\n');
  const lines = results.map((r) => {
    const failed = r.checks.filter((c) => !c.ok).map((c) => `      ✗ ${JSON.stringify(c.expect)} — ${c.message}`);
    return [`${r.status} [${r.section ?? '-'} @${r.width}px] ${r.name}${r.error ? ` — error: ${r.error}` : ''}${r.screenshot ? ` (${r.screenshot})` : ''}`, ...failed].join('\n');
  });
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(`[behaviour] Fatal: ${err.message}`);
  process.exit(1);
});
