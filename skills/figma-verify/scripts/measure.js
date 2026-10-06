#!/usr/bin/env node
/**
 * measure.js — Measure the built page against the Figma spec at the frame widths
 *
 * Uses the per-section JSON specs written by figma-rest's extractor
 * (figma-dumps/{viewport}/NN-name.json). At each Figma frame width it reads
 * computed styles and geometry from the browser and compares them with the
 * spec: section size/background, every text (font family, size, weight,
 * line height, letter spacing, colour, case, position) and images
 * (size/aspect, by reading order).
 *
 * Texts are matched by content (case/whitespace-insensitive). Figma texts
 * with no match are reported as UNMATCHED — often dynamic store data
 * (product titles, prices) rather than a defect.
 *
 * Usage:
 *   node measure.js --feature <name> --url <dev-server> [--route /path]
 *     [--round 1] [--sections a,b] [--password pw] [--pos-tol 2]
 *
 * Output: verify/round-{n}/measure.json (+ compact summary on stdout)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  parseFlags, requireFlags, loadFeature, roundDir, readJson, launch, openPage, waitForImages, sectionPage, scrollToNatural,
} = require('./lib/pw');

const USAGE = 'measure.js --feature <name> --url <dev-server> [--route /path] [--round 1] [--sections a,b] [--password pw] [--pos-tol 2]';

const TOL = { fontSize: 0.5, lineHeight: 1, letterSpacing: 0.15, color: 3, alpha: 0.03, size: 1 };

// ── Normalisation ───────────────────────────────────────────────

function norm(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseColor(str) {
  if (!str) return null;
  const hex = str.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean);
  return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
}

function colorDiff(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  const d = Math.max(Math.abs(ca.r - cb.r), Math.abs(ca.g - cb.g), Math.abs(ca.b - cb.b));
  return d > TOL.color || Math.abs(ca.a - cb.a) > TOL.alpha ? d : 0;
}

const r1 = (n) => Math.round(n * 10) / 10;

// ── Browser-side collection ─────────────────────────────────────

function collect(selector) {
  const root = document.querySelector(selector);
  if (!root) return null;
  const box = root.getBoundingClientRect();
  // A child pulled above the section with a negative margin (e.g. media under a transparent header)
  // is where the design's section starts.
  const childTop = Math.min(box.top, ...[...root.children]
    .map((c) => c.getBoundingClientRect()).filter((r) => r.width || r.height).map((r) => r.top));
  const rb = { left: box.left, top: childTop, width: box.width, height: box.bottom - childTop };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const texts = [];
  for (const el of root.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(el.tagName.toUpperCase())) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!own || !visible(el)) continue;
    const cs = getComputedStyle(el);
    // Measure the text itself, not the (often full-width) block box.
    const range = document.createRange();
    range.selectNodeContents(el);
    const tr = range.getBoundingClientRect();
    const r = tr.width ? tr : el.getBoundingClientRect();
    // Figma positions text by its line box; a range reports the glyph area.
    // Recover the first line box top from the first line's centre.
    const first = [...range.getClientRects()].find((c) => c.width > 0) ?? r;
    const lh = cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight);
    const lineTop = lh ? first.top + first.height / 2 - lh / 2 : first.top;
    texts.push({
      text: el.innerText,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 80),
      x: r.left - rb.left,
      y: lineTop - rb.top,
      w: r.width,
      h: r.height,
      fontFamily: cs.fontFamily,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: Number(cs.fontWeight),
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
      textTransform: cs.textTransform,
      textDecoration: cs.textDecorationLine,
      textAlign: cs.textAlign,
      color: cs.color,
    });
  }
  const images = [];
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const isMedia = tag === 'img' || tag === 'video';
    const bg = !isMedia && getComputedStyle(el).backgroundImage;
    if (!isMedia && !(bg && bg !== 'none' && bg.includes('url('))) continue;
    // Visible rect: clip by overflow containers between the image and the section.
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if (/(hidden|auto|scroll|clip)/.test(pcs.overflowX + pcs.overflowY)) {
        const pr = p.getBoundingClientRect();
        left = Math.max(left, pr.left); top = Math.max(top, pr.top);
        right = Math.min(right, pr.right); bottom = Math.min(bottom, pr.bottom);
      }
    }
    const r = { left, top, width: right - left, height: bottom - top };
    if (r.width < 8 || r.height < 8) continue;
    images.push({
      tag,
      x: r.left - rb.left,
      y: r.top - rb.top,
      w: r.width,
      h: r.height,
      broken: tag === 'img' ? Boolean(el.getAttribute('src') || el.getAttribute('srcset')) && el.complete && el.naturalWidth === 0 : false,
      objectFit: getComputedStyle(el).objectFit,
    });
  }
  const cs = getComputedStyle(root);
  return {
    left: rb.left + window.scrollX,
    width: rb.width,
    height: rb.height,
    background: cs.backgroundColor,
    padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat),
    texts,
    images,
  };
}

// ── Matching & comparison ───────────────────────────────────────

/** Width of the Figma section: its spec box, or the widest grouped layer. */
function placedWidth(figma, count) {
  if (count === 1 && figma.section) return figma.section.width;
  return Math.max(0, ...figma.texts.map((t) => t.x + t.w), ...figma.images.map((i) => i.x + i.w));
}

