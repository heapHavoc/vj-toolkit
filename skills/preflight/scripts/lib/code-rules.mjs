/**
 * code-rules.mjs — pure, context-aware rule logic for check-code.mjs (S4, S6,
 * S7). Kept free of git/fs so the regression tests can exercise it directly.
 *
 * Every rule here exists because a text-only version of it produced false
 * alarms on a real run:
 *   S4 — bare class-name matching flagged `.product-hero .notes-tab.active`
 *        as colliding with a sitewide `.active`. Selectors are now compared
 *        in full, with CSS nesting resolved.
 *   S6 — "lorem ipsum" in a schema default was ranked the same as lorem ipsum
 *        saved into a template and rendered on the page.
 *   S7 — `{{ x.price }}` in a `data-price` attribute or a JSON payload was
 *        flagged as a shopper-visible unformatted price.
 */

/* ── shared helpers ───────────────────────────────────────────────────── */

export function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** Replace comments with same-length whitespace so offsets and line numbers survive. */
function blankCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/* ── CSS parsing (nesting-aware) ──────────────────────────────────────── */

const GROUPING_AT_RULES = /^@(media|supports|container|layer|document|scope)\b/i;

function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function normalizeSelector(sel) {
  return sel
    .replace(/\s+/g, ' ')
    .replace(/\s*([>+~])\s*/g, ' $1 ')
    .trim();
}

function combineSelectors(parents, children) {
  if (!parents || parents.length === 0) return children.map(normalizeSelector);
  const out = [];
  for (const p of parents) {
    for (const c of children) out.push(normalizeSelector(c.includes('&') ? c.replace(/&/g, p) : `${p} ${c}`));
  }
  return out;
}

/**
 * Flatten a stylesheet into { selector, props:Set, line } records.
 * Resolves native CSS nesting (`.a { .b { } }` → `.a .b`, `&.x` → `.ax`),
 * descends into @media/@supports/@container/@layer, ignores @keyframes /
 * @font-face bodies. Not a full CSS parser — good enough to compare selectors.
 */
export function parseCssRules(css) {
  const text = blankCssComments(css);
  const rules = [];
  const stack = []; // { kind: 'rule'|'group'|'ignore', selectors?, record? }
  let buf = '';
  let bufStart = 0;
  let quote = null;

  const currentSelectors = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === 'rule') return stack[i].selectors;
    return null;
  };
  const inIgnored = () => stack.some((s) => s.kind === 'ignore');
  const addDeclaration = (decl) => {
    const top = stack[stack.length - 1];
    if (!top || top.kind !== 'rule') return;
    const m = decl.match(/^\s*(--[\w-]+|-?[a-zA-Z][\w-]*)\s*:/);
    if (m) for (const r of top.records) r.props.add(m[1].toLowerCase());
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '{') {
      const prelude = buf.trim();
      const preludeLine = lineOf(text, bufStart + (buf.length - buf.trimStart().length));
      buf = '';
      bufStart = i + 1;
      if (inIgnored()) {
        stack.push({ kind: 'ignore' });
      } else if (prelude.startsWith('@')) {
        stack.push({ kind: GROUPING_AT_RULES.test(prelude) ? 'group' : 'ignore' });
      } else {
        const selectors = combineSelectors(currentSelectors(), splitTopLevel(prelude, ','));
        const records = selectors.map((selector) => ({ selector, props: new Set(), line: preludeLine }));
        rules.push(...records);
        stack.push({ kind: 'rule', selectors, records });
      }
      continue;
    }
    if (ch === ';') {
      if (!inIgnored()) addDeclaration(buf);
      buf = '';
      bufStart = i + 1;
      continue;
    }
    if (ch === '}') {
      if (!inIgnored()) addDeclaration(buf);
      buf = '';
      bufStart = i + 1;
      stack.pop();
      continue;
    }
    buf += ch;
  }
  return rules;
}

/* ── selector analysis ────────────────────────────────────────────────── */

