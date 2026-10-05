#!/usr/bin/env node
/**
 * extract-figma-sections.js — Dev Mode-style design dump from the raw REST node tree
 *
 * One GET /v1/files/:key/nodes call (cached) replaces the Framelink summary.
 * For every section it writes a layer tree with CSS-like properties, text
 * content, variable/style/theme-token annotations, component variants,
 * prototype interactions, and a "Behaviour signals" block inferred from
 * structure (clipped overflow, repeated items, scroll containers, hidden
 * states, pagination/progress indicators, layer names).
 *
 * Usage:
 *   node extract-figma-sections.js \
 *     --file-key <key> --node-id <id> --feature <name> \
 *     [--viewport auto|desktop|mobile] [--mode auto|page|section] \
 *     [--include-chrome] [--no-variables] [--refresh] [--from-json <raw.json>]
 *
 * Output:
 *   .buildspace/artifacts/{feature}/figma-dumps/{viewport}/NN-{name}.md   per section
 *   .buildspace/artifacts/{feature}/figma-dumps/{viewport}-tokens.md     colors/variables/type scale
 *   .buildspace/artifacts/{feature}/figma-dumps/{viewport}-index.json    section index (also stdout)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  requireToken, parseFlags, figmaApi, artifactsDir, rawDir, cachedJson, getNodes,
  toKebabCase, HttpError,
} = require('./lib/figma');

// ── Constants ───────────────────────────────────────────────────

const VECTOR_TYPES = new Set([
  'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON',
]);
const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'SECTION']);
const CHROME_RE = /\b(header|footer|nav|navbar|navigation)\b/i;
const HELPER_RE = /(pixel[-\s]?grid|layout[-\s]?grid|^grid$|^(design[-\s]?)?guides?$|^guidelines?$|redline|annotation|^notes?$|status[-\s]?bar|url[-\s]?bar|browser[-\s]?(bar|chrome)|home[-\s]?indicator|^keyboard$|device[-\s]?frame)/i;
const WRAPPER_NAME_RE = /^(content|contents|main|body|wrapper|container|sections?|page[-\s]?content|frame\s*\d*)$/i;
const GENERIC_NAME_RE = /^(frame|group|rectangle|container|section|auto layout|div|wrapper|content|layer)?[\s_-]*\d*$/i;
const BEHAVIOUR_NAME_RE = /\b(carousel|slider|slides?|swiper|marquee|ticker|tabs?|accordion|collapsed?|collapsible|expand(ed)?|drop-?down|select(ed|ion)?|not selected|modal|popup|pop-up|drawer|overlay|tooltip|toggle|switch|hover|active|open|closed|pagination|dots|indicator|progress|arrows?|next|prev(ious)?|chevron|play(-button)?|video|countdown|timer|sticky|scroll|input|search|form|field|checkbox|radio|quantity|swatch(es)?|filter|sort|menu)\b/i;
const CTA_TEXT_RE = /^(shop|view|explore|discover|learn|read|load|see|add to|buy|subscribe|sign up|join|get|show|check|apply|submit|continue|more)\b/i;

// ── Colors & tokens ─────────────────────────────────────────────

const to255 = (n) => Math.round(n * 255);
const hex2 = (n) => to255(n).toString(16).padStart(2, '0').toUpperCase();
const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const px = (n) => `${round(n)}px`;

function colorToCss(color, opacity = 1) {
  const a = round((color.a ?? 1) * opacity, 3);
  const hex = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  return a >= 1 ? hex : `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${a})`;
}

function hexOf(color) {
  return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
}

function shortVarId(id) {
  return String(id).replace(/^VariableID:/, '').replace(/^.*\//, '');
}

function loadThemeTokens(cwd) {
  const tokens = { colors: new Map(), fonts: new Map() };
  const file = path.join(cwd, 'config/settings_data.json');
  if (!fs.existsSync(file)) return tokens;
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const data = JSON.parse(text);
    let current = data.current;
    if (typeof current === 'string') current = data.presets?.[current] ?? {};
    for (const [key, value] of Object.entries(current ?? {})) {
      if (typeof value !== 'string') continue;
      if (/^#[0-9a-f]{6}$/i.test(value)) {
        const hex = value.toUpperCase();
        if (!tokens.colors.has(hex)) tokens.colors.set(hex, []);
        tokens.colors.get(hex).push(key);
      } else if (/^type_/.test(key) && /_[nib]\d$/.test(value)) {
        tokens.fonts.set(value.replace(/_[nib]\d$/, ''), key);
      }
    }
  } catch (err) {
    console.error(`[extract] Could not read theme settings: ${err.message}`);
  }
  return tokens;
}

// ── Extraction context ──────────────────────────────────────────

class Ctx {
  constructor({ nodesResponse, variables, theme }) {
    this.components = nodesResponse.components ?? {};
    this.componentSets = nodesResponse.componentSets ?? {};
    this.styles = nodesResponse.styles ?? {};
    this.variables = variables;
    this.theme = theme;
    this.nodeNames = new Map();
    this.colorUsage = new Map();
    this.varUsage = new Map();
    this.typeUsage = new Map();
    this.styleUsage = new Map();
  }

  annotateColor(color, opacity, boundVarId, usage) {
    const css = colorToCss(color, opacity);
    const notes = [];
    const hex = hexOf(color);
    if (boundVarId) {
      const meta = this.variables?.[boundVarId];
      const label = meta ? meta.name : `var ${shortVarId(boundVarId)}`;
      notes.push(label);
      const entry = this.varUsage.get(boundVarId) ?? { label, values: new Set(), uses: new Map() };
      entry.values.add(css);
      entry.uses.set(usage, (entry.uses.get(usage) ?? 0) + 1);
      this.varUsage.set(boundVarId, entry);
    }
    const themeKeys = this.theme.colors.get(hex);
    const alpha = round((color.a ?? 1) * opacity, 3);
    if (themeKeys) notes.push(`theme ${themeKeys.join('|')}${alpha < 1 ? ` @${Math.round(alpha * 100)}%` : ''}`);
    const cu = this.colorUsage.get(css) ?? { count: 0, uses: new Set(), notes: new Set() };
    cu.count++;
    cu.uses.add(usage);
    notes.forEach((n) => cu.notes.add(n));
    this.colorUsage.set(css, cu);
    return notes.length ? `${css} /* ${notes.join(' · ')} */` : css;
  }

  styleName(node, kind, value) {
    const id = node.styles?.[kind];
    if (!id) return null;
    const name = this.styles[id]?.name;
    if (name) {
      const key = `${kind}|${name}`;
      const entry = this.styleUsage.get(key) ?? { kind, name, count: 0, value: null };
      entry.count++;
      entry.value ??= value ? String(value).replace(/\s*\/\*.*?\*\//g, '') : null;
      this.styleUsage.set(key, entry);
    }
    return name ?? null;
  }
}

// ── Node helpers ────────────────────────────────────────────────

const isVisible = (n) => n.visible !== false;
const bbox = (n) => n.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
const visibleChildren = (n) => (n.children ?? []).filter(isVisible);

function isVectorOnly(node) {
  if (VECTOR_TYPES.has(node.type)) return true;
  if (node.type === 'RECTANGLE' && !(node.fills ?? []).some((f) => f.type === 'IMAGE')) return true;
  if (node.type === 'TEXT') return false;
  if ((node.fills ?? []).some((f) => f.type === 'IMAGE' && f.visible !== false)) return false;
  const kids = visibleChildren(node);
  if (!kids.length) return false;
  return kids.every(isVectorOnly);
}

function firstPaintColor(node) {
  const paints = [...(node.fills ?? []), ...(node.strokes ?? [])].filter((p) => p.type === 'SOLID' && p.visible !== false);
  if (paints.length) return colorToCss(paints[0].color, paints[0].opacity ?? 1);
  for (const c of visibleChildren(node)) {
    const found = firstPaintColor(c);
    if (found) return found;
  }
  return null;
}

function collectTexts(node, out = []) {
  if (!isVisible(node)) return out;
  if (node.type === 'TEXT' && node.characters?.trim()) out.push(node.characters.trim());
  for (const c of node.children ?? []) collectTexts(c, out);
  return out;
}

function largestText(node) {
  let best = null;
  const walk = (n) => {
    if (!isVisible(n)) return;
    if (n.type === 'TEXT' && (n.characters?.match(/[a-z]/gi) ?? []).length >= 3) {
      const size = n.style?.fontSize ?? 0;
      if (!best || size > best.size) best = { size, text: n.characters.trim() };
    }
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return best?.text ?? null;
}

function signature(node) {
  const kids = visibleChildren(node).map(signature).join(',');
  const imageFill = (node.fills ?? []).some((f) => f.type === 'IMAGE') ? 'img' : '';
  return `${node.type}${imageFill}:${node.layoutMode ?? ''}[${kids}]`;
}

function solidKey(paints) {
  return (paints ?? []).filter((p) => p.visible !== false && p.type === 'SOLID')
    .map((p) => colorToCss(p.color, p.opacity ?? 1)).join('+');
}

// Structure + appearance: siblings are only compressed as "↻" when they also
// look the same, so a selected/active item stays visible in the dump.
function visualSignature(node) {
  const kids = visibleChildren(node).map(visualSignature).join(',');
  const look = [
    solidKey(node.fills), solidKey(node.strokes), node.strokeWeight ?? '',
    node.opacity ?? 1, node.style?.fontWeight ?? '', node.style?.textDecoration ?? '',
    (node.effects ?? []).filter((e) => e.visible !== false).length,
  ].join('|');
  return `${signature({ ...node, children: [] })}{${look}}[${kids}]`;
}

function describeLook(node) {
  const parts = [];
  const fill = solidKey(node.fills);
  const stroke = solidKey(node.strokes);
  if (fill) parts.push(`bg ${fill}`);
  if (stroke) parts.push(`border ${stroke}`);
  const text = [];
  const walk = (n) => {
    if (!isVisible(n)) return;
    if (n.type === 'TEXT') text.push(`${n.style?.fontWeight ?? ''} ${solidKey(n.fills)}`.trim());
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  if (text.length) parts.push(`text ${[...new Set(text)].join('/')}`);
  return parts.join(', ') || 'different styling';
}

// ── Text style resolution ───────────────────────────────────────
// A text's base `style` can be overridden for most of its characters
// (e.g. base Bold, 90% of characters Regular). The dominant style — the one
// covering the most characters — is what the text actually looks like.

function dominantOverrideId(node) {
  const overrides = node.characterStyleOverrides ?? [];
  if (!overrides.length) return 0;
  const len = [...(node.characters ?? '')].length;
  const counts = new Map();
  for (let i = 0; i < len; i++) {
    const id = overrides[i] ?? 0;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [id, c] of counts) if (c > bestCount) { best = id; bestCount = c; }
  return node.styleOverrideTable?.[best] ? best : 0;
}

function effectiveStyle(node) {
  const id = dominantOverrideId(node);
  if (!id) return { style: node.style ?? {}, fills: node.fills, id: 0 };
  const o = node.styleOverrideTable[id];
  const { fills, ...rest } = o;
  return { style: { ...(node.style ?? {}), ...rest }, fills: fills ?? node.fills, id };
}

// ── CSS generation ──────────────────────────────────────────────

const JUSTIFY = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
const ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };

function layoutCss(node, parent) {
  const css = [];
  const lm = node.layoutMode;
  if (lm === 'HORIZONTAL' || lm === 'VERTICAL') {
    css.push('display:flex');
    if (lm === 'VERTICAL') css.push('flex-direction:column');
    if (node.layoutWrap === 'WRAP') css.push('flex-wrap:wrap');
    const justify = JUSTIFY[node.primaryAxisAlignItems ?? 'MIN'];
    if (justify && justify !== 'flex-start') css.push(`justify-content:${justify}`);
    const align = ALIGN[node.counterAxisAlignItems ?? 'MIN'];
    if (align && align !== 'flex-start') css.push(`align-items:${align}`);
    if (round(node.itemSpacing ?? 0) !== 0 && node.primaryAxisAlignItems !== 'SPACE_BETWEEN') css.push(`gap:${px(node.itemSpacing)}`);
    if (node.layoutWrap === 'WRAP' && node.counterAxisSpacing) css.push(`row-gap:${px(node.counterAxisSpacing)}`);
  } else if (lm === 'GRID') {
    css.push('display:grid');
    if (node.gridColumnCount) css.push(`grid-template-columns:repeat(${node.gridColumnCount}, 1fr)`);
    if (node.gridRowCount) css.push(`grid-template-rows:repeat(${node.gridRowCount}, auto)`);
    if (node.gridColumnGap) css.push(`column-gap:${px(node.gridColumnGap)}`);
    if (node.gridRowGap) css.push(`row-gap:${px(node.gridRowGap)}`);
  }

  const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((v) => v ?? 0);
  if (pad.some(Boolean)) {
    const [t, r, b, l] = pad.map(px);
    css.push(`padding:${t === b && r === l ? (t === r ? t : `${t} ${r}`) : `${t} ${r} ${b} ${l}`}`);
  }

  const { width, height } = bbox(node);
  const parentAuto = parent && ['HORIZONTAL', 'VERTICAL', 'GRID'].includes(parent.layoutMode);
  const parentRow = parent?.layoutMode === 'HORIZONTAL';
  const sizing = (axis) => (axis === 'h' ? node.layoutSizingHorizontal : node.layoutSizingVertical);
  for (const axis of ['h', 'v']) {
    const mode = sizing(axis);
    const prop = axis === 'h' ? 'width' : 'height';
    const size = axis === 'h' ? width : height;
    if (mode === 'FILL') {
      const mainAxis = (axis === 'h') === parentRow;
      css.push(parentAuto && mainAxis ? 'flex:1 0 0' : `${prop}:100%`);
    } else if (mode === 'HUG') {
      // content-sized: no explicit dimension
    } else if (node.type !== 'TEXT' || axis === 'h') {
      css.push(`${prop}:${px(size)}`);
    }
  }
  for (const [key, prop] of [['minWidth', 'min-width'], ['maxWidth', 'max-width'], ['minHeight', 'min-height'], ['maxHeight', 'max-height']]) {
    if (node[key]) css.push(`${prop}:${px(node[key])}`);
  }
  if (node.targetAspectRatio && node.preserveRatio) {
    const { x, y } = node.targetAspectRatio;
    if (x && y) css.push(`aspect-ratio:${round(x)} / ${round(y)}`);
  }

  const absolute = node.layoutPositioning === 'ABSOLUTE' || (parent && !parent.layoutMode && parent.type !== 'GROUP' && visibleChildren(parent).length > 1);
  if (absolute && parent) {
    const pb = bbox(parent);
    const b = bbox(node);
    css.push('position:absolute', `left:${px(b.x - pb.x)}`, `top:${px(b.y - pb.y)}`);
  }
  const kidsVisible = visibleChildren(node);
  if (kidsVisible.some((k) => k.layoutPositioning === 'ABSOLUTE') || (!node.layoutMode && node.type !== 'GROUP' && node.type !== 'TEXT' && kidsVisible.length > 1)) {
    css.push('position:relative');
  }
  if (node.scrollBehavior === 'FIXED') css.push('/* fixed on scroll (prototype) */');
  if (node.scrollBehavior === 'STICKY_SCROLLS') css.push('/* sticky on scroll (prototype) */');
  if (node.clipsContent) css.push('overflow:hidden');
  if (node.overflowDirection === 'HORIZONTAL_SCROLLING') css.push('overflow-x:auto');
  if (node.overflowDirection === 'VERTICAL_SCROLLING') css.push('overflow-y:auto');
  if (node.overflowDirection === 'HORIZONTAL_AND_VERTICAL_SCROLLING') css.push('overflow:auto');
  return css;
}

function gradientCss(fill) {
  const stops = (fill.gradientStops ?? []).map((s) => `${colorToCss(s.color, fill.opacity ?? 1)} ${round(s.position * 100, 1)}%`).join(', ');
  if (fill.type === 'GRADIENT_LINEAR') {
    const [a, b] = fill.gradientHandlePositions ?? [];
    const angle = a && b ? round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90, 1) : 180;
    return `linear-gradient(${angle}deg, ${stops})`;
  }
  if (fill.type === 'GRADIENT_RADIAL') return `radial-gradient(${stops})`;
  return `${fill.type.toLowerCase()}(${stops})`;
}

const SCALE = { FILL: 'cover', FIT: 'contain', CROP: 'cover (cropped)', TILE: 'repeat' };

function paintCss(node, ctx, kind) {
  const paints = (kind === 'fill' ? node.fills : node.strokes) ?? [];
  const out = [];
  for (const p of paints) {
    if (p.visible === false) continue;
    if (p.type === 'SOLID') {
      const varId = p.boundVariables?.color?.id;
      out.push(ctx.annotateColor(p.color, p.opacity ?? 1, varId, kind === 'fill' ? (node.type === 'TEXT' ? 'text' : 'background') : 'border'));
    } else if (p.type.startsWith('GRADIENT')) {
      out.push(gradientCss(p));
    } else if (p.type === 'IMAGE') {
      out.push(`url(image:${(p.imageRef ?? '').slice(0, 10)}) ${SCALE[p.scaleMode] ?? ''}`.trim());
    }
  }
  const styleName = ctx.styleName(node, kind === 'fill' ? 'fill' : 'stroke', out[0]);
  if (styleName && out.length) out[0] += ` /* style "${styleName}" */`;
  return out;
}

function boxCss(node, ctx) {
  const css = [];
  if (node.type !== 'TEXT') {
    const fills = paintCss(node, ctx, 'fill');
    if (fills.length) css.push(`background:${fills.join(', ')}`);
  }
  const strokes = paintCss(node, ctx, 'stroke');
  if (strokes.length) {
    const style = node.strokeDashes?.length ? 'dashed' : 'solid';
    const w = node.individualStrokeWeights;
    const align = node.strokeAlign && node.strokeAlign !== 'INSIDE' ? ` /* ${node.strokeAlign.toLowerCase()} */` : '';
    if (w && new Set([w.top, w.right, w.bottom, w.left]).size > 1) {
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (w[side]) css.push(`border-${side}:${px(w[side])} ${style} ${strokes[0]}`);
      }
    } else if (node.type !== 'TEXT' && node.strokeWeight) {
      css.push(`border:${px(node.strokeWeight)} ${style} ${strokes[0]}${align}`);
    }
  }
  if (node.rectangleCornerRadii && new Set(node.rectangleCornerRadii).size > 1) {
    css.push(`border-radius:${node.rectangleCornerRadii.map(px).join(' ')}`);
  } else if (node.cornerRadius) {
    css.push(`border-radius:${px(node.cornerRadius)}`);
  }
  const shadows = [];
  for (const e of node.effects ?? []) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      shadows.push(`${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius ?? 0)} ${px(e.spread ?? 0)} ${colorToCss(e.color)}`);
    } else if (e.type === 'LAYER_BLUR') {
      css.push(`filter:blur(${px((e.radius ?? 0) / 2)})`);
    } else if (e.type === 'BACKGROUND_BLUR') {
      css.push(`backdrop-filter:blur(${px((e.radius ?? 0) / 2)})`);
    }
  }
  if (shadows.length) css.push(`box-shadow:${shadows.join(', ')}`);
  const effectStyle = ctx.styleName(node, 'effect', shadows.join(', ') || null);
  if (effectStyle && shadows.length) css[css.length - 1] += ` /* style "${effectStyle}" */`;
  if (node.opacity !== undefined && node.opacity < 1) css.push(`opacity:${round(node.opacity, 2)}`);
  if (node.blendMode && !['PASS_THROUGH', 'NORMAL'].includes(node.blendMode)) css.push(`mix-blend-mode:${node.blendMode.toLowerCase().replace(/_/g, '-')}`);
  if (node.rotation && Math.abs(node.rotation) > 0.01) {
    const deg = Math.abs(node.rotation) <= Math.PI * 2 + 0.01 ? (node.rotation * 180) / Math.PI : node.rotation;
    if (Math.abs(deg) > 0.5) css.push(`transform:rotate(${round(-deg, 1)}deg)`);
  }
  return css;
}

const TEXT_CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize', SMALL_CAPS: 'small-caps' };

function fontCss(style, ctx) {
  if (!style) return [];
  const css = [];
  const lh = style.lineHeightUnit === 'INTRINSIC_%' || !style.lineHeightPx ? 'normal' : px(style.lineHeightPx);
  const italic = /italic/i.test(style.fontStyle ?? '') || style.italic ? 'italic ' : '';
  const famKey = String(style.fontFamily ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const themeFont = ctx.theme.fonts.get(famKey);
  css.push(`font:${italic}${style.fontWeight ?? 400} ${px(style.fontSize ?? 0)}/${lh} "${style.fontFamily}"${themeFont ? ` /* theme ${themeFont} */` : ''}`);
  if (style.letterSpacing) css.push(`letter-spacing:${px(style.letterSpacing)}`);
  if (style.textCase && TEXT_CASE[style.textCase]) css.push(`text-transform:${TEXT_CASE[style.textCase]}`);
  if (style.textDecoration && style.textDecoration !== 'NONE') css.push(`text-decoration:${style.textDecoration === 'STRIKETHROUGH' ? 'line-through' : 'underline'}`);
  return css;
}

function textCss(node, ctx) {
  const eff = effectiveStyle(node);
  const s = eff.style;
  const css = fontCss(s, ctx);
  const textStyle = ctx.styleName(node, 'text', css[0]);
  if (textStyle) css[0] += ` /* style "${textStyle}" */`;
  const color = paintCss({ ...node, fills: eff.fills }, ctx, 'fill');
  if (color.length) css.push(`color:${color[0]}`);
  if (s.textAlignHorizontal && s.textAlignHorizontal !== 'LEFT') css.push(`text-align:${s.textAlignHorizontal.toLowerCase()}`);
  if (s.paragraphSpacing) css.push(`/* paragraph-spacing:${px(s.paragraphSpacing)} */`);
  if (s.textTruncation === 'ENDING') css.push(`text-overflow:ellipsis${s.maxLines ? `; -webkit-line-clamp:${s.maxLines}` : ''}`);
  const typeKey = `${s.fontFamily} ${s.fontWeight} ${round(s.fontSize ?? 0)}/${s.lineHeightPx ? round(s.lineHeightPx) : 'normal'}${s.letterSpacing ? ` ls ${round(s.letterSpacing)}` : ''}${s.textCase && s.textCase !== 'ORIGINAL' ? ` ${s.textCase.toLowerCase()}` : ''}`;
  const entry = ctx.typeUsage.get(typeKey) ?? { count: 0, samples: [] };
  entry.count++;
  if (entry.samples.length < 3) entry.samples.push((node.characters ?? '').trim().slice(0, 40));
  ctx.typeUsage.set(typeKey, entry);
  return css;
}

function textRuns(node, ctx) {
  const overrides = node.characterStyleOverrides ?? [];
  const table = node.styleOverrideTable ?? {};
  if (!overrides.length || !Object.keys(table).length) return [];
  const chars = [...(node.characters ?? '')];
  const eff = effectiveStyle(node);
  const base = eff.style;
  const runs = [];
  let start = 0;
  for (let i = 1; i <= chars.length; i++) {
    const prev = overrides[i - 1] ?? 0;
    const cur = i < chars.length ? (overrides[i] ?? 0) : null;
    if (cur === prev) continue;
    if (prev !== eff.id && (prev === 0 || table[prev])) {
      const o = prev === 0 ? { ...(node.style ?? {}), fills: node.fills } : table[prev];
      const diff = [];
      for (const k of ['fontFamily', 'fontWeight', 'fontSize', 'textDecoration', 'textCase', 'italic']) {
        if (o[k] !== undefined && o[k] !== base[k]) diff.push(`${k}:${o[k]}`);
      }
      const fill = o.fills?.find((f) => f.type === 'SOLID');
      if (fill) diff.push(`color:${ctx.annotateColor(fill.color, fill.opacity ?? 1, fill.boundVariables?.color?.id, 'text')}`);
      const text = chars.slice(start, i).join('').trim();
      if (diff.length && text) runs.push(`"${text}" → ${diff.join('; ')}`);
    }
    start = i;
  }
  return runs;
}

// ── Component & interaction annotations ─────────────────────────

function componentNote(node, ctx) {
  if (node.type !== 'INSTANCE' && node.type !== 'COMPONENT') return null;
  const comp = ctx.components[node.componentId] ?? {};
  const set = comp.componentSetId ? ctx.componentSets[comp.componentSetId] : null;
  const name = set ? `${set.name} / ${comp.name}` : comp.name ?? node.name;
  const props = Object.entries(node.componentProperties ?? {})
    .filter(([, v]) => v.type === 'VARIANT' || v.type === 'BOOLEAN')
    .map(([k, v]) => `${k.replace(/#.*$/, '')}=${v.value}`);
  return `component "${name}"${props.length ? ` {${props.join(', ')}}` : ''}`;
}

function describeInteractions(node, ctx) {
  const list = node.interactions?.length ? node.interactions : node.reactions ?? [];
  const out = [];
  for (const it of list) {
    const trigger = String(it.trigger?.type ?? 'UNKNOWN').replace(/^ON_/, '');
    const timeout = it.trigger?.timeout !== undefined ? ` ${round(it.trigger.timeout * 1000, 0)}ms` : '';
    const actions = it.actions ?? (it.action ? [it.action] : []);
    for (const a of actions) {
      if (!a) continue;
      let what;
      if (a.type === 'NODE') {
        const dest = a.destinationId
          ? ctx.nodeNames.get(a.destinationId) ?? ctx.components[a.destinationId]?.name ?? a.destinationId
          : '?';
        what = `${(a.navigation ?? 'NAVIGATE').toLowerCase().replace(/_/g, ' ')} → "${dest}"`;
        if (a.transition?.type) what += ` (${a.transition.type.toLowerCase()}${a.transition.duration ? ` ${round(a.transition.duration * 1000, 0)}ms` : ''})`;
      } else if (a.type === 'URL') {
        what = `open url ${a.url}`;
      } else {
        what = a.type.toLowerCase().replace(/_/g, ' ');
      }
      out.push(`on ${trigger.toLowerCase().replace(/_/g, ' ')}${timeout}: ${what}`);
    }
  }
  return out;
}

// ── Behaviour signals ───────────────────────────────────────────

function behaviourSignals(section, ctx) {
  const signals = [];
  const add = (s) => { if (!signals.includes(s)) signals.push(s); };

  const walk = (node, depth) => {
    const label = `"${node.name}"`;
    if (!isVisible(node)) {
      if (depth > 0) add(`hidden layer ${label} (${node.type.toLowerCase()}) — possible alternate state (open/hover/active) or unused`);
      return;
    }
    for (const i of describeInteractions(node, ctx)) add(`prototype on ${label}: ${i}`);
    if (node.overflowDirection && node.overflowDirection !== 'NONE') add(`${label} is a prototype scroll container (${node.overflowDirection.toLowerCase().replace(/_/g, ' ')}) → scrollable row / slider`);
    if (node.scrollBehavior === 'STICKY_SCROLLS') add(`${label} is sticky on scroll`);
    if (node.scrollBehavior === 'FIXED') add(`${label} is fixed on scroll`);
    if (depth > 0 && isVectorOnly(node)) return;

    const kids = visibleChildren(node);
    if (kids.length && CONTAINER_TYPES.has(node.type)) {
      const nb = bbox(node);
      const minX = Math.min(...kids.map((k) => bbox(k).x));
      const maxX = Math.max(...kids.map((k) => bbox(k).x + bbox(k).width));
      const maxY = Math.max(...kids.map((k) => bbox(k).y + bbox(k).height));
      if (node.clipsContent && (maxX - (nb.x + nb.width) > 4 || nb.x - minX > 4)) {
        const visible = kids.filter((k) => bbox(k).x < nb.x + nb.width && bbox(k).x + bbox(k).width > nb.x).length;
        add(`${label} clips ${kids.length} children overflowing horizontally (${visible} visible) → slider/carousel`);
      }
      const wide = kids.filter((k) => bbox(k).width > nb.width * 1.2 && ['HORIZONTAL', 'GRID'].includes(k.layoutMode) && visibleChildren(k).length >= 2);
      for (const k of wide) {
        add(`"${k.name}" row is ${round(bbox(k).width)}px wide inside ${label} (${round(nb.width)}px) → horizontal scroll / slider`);
      }
      if (node.clipsContent && maxY - (nb.y + nb.height) > 4) {
        add(`${label} clips content vertically → collapsed/expandable or scroll area`);
      }

      const groups = new Map();
      for (const k of kids) {
        const sig = signature(k);
        groups.set(sig, [...(groups.get(sig) ?? []), k]);
      }
      for (const group of groups.values()) {
        if (group.length >= 2) {
          const looks = new Map();
          for (const g of group) {
            const v = visualSignature(g);
            looks.set(v, [...(looks.get(v) ?? []), g]);
          }
          if (looks.size > 1) {
            const sorted = [...looks.values()].sort((a, b) => b.length - a.length);
            const base = sorted[0];
            if (base.length >= 2 && !isVectorOnly(base[0]) && sorted.slice(1).every((odd) => odd.length < base.length)) {
              for (const odd of sorted.slice(1).flat()) {
                if (describeLook(odd) === describeLook(base[0])) continue;
                const stripBorder = (d) => d.replace(/(^|, )border (?:rgba?\([^)]*\)|#[0-9A-F]{6})(?:\+(?:rgba?\([^)]*\)|#[0-9A-F]{6}))*/g, '').replace(/^, /, '');
                const edge = kids[0] === odd || kids[kids.length - 1] === odd;
                if (edge && stripBorder(describeLook(odd)) === stripBorder(describeLook(base[0]))) {
                  add(`in ${label}, the ${kids[0] === odd ? 'first' : 'last'} item differs only by its border → edge item without divider (not a state)`);
                  continue;
                }
                const label2 = collectTexts(odd)[0] ? `"${collectTexts(odd)[0].slice(0, 30)}"` : `"${odd.name}" #${odd.id}`;
                add(`in ${label}, item ${label2} looks different from its ${base.length} siblings (${describeLook(odd)} vs ${describeLook(base[0])}) → distinct state/variant (selected, active, sale price…)`);
              }
            }
          }
        }
        if (group.length < 3) continue;
        const sample = group[0];
        const sb = bbox(sample);
        const dotLike = sb.width <= 14 && sb.height <= 14 && !/star|rating|icon/i.test(sample.name)
          && (sample.type === 'ELLIPSE' || !isVectorOnly(sample));
        if (dotLike) {
          const colors = new Set(group.map((g) => firstPaintColor(g)));
          add(colors.size >= 3
            ? `${label} has ${group.length} tiny items in ${colors.size} different colors (${round(sb.width)}×${round(sb.height)}) → color swatches`
            : `${label} has ${group.length} tiny repeated dots (${round(sb.width)}×${round(sb.height)}) → pagination indicator (slider)`);
        } else if (sb.width <= 14 && sb.height <= 14) {
          // small repeated glyphs (stars, separators) — not behavioural
        } else if (sample.type !== 'TEXT' && !isVectorOnly(sample)) {
          const hasIcon = (n) => visibleChildren(n).some((c) => isVectorOnly(c) && bbox(c).width <= 32) || visibleChildren(n).some(hasIcon);
          const rowLike = sb.width > sb.height * 3 && collectTexts(sample).length <= 3 && hasIcon(sample);
          add(`${label} repeats ${group.length}× "${sample.name}" (${round(sb.width)}×${round(sb.height)})${rowLike ? ' with trailing icon → accordion/list rows' : ' → loop over blocks/items'}`);
        }
      }

      if (node.layoutMode === 'HORIZONTAL' && kids.length >= 2 && kids.length <= 3) {
        const heights = kids.map((k) => bbox(k).height);
        const tallest = Math.max(...heights);
        for (const k of kids) {
          const h = bbox(k).height;
          if (h >= 200 && h < tallest * 0.5 && bbox(k).width >= nb.width * 0.25) {
            add(`${label}: column "${k.name}" (${round(h)}px) sits beside a ${round(tallest)}px column → likely sticky while the taller column scrolls (inferred)`);
          }
        }
      }
      if (kids.length === 1 && nb.height <= 6 && bbox(kids[0]).width < nb.width * 0.9) {
        add(`${label} is a ${round(nb.height)}px track with a ${round(bbox(kids[0]).width)}px fill → progress bar (rating distribution, scroll or slider indicator)`);
      }
    }

    if (node.type !== 'TEXT' && BEHAVIOUR_NAME_RE.test(String(node.name).replace(/[-_/]+/g, ' ')) && !GENERIC_NAME_RE.test(node.name)) {
      add(`layer named ${label} suggests behaviour`);
    }
    if (node.type === 'TEXT') {
      const t = (node.characters ?? '').trim();
      if (/^[<>‹›←→⟨⟩❮❯]$/.test(t)) add(`arrow glyph "${t}" → slider navigation`);
      if (/^[+−-]$/.test(t)) add(`"${t}" glyph → accordion toggle / quantity stepper`);
      if (/^(enter|search|type|your email|email|pincode|pin code|zip)/i.test(t)) add(`placeholder-like text "${t.slice(0, 30)}" → input field`);
      if (CTA_TEXT_RE.test(t) && t.length <= 30) add(`CTA text "${t}"`);
    }
    for (const k of node.children ?? []) walk(k, depth + 1);
  };

  walk(section, 0);
  return signals;
}

// ── Tree rendering ──────────────────────────────────────────────

// ── Machine-readable spec (used by figma-verify) ────────────────
// Every visible text and image with geometry relative to the section, no
// repeat compression, so a browser can be measured against it.

function buildSpec(section, frameClip = null) {
  const sb = bbox(section);
  const rel = (n) => {
    const b = bbox(n);
    return { x: round(b.x - sb.x), y: round(b.y - sb.y), w: round(b.width), h: round(b.height) };
  };
  const texts = [];
  const images = [];
  // Visible rect = node box intersected with every clipping ancestor.
  const clipRel = (n, clip) => {
    const b = bbox(n);
    const x1 = Math.max(b.x, clip.x1);
    const y1 = Math.max(b.y, clip.y1);
    const x2 = Math.min(b.x + b.width, clip.x2);
    const y2 = Math.min(b.y + b.height, clip.y2);
    return { x: round(x1 - sb.x), y: round(y1 - sb.y), w: round(Math.max(0, x2 - x1)), h: round(Math.max(0, y2 - y1)) };
  };
  const startClip = frameClip
    ? { x1: frameClip.x, y1: frameClip.y, x2: frameClip.x + frameClip.width, y2: frameClip.y + frameClip.height }
    : { x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity };
  const walk = (n, clip = startClip) => {
    if (!isVisible(n)) return;
    if (n.type === 'TEXT' && n.characters?.trim()) {
      const eff = effectiveStyle(n);
      const st = eff.style;
      const fill = (eff.fills ?? []).find((f) => f.visible !== false && f.type === 'SOLID');
      texts.push({
        id: n.id,
        name: n.name,
        text: n.characters,
        ...rel(n),
        fontFamily: st.fontFamily ?? null,
        fontSize: st.fontSize ?? null,
        fontWeight: st.fontWeight ?? null,
        italic: /italic/i.test(st.fontStyle ?? '') || Boolean(st.italic),
        lineHeightPx: st.lineHeightUnit === 'INTRINSIC_%' ? null : (st.lineHeightPx ?? null),
        letterSpacing: st.letterSpacing ?? 0,
        textCase: st.textCase ?? 'ORIGINAL',
        textDecoration: st.textDecoration ?? 'NONE',
        textAlign: st.textAlignHorizontal ?? 'LEFT',
        color: fill ? colorToCss(fill.color, (fill.opacity ?? 1) * (n.opacity ?? 1)) : null,
      });
    }
    const img = (n.fills ?? []).find((f) => f.visible !== false && f.type === 'IMAGE');
    if (img) {
      const vis = clipRel(n, clip);
      if (vis.w > 0 && vis.h > 0) images.push({ id: n.id, name: n.name, ...vis, full: rel(n), scaleMode: img.scaleMode ?? null, radius: n.cornerRadius ?? null });
    }
    let next = clip;
    if (n.clipsContent && n !== section) {
      const b = bbox(n);
      next = { x1: Math.max(clip.x1, b.x), y1: Math.max(clip.y1, b.y), x2: Math.min(clip.x2, b.x + b.width), y2: Math.min(clip.y2, b.y + b.height) };
    }
    if (n.type !== 'TEXT' && !(n !== section && isVectorOnly(n))) (n.children ?? []).forEach((c) => walk(c, next));
  };
  walk(section);
  const bg = (section.fills ?? []).find((f) => f.visible !== false && f.type === 'SOLID');
  // Figma exports a node at its render bounds (overflowing children included);
  // record the visible window so screenshots can be cropped to the frame.
  // Export bounds = section box ∪ every descendant not clipped inside the section.
  const rb = { ...sb };
  const grow = (n) => {
    if (!isVisible(n)) return;
    for (const b of [bbox(n), n.absoluteRenderBounds]) {
      if (!b || !b.width || !b.height) continue;
      const x2 = Math.max(rb.x + rb.width, b.x + b.width);
      const y2 = Math.max(rb.y + rb.height, b.y + b.height);
      rb.x = Math.min(rb.x, b.x);
      rb.y = Math.min(rb.y, b.y);
      rb.width = x2 - rb.x;
      rb.height = y2 - rb.y;
    }
    if (!n.clipsContent) (n.children ?? []).forEach(grow);
  };
  if (!section.clipsContent) (section.children ?? []).forEach(grow);
  const vis = frameClip
    ? {
        x1: Math.max(rb.x, frameClip.x), y1: Math.max(rb.y, frameClip.y),
        x2: Math.min(rb.x + rb.width, frameClip.x + frameClip.width), y2: Math.min(rb.y + rb.height, frameClip.y + frameClip.height),
      }
    : { x1: rb.x, y1: rb.y, x2: rb.x + rb.width, y2: rb.y + rb.height };
  return {
    section: {
      id: section.id,
      name: section.name,
      width: round(sb.width),
      height: round(sb.height),
      background: bg ? colorToCss(bg.color, bg.opacity ?? 1) : null,
      padding: [section.paddingTop, section.paddingRight, section.paddingBottom, section.paddingLeft].map((v) => v ?? 0),
      render: { x: round(rb.x - sb.x), y: round(rb.y - sb.y), w: round(rb.width), h: round(rb.height) },
      visible: { x: round(vis.x1 - rb.x), y: round(vis.y1 - rb.y), w: round(vis.x2 - vis.x1), h: round(vis.y2 - vis.y1) },
    },
    texts,
    images,
  };
}

function renderNode(node, parent, ctx, depth, lines, opts) {
  if (!isVisible(node)) return;
  const indent = '  '.repeat(depth);
  const b = bbox(node);
  const dims = `${round(b.width, 1)}×${round(b.height, 1)}`;
  const comp = componentNote(node, ctx);
  const interactions = describeInteractions(node, ctx);

  const vectorOnly = depth > 0 && isVectorOnly(node);
  if (vectorOnly && (VECTOR_TYPES.has(node.type) || (b.width <= 64 && b.height <= 64))) {
    const color = firstPaintColor(node);
    lines.push(`${indent}- icon "${node.name}" ${dims}${color ? ` color:${color}` : ''}${comp ? ` · ${comp}` : ''}`);
    interactions.forEach((i) => lines.push(`${indent}  ⚡ ${i}`));
    return;
  }

  const css = node.type === 'TEXT'
    ? [...layoutCss(node, parent), ...textCss(node, ctx)]
    : [...layoutCss(node, parent), ...boxCss(node, ctx)];
  const hasImage = (node.fills ?? []).some((f) => f.type === 'IMAGE' && f.visible !== false);
  const tag = node.type === 'TEXT' ? 'text' : hasImage ? 'image' : node.type.toLowerCase();
  lines.push(`${indent}- ${tag} "${node.name}" ${dims} #${node.id}${comp ? ` · ${comp}` : ''}${node.isMask ? ' · MASK' : ''}`);
  if (node.type === 'TEXT') lines.push(`${indent}  » ${JSON.stringify(node.characters ?? '')}`);
  if (css.length) lines.push(`${indent}  { ${css.join('; ')} }`);
  if (node.type === 'TEXT') textRuns(node, ctx).forEach((r) => lines.push(`${indent}  run ${r}`));
  interactions.forEach((i) => lines.push(`${indent}  ⚡ ${i}`));

  if (vectorOnly) {
    const color = visibleChildren(node).map(firstPaintColor).find(Boolean);
    lines.push(`${indent}  - vector artwork (${visibleChildren(node).length} layer(s), export as SVG)${color ? ` color:${color}` : ''}`);
    return;
  }

  const kids = node.children ?? [];
  const hidden = kids.filter((k) => !isVisible(k));
  if (hidden.length) lines.push(`${indent}  (hidden: ${hidden.map((h) => `"${h.name}"`).join(', ')})`);

  const seen = new Map();
  for (const child of kids.filter(isVisible)) {
    const sig = visualSignature(child);
    const first = seen.get(sig);
    if (first && !VECTOR_TYPES.has(child.type) && child.type !== 'TEXT' && visibleChildren(child).length) {
      const texts = collectTexts(child).map((t) => JSON.stringify(t.slice(0, 60)));
      const images = [];
      const findImages = (n) => {
        if (!isVisible(n)) return;
        for (const f of n.fills ?? []) if (f.type === 'IMAGE' && f.imageRef) images.push(f.imageRef.slice(0, 10));
        (n.children ?? []).forEach(findImages);
      };
      findImages(child);
      lines.push(`${indent}  - ↻ same structure as "${first.name}" (#${first.id}): "${child.name}" #${child.id}${texts.length ? ` texts: ${texts.join(' | ')}` : ''}${images.length ? ` images: ${images.join(', ')}` : ''}`);
      continue;
    }
    if (!first) seen.set(sig, child);
    renderNode(child, node, ctx, depth + 1, lines, opts);
  }
}

// ── Sections ────────────────────────────────────────────────────

function helperReason(node, rootBox) {
  const b = bbox(node);
  if (HELPER_RE.test(String(node.name).trim())) return 'design helper / device chrome';
  if (b.width > rootBox.width * 1.05) return `overlay wider than the frame (${round(b.width)}px)`;
  if (!node.children?.length && !['TEXT'].includes(node.type)
      && b.width >= rootBox.width * 0.95 && b.height >= rootBox.height * 0.95) return 'full-frame background layer';
  return null;
}

const WRAPPER_WORD_RE = /\b(sections|wrapper|container|contents?)\b/i;

function isStackWrapper(node, rootBox) {
  const kids = visibleChildren(node);
  if (kids.length < 2 || !CONTAINER_TYPES.has(node.type)) return false;
  const b = bbox(node);
  if (b.width < rootBox.width * 0.85) return false;
  const fullKids = kids.filter((k) => bbox(k).width >= b.width * 0.85);
  const stacked = node.layoutMode === 'VERTICAL' || !node.layoutMode;
  if (!stacked || fullKids.length < Math.ceil(kids.length * 0.7)) return false;
  const name = String(node.name).trim();
  const wrapperWords = WRAPPER_WORD_RE.test(name.replace(/[-_/]+/g, ' ')) && kids.length >= 3;
  return WRAPPER_NAME_RE.test(name) || wrapperWords || b.height >= rootBox.height * 0.4;
}

function pickSections(root, mode) {
  const rootBox = bbox(root);
  const helpers = [];
  if (mode === 'section') return { sections: [root], helpers, groups: [], pageSignals: [], mode: 'section' };

  const candidates = [];
  for (const kid of visibleChildren(root)) {
    const reason = helperReason(kid, rootBox);
    if (reason) helpers.push({ name: kid.name, figmaNodeId: kid.id, reason });
    else candidates.push(kid);
  }

  const mobile = rootBox.width < 600;
  const tall = rootBox.height >= rootBox.width * (mobile ? 3 : 1.2);
  const pageName = /\b(page|home|pdp|plp|landing|template|screen)\b/i.test(root.name);
  if (mode !== 'page' && !(candidates.length >= 2 && (tall || pageName))) {
    return { sections: [root], helpers: [], groups: [], pageSignals: [], mode: 'section' };
  }

  const expand = (nodes) => nodes.flatMap((n) => (isStackWrapper(n, rootBox)
    ? expand(visibleChildren(n).filter((k) => !helperReason(k, rootBox)))
    : [n]));
  const sections = expand(candidates).sort((a, b) => (bbox(a).y - bbox(b).y) || (bbox(a).x - bbox(b).x));

  // Sections sharing a vertical band but not overlapping horizontally sit side by side.
  const groups = [];
  for (const sec of sections) {
    const b = bbox(sec);
    const group = groups.find((g) => g.members.some((m) => {
      const mb = bbox(m);
      const vOverlap = Math.min(b.y + b.height, mb.y + mb.height) - Math.max(b.y, mb.y);
      const hOverlap = Math.min(b.x + b.width, mb.x + mb.width) - Math.max(b.x, mb.x);
      return vOverlap > Math.min(b.height, mb.height) * 0.3 && hOverlap <= 4;
    }));
    if (group) group.members.push(sec);
    else groups.push({ members: [sec] });
  }
  const columnGroups = groups.filter((g) => g.members.length > 1);

  const pageSignals = [];
  columnGroups.forEach((g, i) => {
    const cols = new Map();
    for (const m of g.members) {
      const key = Math.round(bbox(m).x / 8);
      cols.set(key, [...(cols.get(key) ?? []), m]);
    }
    const columns = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([, ms]) => {
      const top = Math.min(...ms.map((m) => bbox(m).y));
      const bottom = Math.max(...ms.map((m) => bbox(m).y + bbox(m).height));
      return { ms, x: bbox(ms[0]).x - rootBox.x, width: Math.max(...ms.map((m) => bbox(m).width)), height: bottom - top };
    });
    g.id = `columns-${i + 1}`;
    g.columns = columns.map((c) => ({ x: round(c.x), width: round(c.width), height: round(c.height), sections: c.ms.map((m) => m.id) }));
    pageSignals.push(`${g.id}: ${columns.length} side-by-side columns — ${columns.map((c) => `[${c.ms.map((m) => `"${m.name}"`).join(' + ')}] x=${round(c.x)} w=${round(c.width)} h=${round(c.height)}`).join(' | ')}`);
    const tallest = Math.max(...columns.map((c) => c.height));
    for (const c of columns) {
      if (c.height < tallest * 0.5) {
        pageSignals.push(`${g.id}: column [${c.ms.map((m) => `"${m.name}"`).join(' + ')}] is ${round(c.height)}px tall beside a ${round(tallest)}px column → likely sticky while the taller column scrolls (inferred)`);
      }
    }
  });

  return { sections, helpers, groups: columnGroups, pageSignals, mode: 'page' };
}

function sectionName(node, used) {
  const cleaned = String(node.name).replace(/^(desktop|mobile|web|mweb|dt|mob)\s*[/:-]\s*/i, '').replace(/\b(desktop|mobile)\b/ig, '').trim();
  let base = cleaned && !GENERIC_NAME_RE.test(cleaned) ? toKebabCase(cleaned) : '';
  if (!base) {
    const heading = largestText(node);
    base = heading ? toKebabCase(heading.split(/\s+/).slice(0, 4).join(' ')) : '';
  }
  if (!base) base = toKebabCase(node.name) || 'section';
  base = base.slice(0, 40).replace(/-+$/, '');
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name);
  return name;
}