function matchTexts(figmaTexts, domTexts) {
  const used = new Set();
  const pairs = [];
  const domNorm = domTexts.map((d) => norm(d.text));
  const pick = (ft, predicate) => {
    let best = -1;
    let bestDist = Infinity;
    domTexts.forEach((d, i) => {
      if (used.has(i) || !predicate(domNorm[i])) return;
      const dist = Math.hypot(d.x - ft.x, d.y - ft.y);
      if (dist < bestDist) { best = i; bestDist = dist; }
    });
    return best;
  };
  for (const ft of figmaTexts) {
    const target = norm(ft.text);
    if (!target) continue;
    let i = pick(ft, (t) => t === target);
    let how = 'exact';
    if (i < 0 && target.length >= 12) {
      const head = target.slice(0, 40);
      i = pick(ft, (t) => t.startsWith(head) || (t.length >= 12 && target.startsWith(t.slice(0, 40))));
      how = 'prefix';
    }
    if (i >= 0) used.add(i);
    pairs.push({ figma: ft, dom: i >= 0 ? domTexts[i] : null, how });
  }
  const extra = domTexts.filter((_, i) => !used.has(i)).map((d) => d.text.slice(0, 60));
  return { pairs, extra };
}

function compareText(ft, dt, posTol) {
  const issues = [];
  const add = (prop, figma, code) => issues.push({ prop, figma, code });

  if (ft.fontFamily) {
    const first = dt.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    if (!first.includes(ft.fontFamily.toLowerCase()) && !ft.fontFamily.toLowerCase().includes(first)) {
      add('font-family', ft.fontFamily, dt.fontFamily.split(',')[0]);
    }
  }
  if (ft.fontSize != null && Math.abs(ft.fontSize - dt.fontSize) > TOL.fontSize) add('font-size', `${ft.fontSize}px`, `${r1(dt.fontSize)}px`);
  if (ft.fontWeight != null && ft.fontWeight !== dt.fontWeight) add('font-weight', ft.fontWeight, dt.fontWeight);
  if (ft.italic !== (dt.fontStyle === 'italic')) add('font-style', ft.italic ? 'italic' : 'normal', dt.fontStyle);
  if (ft.lineHeightPx != null) {
    const code = dt.lineHeight ?? dt.fontSize * 1.2;
    if (Math.abs(ft.lineHeightPx - code) > TOL.lineHeight) add('line-height', `${r1(ft.lineHeightPx)}px`, dt.lineHeight == null ? 'normal' : `${r1(code)}px`);
  }
  if (Math.abs((ft.letterSpacing ?? 0) - (dt.letterSpacing ?? 0)) > TOL.letterSpacing) {
    add('letter-spacing', `${r1(ft.letterSpacing ?? 0)}px`, `${r1(dt.letterSpacing ?? 0)}px`);
  }
  if (ft.color && colorDiff(ft.color, dt.color)) add('color', ft.color, dt.color);
  const wantsUpper = ft.textCase === 'UPPER';
  const isUpper = dt.textTransform === 'uppercase' || (dt.text === dt.text.toUpperCase() && /[a-z]/i.test(dt.text));
  if (wantsUpper && !isUpper) add('text-transform', 'uppercase', dt.textTransform);
  const wantsUnderline = ft.textDecoration === 'UNDERLINE';
  const wantsStrike = ft.textDecoration === 'STRIKETHROUGH';
  if (wantsUnderline !== dt.textDecoration.includes('underline') || wantsStrike !== dt.textDecoration.includes('line-through')) {
    add('text-decoration', ft.textDecoration.toLowerCase(), dt.textDecoration);
  }
  // Figma text boxes can be wider than the glyphs; compare the edge the text is aligned to.
  const anchor = (x, w) => (ft.textAlign === 'CENTER' ? x + w / 2 : ft.textAlign === 'RIGHT' ? x + w : x);
  const dx = anchor(dt.x, dt.w) - anchor(ft.x, ft.w);
  const dy = dt.y - ft.y;
  if (Math.abs(dx) > posTol || Math.abs(dy) > posTol) add('position', `x${r1(ft.x)} y${r1(ft.y)}`, `x${r1(dt.x)} y${r1(dt.y)} (Δx ${r1(dx)}, Δy ${r1(dy)})`);
  return issues;
}

