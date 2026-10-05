---
name: js-standards
description: JavaScript standards for Shopify themes — modern ES, defer loading, Web Components, data attributes. No inline styles, DOM creation, or inline scripts.
user-invocable: false
---

# JavaScript Standards

## Core Rules

This theme uses **vanilla JavaScript only**. No frameworks, no jQuery, no build-step libraries.

Shopify themes run on Shopify's CDN with no build pipeline. Every byte of JavaScript is served directly to the browser, so the theme must work without compilation, bundling, or transpilation. Vanilla JS also keeps the dependency footprint at zero — no version conflicts, no supply chain risk, no build failures.

### Modern ES Syntax — Always

- **`const` by default. `let` when reassignment is needed. Never `var`.**
- **Arrow functions as default.** Use function declarations only for Web Component methods and named hoisting.
- Destructuring for object/array access
- Template literals over string concatenation
- Optional chaining (`?.`) and nullish coalescing (`??`) over manual null checks
- `for...of` over `.forEach()` when no index needed

```javascript
// ✅ Correct
const gallery = document.querySelector('.product-gallery');
const { productId, imagesCount } = gallery.dataset;
const items = [...document.querySelectorAll('.item')];

const handleClick = (event) => {
  const { target } = event;
  target.classList.toggle('is-active');
};

// ❌ Wrong
var gallery = document.querySelector('.product-gallery');
var productId = gallery.getAttribute('data-product-id');
function handleClick(event) {
  event.target.classList.toggle('is-active');
}
```

## File Organization

- All JS lives in `assets/` directory as separate files
- Never create inline `<script>` tags in Liquid files
- Pass Liquid values to JS via `data-` attributes:

Data attributes create a clean boundary between Liquid (server) and JS (client). The Liquid template renders data into the DOM as attributes, and JS reads it at runtime. This avoids the security risks of interpolating Liquid variables into inline script blocks and keeps the two languages decoupled.

```liquid
<div class="product-gallery" data-product-id="{{ product.id }}" data-images-count="{{ product.images.size }}">
```

```javascript
const gallery = document.querySelector('.product-gallery');
const { productId, imagesCount } = gallery.dataset;
```

## Script Loading

Always `defer` regardless of fold position:

`defer` tells the browser to download the script in parallel with HTML parsing but execute it only after the DOM is fully parsed. This prevents JS from blocking page rendering — critical for Shopify's Core Web Vitals scores.

```liquid
<script src="{{ 'section-name.js' | asset_url }}" defer></script>
```

## Initialization Patterns

**One-off section scripts** — `DOMContentLoaded`:

```javascript
document.addEventListener('DOMContentLoaded', () => {
  // Initialize section behavior
});
```

Use `DOMContentLoaded` for one-off section scripts because it's simple and direct — the code runs once when the page loads.

**Reusable interactive components** (multiple places) — Web Components:

```javascript
class AccordionElement extends HTMLElement {
  connectedCallback() {
    // Initialize
  }

  disconnectedCallback() {
    // Cleanup event listeners
  }
}

if (!customElements.get('accordion-element')) {
  customElements.define('accordion-element', AccordionElement);
}
```

Web Components handle Theme Editor compatibility automatically — `connectedCallback` fires when a section is added or re-rendered in the editor, and `disconnectedCallback` cleans up when it's removed. This lifecycle management is essential for components that appear in multiple sections or need to survive editor re-renders.

Do NOT use Web Components for one-off section scripts.

## Strict Rules

### 1. NO Styling via JavaScript

Never inline styles. Toggle CSS classes instead:

```javascript
// ❌ element.style.display = 'block';
// ✅ element.classList.add('is-open');
// ✅ element.classList.remove('is-closed');
```

Never use Tailwind classes as query selectors.

Styling through JS bypasses the CSS cascade and makes styles impossible to override with CSS specificity. It also scatters visual logic across two languages — CSS for some styles, JS for others — making the theme harder to maintain and debug. CSS classes are declarative, cacheable, and visible in browser dev tools' Styles panel.

### 2. NO DOM Creation via JavaScript

Never build HTML strings in JS. Never use `innerHTML` with templates for components. Liquid handles all markup.

The Shopify theme editor needs to see and manage all markup server-side. DOM created by JS is invisible to the editor's section rendering pipeline. Additionally, `innerHTML` with interpolated data is an XSS vector, and server-rendered markup is indexed by search engines while JS-created DOM may not be.

If a feature requires dynamic rendering (e.g., predictive search results, AJAX cart line items), prefer cloning a Liquid-rendered `<template>` element over building HTML strings in JS.

### 3. NO Price Formatting in JavaScript

Always use Liquid money filters. Never format prices in JS.

```javascript
// ❌ const price = `$${(cents / 100).toFixed(2)}`;
```
```liquid
// ✅ {{ product.price | money }}
```

Shopify handles currency formatting, locale-specific number formats, and multi-currency conversion at the server level through Liquid money filters. Recreating this logic in JS is error-prone (different currencies have different decimal rules, symbol positions, and thousands separators) and will break when the store changes currency settings.

### 4. NO Inline Scripts

All JS lives in asset files. No `<script>` blocks in Liquid.

External JS files are cached by the browser — a script loaded on the homepage is already cached when the user navigates to a product page. Inline scripts are re-parsed on every page load. Keeping all JS in asset files also makes the theme's JavaScript surface area auditable from a single directory.

## Checklist

Validate every `.js` file against these before committing.

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