// ── Tokens report ───────────────────────────────────────────────

function tokensMarkdown(ctx, viewport, variablesStatus) {
  const lines = [`# Figma tokens — ${viewport}`, ''];
  lines.push(`Variables: ${variablesStatus}`, '');
  if (ctx.varUsage.size) {
    lines.push('## Variables (bound on nodes)', '', '| Variable | Value(s) | Used as | Theme match |', '|---|---|---|---|');
    const rows = [...ctx.varUsage.entries()].sort((a, b) => sum(b[1].uses) - sum(a[1].uses));
    for (const [, v] of rows) {
      const values = [...v.values];
      const theme = values.map((c) => ctx.theme.colors.get(c)?.join('|')).filter(Boolean).join(', ') || '—';
      lines.push(`| ${v.label} | ${values.join(', ')} | ${[...v.uses].map(([k, n]) => `${k} ×${n}`).join(', ')} | ${theme} |`);
    }
    lines.push('');
  }
  lines.push('## Colors', '', '| Color | Count | Used as | Notes |', '|---|---|---|---|');
  for (const [color, u] of [...ctx.colorUsage.entries()].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| ${color} | ${u.count} | ${[...u.uses].join(', ')} | ${[...u.notes].join(' · ') || '—'} |`);
  }
  lines.push('', '## Type scale', '', '| Style | Count | Samples |', '|---|---|---|');
  for (const [key, t] of [...ctx.typeUsage.entries()].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| ${key} | ${t.count} | ${t.samples.map((s) => JSON.stringify(s)).join(', ')} |`);
  }
  if (ctx.styleUsage.size) {
    lines.push('', '## Shared styles (names from the file — use these as token names)', '', '| Style | Kind | Value | Uses |', '|---|---|---|---|');
    const order = { fill: 0, stroke: 1, text: 2, effect: 3 };
    for (const e of [...ctx.styleUsage.values()].sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name))) {
      lines.push(`| ${e.name} | ${e.kind} | ${e.value ?? '—'} | ${e.count} |`);
    }
  }
  return lines.join('\n') + '\n';
}

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

