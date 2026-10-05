# JavaScript Standards — Rules & Checklist

## Strict Rules
1. **NO inline styles via JS**: Never `element.style.*`. Toggle CSS classes instead.
2. **NO DOM creation**: Never `innerHTML` with template strings. Liquid handles all markup. Clone `<template>` for dynamic rendering.
3. **NO price formatting in JS**: Always use Liquid `| money` filters.
4. **NO inline scripts**: All JS in asset files. No `<script>` blocks in Liquid.

## Rules
- Vanilla JS only — no frameworks, no jQuery, no build-step libraries
- `const` by default, `let` when reassignment needed, never `var`
- Arrow functions default, function declarations only for Web Component methods
- Destructuring, template literals, optional chaining (`?.`), nullish coalescing (`??`)
- Files: `assets/section-name-javascript.js`
- Loading: always `defer`
- Data passing: Liquid → JS via `data-` attributes, never inline scripts
- Init: `DOMContentLoaded` for one-off sections, Web Components for reusable
- Web Component registration guarded: `if (!customElements.get('name'))`
- Never use Tailwind classes as query selectors
- Naming: files `kebab-case.js`, variables `camelCase`, constants `UPPER_SNAKE_CASE`, classes `PascalCase`, custom elements `kebab-case`

## Checklist

### Modern ES Syntax
- [ ] `const` used by default — `let` only when reassignment needed
- [ ] No `var` anywhere
- [ ] Arrow functions used as default
- [ ] Function declarations only for Web Component methods or named hoisting
- [ ] Destructuring used for object/array access
- [ ] Template literals over string concatenation
- [ ] Optional chaining (`?.`) and nullish coalescing (`??`) over manual null checks

### File & Loading
- [ ] JS lives in `assets/` directory — not inline in Liquid
- [ ] Script tag uses `defer`
- [ ] Liquid values passed via `data-` attributes — no inline `<script>` for data

### Initialization
- [ ] One-off sections use `DOMContentLoaded`
- [ ] Reusable components use Web Components with `connectedCallback`/`disconnectedCallback`
- [ ] Custom element registration guarded: `if (!customElements.get('name'))`

### Strict Rules
- [ ] No `element.style.*` — CSS classes toggled instead
- [ ] No Tailwind classes used as query selectors
- [ ] No `innerHTML` with template strings for component rendering
- [ ] No price formatting in JS — Liquid `| money` handles prices
- [ ] No inline `<script>` tags in Liquid files

### Naming
- [ ] Files: `kebab-case.js`
- [ ] Variables/functions: `camelCase`
- [ ] Constants: `UPPER_SNAKE_CASE`
- [ ] Web Component classes: `PascalCase`
- [ ] Custom element tags: `kebab-case`