function compareImages(figmaImages, domImages) {
  const order = (a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x);
  const fi = [...figmaImages].sort(order);
  const di = [...domImages].sort(order);
  const issues = [];
  if (fi.length !== di.length) issues.push({ prop: 'image-count', figma: fi.length, code: di.length });
  const n = Math.min(fi.length, di.length);
  for (let i = 0; i < n; i++) {
    const f = fi[i];
    const d = di[i];
    if (d.broken) issues.push({ prop: 'image-broken', index: i + 1, figma: f.name, code: 'broken' });
    if (Math.abs(f.w - d.w) > TOL.size + 1 || Math.abs(f.h - d.h) > TOL.size + 1) {
      issues.push({ prop: 'image-size', index: i + 1, figma: `${r1(f.w)}×${r1(f.h)} (${f.name})`, code: `${r1(d.w)}×${r1(d.h)}` });
    }
  }
  return issues;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const flags = parseFlags();
  requireFlags(flags, ['feature', 'url'], USAGE);
  const posTol = Number(flags['pos-tol'] ?? 2);
  const round = flags.round ?? '1';
  const { dir, sections, viewports } = loadFeature(flags.feature, { only: flags.sections });
  const outDir = roundDir(flags.feature, round);
  const browser = await launch();
  const report = [];

  try {
    for (const vp of Object.values(viewports)) {
      const pageOpts = { url: flags.url, route: flags.route, password: flags.password };
      const { context, page: sharedPage } = await openPage(browser, { ...pageOpts, viewport: vp });
      for (const section of sections) {
        const specs = (section.dumps?.[vp.name] ?? []).map((d) => path.join(dir, d.replace(/\.md$/, '.json')));
        if (!specs.length) continue;
        const entry = { section: section.name, viewport: vp.name, width: vp.width, issues: [], unmatched: [], extra: [] };
        report.push(entry);
        if (!section.selector) { entry.status = 'NO_SELECTOR'; continue; }
        const sp = await sectionPage(browser, sharedPage, section, vp, pageOpts);
        const { page } = sp;
        try {
          if (sp.error) { entry.status = 'BEFORE_FAILED'; entry.note = sp.error; continue; }
          if (!(await page.locator(section.selector).first().count())) { entry.status = 'NOT_FOUND'; continue; }
          await scrollToNatural(page, section.selector);
          await waitForImages(page, section.selector);
          const dom = await page.evaluate(collect, section.selector);
          if (!dom) { entry.status = 'NOT_FOUND'; continue; }

          const figma = { texts: [], images: [], section: null };
          // A section grouped from several Figma layers: each spec is relative to its own layer, so shift it
          // by the layer's position within the group (from the frame index).
          const indexFile = path.join(dir, 'figma-dumps', `${vp.name}-index.json`);
          const frameLayers = fs.existsSync(indexFile) ? readJson(indexFile).sections : [];
          const layerPos = new Map(frameLayers
            .filter((s) => s.spec).map((s) => [path.join(dir, s.spec), { x: s.x, y: s.y, h: s.height }]));
          const placed = specs.map((f) => layerPos.get(f)).filter(Boolean);
          const origin = placed.length === specs.length && specs.length > 1
            ? { x: 0, y: Math.min(...placed.map((p) => p.y)) }
            : null;
          for (const file of specs) {
            if (!fs.existsSync(file)) {
              entry.status = 'NO_SPEC';
              entry.note = `missing ${path.relative(dir, file)} — re-run figma-rest extract (it writes .json specs)`;
              continue;
            }
            const spec = readJson(file);
            figma.section ??= spec.section;
            const at = origin ? layerPos.get(file) : null;
            const move = (b) => (b ? { ...b, x: b.x + at.x - origin.x, y: b.y + at.y - origin.y } : b);
            const shift = (item) => (at ? { ...move(item), ...(item.full ? { full: move(item.full) } : {}) } : item);
            figma.texts.push(...spec.texts.map(shift));
            figma.images.push(...spec.images.map(shift));
          }
          if (entry.status === 'NO_SPEC') continue;

          // Figma draws the section across the whole frame but the code section is a centred container:
          // compare x on the page, not within the section.
          const fullFrame = placedWidth(figma, specs.length) >= vp.width - 2;
          if (fullFrame && dom.width < vp.width - 2 && dom.left > 1) {
            for (const t of dom.texts) t.x += dom.left;
            for (const i of dom.images) i.x += dom.left;
            entry.note = `code section is ${Math.round(dom.width)}px wide at x${Math.round(dom.left)}; x compared on the page`;
          }

          // Grouped section: its height runs from the top layer to the bottom layer, so extra top/bottom
          // padding in code shows up here even though every text position matches.
          // The gap below the last layer belongs to this section in code (its bottom padding), so measure up to
          // the next layer in the frame (including header/footer chrome), or the last layer's bottom if none follows.
          if (origin) {
            const bottom = Math.max(...placed.map((p) => p.y + p.h));
            const nextTop = Math.min(...frameLayers.map((l) => l.y).filter((y) => y >= bottom - 1), Infinity);
            const groupHeight = (Number.isFinite(nextTop) ? nextTop : bottom) - origin.y;
            if (Math.abs(groupHeight - dom.height) > TOL.size + 1) {
              entry.issues.push({ target: 'section', prop: 'height', figma: `${r1(groupHeight)}px (${specs.length} layers, to the next layer)`, code: `${r1(dom.height)}px` });
            }
          }

          // Section box (single-node sections only — grouped sections differ by design)
          if (specs.length === 1 && figma.section && !(fullFrame && dom.width < vp.width - 2)) {
            const fs1 = figma.section;
            if (Math.abs(fs1.width - dom.width) > TOL.size) entry.issues.push({ target: 'section', prop: 'width', figma: `${fs1.width}px`, code: `${r1(dom.width)}px` });
            if (Math.abs(fs1.height - dom.height) > TOL.size + 1) entry.issues.push({ target: 'section', prop: 'height', figma: `${fs1.height}px`, code: `${r1(dom.height)}px` });
            if (fs1.background && colorDiff(fs1.background, dom.background)) entry.issues.push({ target: 'section', prop: 'background', figma: fs1.background, code: dom.background });
          }

          const { pairs, extra } = matchTexts(figma.texts, dom.texts);
          for (const p of pairs) {
            if (!p.dom) { entry.unmatched.push(p.figma.text.slice(0, 60)); continue; }
            if (p.how === 'prefix' && norm(p.figma.text) !== norm(p.dom.text)) {
              entry.issues.push({ target: `text "${p.figma.text.trim().slice(0, 40)}"`, prop: 'copy', figma: JSON.stringify(p.figma.text.trim().slice(0, 80)), code: JSON.stringify(p.dom.text.trim().slice(0, 80)) });
            }
            for (const issue of compareText(p.figma, p.dom, posTol)) {
              entry.issues.push({ target: `text "${p.figma.text.trim().slice(0, 40)}"`, element: `${p.dom.tag}${p.dom.cls ? `.${p.dom.cls.split(/\s+/)[0]}` : ''}`, ...issue });
            }
          }
          entry.extra = extra.slice(0, 20);
          for (const issue of compareImages(figma.images, dom.images)) entry.issues.push({ target: 'image', ...issue });

          entry.matchedTexts = pairs.filter((p) => p.dom).length;
          entry.figmaTexts = pairs.length;
          entry.status = entry.issues.length ? 'FAIL' : 'PASS';
          console.error(`[measure] ${vp.name}/${section.name}: ${entry.status} (${entry.issues.length} issue(s), ${entry.unmatched.length} unmatched)`);
        } finally {
          await sp.close();
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(outDir, 'measure.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = [];
  for (const e of report) {
    lines.push(`## ${e.section} — ${e.viewport} ${e.width}px: ${e.status}${e.matchedTexts != null ? ` (texts matched ${e.matchedTexts}/${e.figmaTexts})` : ''}${e.note ? ` — ${e.note}` : ''}`);
    for (const i of e.issues) lines.push(`- ${i.target}${i.element ? ` <${i.element}>` : ''}: ${i.prop} — figma ${i.figma} | code ${i.code}`);
    if (e.unmatched.length) lines.push(`- unmatched Figma text (missing, changed copy or dynamic data): ${e.unmatched.map((t) => JSON.stringify(t)).join(', ')}`);
    if (e.unmatched.length && e.extra?.length) lines.push(`- code text with no Figma match: ${e.extra.map((t) => JSON.stringify(t)).join(', ')}`);
  }
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(`[measure] Fatal: ${err.message}`);
  process.exit(1);
});