// ── Variables ───────────────────────────────────────────────────

async function loadVariables({ fileKey, feature, token, refresh }) {
  const cache = path.join(rawDir(feature), `variables-${fileKey}.json`);
  try {
    const json = await cachedJson(cache, async () => {
      try {
        console.error('[extract] GET variables/local');
        return await figmaApi(`/v1/files/${fileKey}/variables/local`, token);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 'error';
        return { unavailable: true, status };
      }
    }, { refresh });
    if (json.unavailable) {
      return { map: null, status: `names unavailable (HTTP ${json.status} — variables API needs an Enterprise plan); shown as IDs with resolved values` };
    }
    const vars = json.meta?.variables ?? {};
    const collections = json.meta?.variableCollections ?? {};
    const map = {};
    for (const [id, v] of Object.entries(vars)) {
      map[id] = { name: `${collections[v.variableCollectionId]?.name ?? ''}/${v.name}`.replace(/^\//, '') };
    }
    return { map, status: `${Object.keys(map).length} local variables resolved by name` };
  } catch (err) {
    return { map: null, status: `not loaded (${err.message})` };
  }
}

// ── Interaction destinations ────────────────────────────────────
// Targets of "change to"/"navigate" often live outside the extracted frame
// (variants of a component set, other screens). One batched /nodes call
// with depth=1 names them all.

async function resolveDestinations(root, ctx, { fileKey, feature, token, refresh }) {
  const ids = new Set();
  const walk = (n) => {
    for (const it of [...(n.interactions ?? []), ...(n.reactions ?? [])]) {
      for (const a of it.actions ?? (it.action ? [it.action] : [])) {
        if (a?.destinationId && !ctx.nodeNames.has(a.destinationId) && !ctx.components[a.destinationId]) ids.add(a.destinationId);
      }
    }
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  if (!ids.size || !token) return;
  const sorted = [...ids].sort();
  const key = require('node:crypto').createHash('md5').update(sorted.join(',')).digest('hex').slice(0, 10);
  try {
    const json = await cachedJson(path.join(rawDir(feature), `destinations-${fileKey}-${key}.json`), () => {
      console.error(`[extract] GET ${sorted.length} interaction destination name(s)`);
      return figmaApi(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(sorted.join(','))}&depth=1`, token);
    }, { refresh });
    for (const [id, entry] of Object.entries(json.nodes ?? {})) {
      const doc = entry?.document;
      if (!doc) continue;
      const set = Object.values(entry.componentSets ?? {})[0]?.name;
      ctx.nodeNames.set(id, set && doc.type === 'COMPONENT' ? `${set} / ${doc.name}` : doc.name);
    }
  } catch (err) {
    console.error(`[extract] Could not resolve interaction destinations: ${err.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const flags = parseFlags();
  const { 'file-key': fileKey, 'node-id': nodeId, feature } = flags;
  if (!fileKey || !nodeId || !feature) {
    console.error('Usage: extract-figma-sections.js --file-key <key> --node-id <id> --feature <name> [--viewport auto|desktop|mobile] [--mode auto|page|section] [--include-chrome] [--no-variables] [--refresh] [--from-json <path>]');
    process.exit(1);
  }

  let response;
  let token = null;
  if (flags['from-json']) {
    response = JSON.parse(fs.readFileSync(flags['from-json'], 'utf8'));
  } else {
    token = requireToken();
    response = await getNodes({ fileKey, nodeId, feature, token, refresh: Boolean(flags.refresh) });
  }
  const entry = response.nodes?.[nodeId];
  if (!entry?.document) {
    console.error(`[extract] Node ${nodeId} not found in response (check the node-id and file access).`);
    process.exit(1);
  }
  const root = entry.document;

  const variables = token && !flags['no-variables']
    ? await loadVariables({ fileKey, feature, token, refresh: Boolean(flags.refresh) })
    : { map: null, status: 'not requested; shown as IDs with resolved values' };

  const ctx = new Ctx({ nodesResponse: entry, variables: variables.map, theme: loadThemeTokens(process.cwd()) });
  const indexNames = (n) => { ctx.nodeNames.set(n.id, n.name); (n.children ?? []).forEach(indexNames); };
  indexNames(root);

  await resolveDestinations(root, ctx, { fileKey, feature, token, refresh: Boolean(flags.refresh) });

  const rootBox = bbox(root);
  let viewport = flags.viewport && flags.viewport !== 'auto' ? flags.viewport : (rootBox.width < 600 ? 'mobile' : 'desktop');

  const outDir = path.join(artifactsDir(feature), 'figma-dumps', viewport);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const picked = pickSections(root, flags.mode ?? 'auto');
  const { sections } = picked;
  const groupOf = new Map(picked.groups.flatMap((g) => g.members.map((m) => [m.id, g.id])));
  const used = new Set();
  const index = [];

  sections.forEach((section, i) => {
    const name = sectionName(section, used);
    const sb = bbox(section);
    const words = (str) => String(str).replace(/[-_/]+/g, ' ');
    const chromeName = CHROME_RE.test(words(section.name)) || CHROME_RE.test(words(name));
    const hasLogo = (n) => /\blogo\b/i.test(n.name) || (n.children ?? []).some(hasLogo);
    const logoHeader = GENERIC_NAME_RE.test(section.name.trim()) && sb.height <= 140 && sb.y - rootBox.y <= 200 && hasLogo(section);
    const chrome = (chromeName && (sb.height <= 200 || /footer/i.test(section.name))) || logoHeader;
    const record = {
      order: i + 1,
      name,
      figmaName: section.name,
      figmaNodeId: section.id,
      viewport,
      width: round(sb.width),
      height: round(sb.height),
      x: round(sb.x - rootBox.x),
      y: round(sb.y - rootBox.y),
      ...(groupOf.has(section.id) ? { columnGroup: groupOf.get(section.id) } : {}),
      genericFigmaName: GENERIC_NAME_RE.test(section.name.trim()),
      transparent: !(section.fills ?? []).some((f) => f.visible !== false && (f.opacity ?? 1) > 0 && (f.type === 'IMAGE' || f.type.startsWith('GRADIENT') || (f.color?.a ?? 1) >= 0.99)),
      heading: largestText(section)?.slice(0, 80) ?? null,
    };
    if (chrome && !flags['include-chrome']) {
      index.push({ ...record, skipped: 'header/footer' });
      return;
    }
    const lines = [];
    renderNode(section, null, ctx, 0, lines, {});
    const signals = behaviourSignals(section, ctx);
    const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${name}.md`);
    const md = [
      `# ${section.name} — ${viewport} (#${section.id}) ${round(sb.width)}×${round(sb.height)}`,
      '',
      `Source: https://www.figma.com/design/${fileKey}/?node-id=${section.id.replace(/:/g, '-')}`,
      `Position in frame: x=${record.x} y=${record.y}${record.columnGroup ? ` · part of ${record.columnGroup} (side-by-side layout, see ${viewport}-index.json pageSignals)` : ''}`,
      '',
      '## Behaviour signals',
      '',
      ...(signals.length ? signals.map((s) => `- ${s}`) : ['- none detected (static content)']),
      '',
      '## Layer tree',
      '',
      'Legend: `{ css }` per layer · `»` text content · `run` mixed-style text run · `⚡` prototype interaction · `↻` repeated sibling (structure identical to an earlier one; only text/images listed) · `/* var … */` Figma variable · `/* theme … */` matching theme setting',
      '',
      ...lines,
      '',
    ].join('\n');
    fs.writeFileSync(file, md);
    const specFile = file.replace(/\.md$/, '.json');
    fs.writeFileSync(specFile, JSON.stringify(buildSpec(section, root.clipsContent !== false ? rootBox : null), null, 1) + '\n');
    index.push({
      ...record,
      dump: path.relative(artifactsDir(feature), file),
      spec: path.relative(artifactsDir(feature), specFile),
      signals: signals.length,
      bytes: md.length,
    });
  });

  fs.writeFileSync(path.join(artifactsDir(feature), 'figma-dumps', `${viewport}-tokens.md`), tokensMarkdown(ctx, viewport, variables.status));
  const result = {
    feature, fileKey, nodeId, viewport,
    rootName: root.name,
    rootSize: `${round(rootBox.width)}×${round(rootBox.height)}`,
    mode: picked.mode,
    variables: variables.status,
    pageSignals: picked.pageSignals,
    columnGroups: picked.groups.map(({ id, columns }) => ({ id, columns })),
    skippedHelpers: picked.helpers,
    sections: index,
  };
  fs.writeFileSync(path.join(artifactsDir(feature), 'figma-dumps', `${viewport}-index.json`), JSON.stringify(result, null, 2) + '\n');
  console.error(`[extract] ${viewport}: ${index.filter((s) => !s.skipped).length} section dump(s) → figma-dumps/${viewport}/`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`[extract] Fatal: ${err.message}`);
  process.exit(1);
});