/** Compounds of a selector (split on descendant/child/sibling combinators). */
export function compoundsOf(selector) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of normalizeSelector(selector)) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Classes on a compound, ignoring anything inside :not()/:is()/:has() etc. */
export function classesOf(compound) {
  const stripped = compound.replace(/\([^)]*\)/g, '');
  return [...stripped.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

/** `.active`, `.icon:hover` — one compound carrying exactly one class and no id. */
export function isBareSingleClass(selector) {
  const compounds = compoundsOf(selector);
  if (compounds.length !== 1) return false;
  const c = compounds[0];
  if (c.includes('#')) return false;
  return classesOf(c).length === 1 && !/^[a-zA-Z]/.test(c);
}

/**
 * Generic state/utility names (`.active`, `.icon`, `.is-open`, `.js-toggle`) are the ones a bare
 * rule leaks across components. A namespaced component class (`.acme-faq`, `.product-hero`,
 * `.card__title`) defined bare in its own stylesheet is normal BEM, not a collision — if another
 * file also defines it bare, rule (a) already catches the exact-selector overlap.
 */
export function isGenericClassName(cls) {
  return /^(is|has|js|u)-/.test(cls) || !/[-_]/.test(cls);
}

export function subjectClasses(selector) {
  const compounds = compoundsOf(selector);
  return compounds.length ? classesOf(compounds[compounds.length - 1]) : [];
}

/* ── S4: CSS collisions introduced by this diff ──────────────────────── */

function ruleIndex(rules) {
  const map = new Map(); // selector -> Set(props)
  for (const r of rules) {
    if (!map.has(r.selector)) map.set(r.selector, { props: new Set(), line: r.line });
    for (const p of r.props) map.get(r.selector).props.add(p);
  }
  return map;
}

/**
 * @param {Map<string,string>} stagingCss  file -> content, every CSS asset on staging
 * @param {Map<string,string>} liveCss     file -> content on live (changed files only is enough)
 * @param {string[]} changedCssFiles       CSS files added/modified by the diff
 * @returns findings[] — kinds:
 *   css-selector-override  P1  same full selector + same property styled in another file
 *   css-unscoped-generic   P1  new bare selector on a generic class name (`.active`, `.is-open`) other files also use
 *   css-override-candidate P2  new scoped rule whose subject class is styled bare elsewhere with overlapping props
 */
export function findCssCollisions(stagingCss, liveCss, changedCssFiles) {
  const parsed = new Map();
  for (const [file, content] of stagingCss) parsed.set(file, ruleIndex(parseCssRules(content)));

  // Other-file indexes over staging.
  const bySelector = new Map(); // selector -> [{file, props, line}]
  const bareByClass = new Map(); // class -> [{file, selector, props, line}]
  const anyByClass = new Map(); // class -> Set(file)
  for (const [file, index] of parsed) {
    for (const [selector, { props, line }] of index) {
      if (!bySelector.has(selector)) bySelector.set(selector, []);
      bySelector.get(selector).push({ file, props, line });
      for (const compound of compoundsOf(selector)) {
        for (const cls of classesOf(compound)) {
          if (!anyByClass.has(cls)) anyByClass.set(cls, new Set());
          anyByClass.get(cls).add(file);
        }
      }
      if (isBareSingleClass(selector)) {
        const cls = subjectClasses(selector)[0];
        if (!bareByClass.has(cls)) bareByClass.set(cls, []);
        bareByClass.get(cls).push({ file, selector, props, line });
      }
    }
  }

  const findings = [];
  const seen = new Set();
  const push = (f) => {
    const key = `${f.kind}|${f.file}|${f.selector}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  for (const file of changedCssFiles) {
    const stagingIndex = parsed.get(file);
    if (!stagingIndex) continue;
    const liveIndex = liveCss.has(file) ? ruleIndex(parseCssRules(liveCss.get(file))) : new Map();

    for (const [selector, { props, line }] of stagingIndex) {
      const liveProps = liveIndex.get(selector)?.props || new Set();
      const newProps = [...props].filter((p) => !liveProps.has(p));
      if (newProps.length === 0) continue; // rule unchanged by this diff

      // (a) exact selector, same property, another file.
      const others = (bySelector.get(selector) || []).filter((o) => o.file !== file);
      const overlapping = others
        .map((o) => ({ file: o.file, line: o.line, props: newProps.filter((p) => o.props.has(p)) }))
        .filter((o) => o.props.length > 0);
      if (overlapping.length > 0) {
        push({ kind: 'css-selector-override', priority: 'P1', selector, file, line, props: newProps, otherFiles: overlapping.map((o) => `${o.file}:${o.line}`), files: [file, ...overlapping.map((o) => o.file)] });
      }

      // (b) new bare selector on a GENERIC class name (`.active`) that other files also use.
      if (isBareSingleClass(selector)) {
        const cls = subjectClasses(selector)[0];
        const otherFiles = [...(anyByClass.get(cls) || [])].filter((f) => f !== file);
        if (isGenericClassName(cls) && otherFiles.length > 0) {
          push({ kind: 'css-unscoped-generic', priority: 'P1', selector, class: cls, file, line, props: newProps, otherFiles: otherFiles.slice(0, 12), otherFileCount: otherFiles.length, files: [file, ...otherFiles] });
        }
        continue;
      }

      // (c) scoped rule overriding a bare rule for the same element class elsewhere.
      for (const cls of subjectClasses(selector)) {
        const bare = (bareByClass.get(cls) || []).filter((b) => b.file !== file);
        const overrides = bare
          .map((b) => ({ file: b.file, line: b.line, selector: b.selector, props: newProps.filter((p) => b.props.has(p)) }))
          .filter((b) => b.props.length > 0);
        if (overrides.length > 0) {
          push({ kind: 'css-override-candidate', priority: 'P2', selector, class: cls, file, line, overrides: overrides.map((o) => ({ at: `${o.file}:${o.line}`, selector: o.selector, props: o.props })), files: [file, ...overrides.map((o) => o.file)] });
        }
      }
    }
  }
  return findings;
}

/* ── S6: placeholder content, classified by where it lives ──────────────── */

export const PLACEHOLDER_PATTERNS = [/lorem ipsum/i, /\bTODO\b/, /\bFIXME\b/, /example\.com/i, /test-product/i];

/** Parse a unified diff (-U0 or not) into added lines with their staging line numbers. */
export function addedLinesWithNumbers(patch) {
  const out = [];
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      out.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith(' ')) {
      newLine++;
    }
  }
  return out;
}

/** Line ranges of {% schema %} and {% comment %} blocks in a Liquid file. */
export function liquidRegions(content) {
  const regions = [];
  const add = (re, type) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content))) regions.push({ type, start: lineOf(content, m.index), end: lineOf(content, m.index + m[0].length) });
  };
  add(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, 'schema');
  add(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, 'comment');
  add(/<!--[\s\S]*?-->/g, 'comment');
  return regions;
}

/**
 * Where a placeholder sits decides whether a shopper sees it:
 *   saved-content    P1  template / section-group / settings_data JSON — rendered as-is
 *   storefront-locale P1 locales/*.json (not *.schema.json)
 *   markup           P1  Liquid outside schema/comments
 *   schema-default   P2  a default in {% schema %} — only used when a merchant adds the section fresh
 *   comment          P2  Liquid/HTML/JS/CSS comment
 *   editor-locale    P2  locales/*.schema.json — theme-editor strings
 *   code             P1  JS/CSS outside a comment
 */
export function classifyPlaceholder(file, line, text, stagingContent) {
  if (/^templates\/.*\.json$/.test(file) || /^sections\/.*\.json$/.test(file) || file === 'config/settings_data.json') return { location: 'saved-content', priority: 'P1' };
  if (file === 'config/settings_schema.json') return { location: 'schema-default', priority: 'P2' };
  if (file.startsWith('locales/')) return file.endsWith('.schema.json') ? { location: 'editor-locale', priority: 'P2' } : { location: 'storefront-locale', priority: 'P1' };
  if (file.endsWith('.liquid')) {
    const region = liquidRegions(stagingContent || '').find((r) => line >= r.start && line <= r.end);
    if (region?.type === 'schema') return { location: 'schema-default', priority: 'P2' };
    if (region?.type === 'comment') return { location: 'comment', priority: 'P2' };
    return { location: 'markup', priority: 'P1' };
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return { location: 'comment', priority: 'P2' };
  return { location: 'code', priority: 'P1' };
}

/* ── S7: standards rules with context guards ─────────────────────────── */

/** True when `idx` is inside a <script>…</script> block (any type). */
function insideScript(content, idx) {
  const open = content.lastIndexOf('<script', idx);
  if (open === -1) return false;
  const close = content.lastIndexOf('</script', idx);
  return close < open;
}

function insideLiquidBlock(content, idx, tag) {
  const openRe = new RegExp(`\\{%-?\\s*${tag}\\s*-?%\\}`, 'g');
  const closeRe = new RegExp(`\\{%-?\\s*end${tag}\\s*-?%\\}`, 'g');
  let lastOpen = -1;
  let lastClose = -1;
  let m;
  while ((m = openRe.exec(content)) && m.index < idx) lastOpen = m.index;
  while ((m = closeRe.exec(content)) && m.index < idx) lastClose = m.index;
  return lastOpen > lastClose;
}

/**
 * A raw `{{ x.price }}` is only a finding when it is shopper-visible text.
 * Skipped: data-* / value attributes (machine-read, raw cents on purpose),
 * a JSON key's value, anything inside <script> (JSON payloads, JS), and
 * anything inside {% comment %} / {% schema %}.
 */
export function manualPriceIsVisible(content, idx) {
  const lineStart = content.lastIndexOf('\n', idx - 1) + 1;
  const prefix = content.slice(lineStart, idx);
  if (/\b(data-[\w-]+|value)\s*=\s*["'][^"']*$/.test(prefix)) return false;
  if (/"[\w-]+"\s*:\s*$/.test(prefix)) return false;
  if (insideScript(content, idx)) return false;
  if (insideLiquidBlock(content, idx, 'comment') || insideLiquidBlock(content, idx, 'schema')) return false;
  return true;
}

export const STANDARDS_RULES = [
  { id: 'liquid-include', priority: 'P1', ext: '.liquid', dir: null, re: /\{%-?\s*include\s+/g, message: 'Uses {% include %} — standards require {% render %}.' },
  { id: 'liquid-html-comment', priority: 'P2', ext: '.liquid', dir: null, re: /<!--[\s\S]*?-->/g, message: 'HTML comment in a .liquid file — standards forbid these.' },
  { id: 'liquid-manual-price', priority: 'P1', ext: '.liquid', dir: null, re: /\{\{-?\s*[\w.]+\.price\s*-?\}\}/g, message: 'Shopper-visible price output without | money filter.', guard: manualPriceIsVisible },
  { id: 'js-var', priority: 'P1', ext: '.js', dir: 'assets', re: /(^|\s)var\s+/g, message: 'Uses var — standards require const/let.' },
  { id: 'js-inline-style', priority: 'P1', ext: '.js', dir: 'assets', re: /\.style\.[a-zA-Z]+\s*=/g, message: 'Direct element.style assignment — standards require class toggling.' },
  { id: 'js-inner-html-template', priority: 'P0', ext: '.js', dir: 'assets', re: /\.innerHTML\s*=\s*`/g, message: 'innerHTML assigned from a template literal — XSS risk, standards forbid this.' },
  { id: 'js-unguarded-custom-element', priority: 'P1', ext: '.js', dir: 'assets', re: /customElements\.define\(/g, message: 'customElements.define not guarded by customElements.get() check.', guard: (content, idx) => !content.slice(Math.max(0, idx - 120), idx).includes('customElements.get(') },
  { id: 'css-comment', priority: 'P2', ext: '.css', dir: 'assets', re: /\/\*[\s\S]*?\*\//g, message: 'CSS comment present — standards forbid comments in compiled asset CSS.' },
];

/** Guarded matches of one rule in one file's content. */
export function ruleHits(rule, content) {
  const hits = [];
  if (!content) return hits;
  rule.re.lastIndex = 0;
  let m;
  while ((m = rule.re.exec(content))) {
    if (rule.guard && !rule.guard(content, m.index)) continue;
    hits.push({ index: m.index, line: lineOf(content, m.index), snippet: m[0].slice(0, 80) });
  }
  return hits;
}
