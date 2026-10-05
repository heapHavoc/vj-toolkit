---
name: theme-architecture
description: Theme file structure and architecture — directory layout, kebab-case naming, snippet extraction, section independence, Online Store 2.0 patterns.
user-invocable: false
---

# Theme Architecture

## Shopify Theme File Structure
```
theme/
├── assets/          # CSS, JS, images, fonts
├── config/          # settings_schema.json, settings_data.json
├── layout/          # theme.liquid, password.liquid
├── locales/         # Translation files
├── sections/        # All sections
├── snippets/        # Reusable Liquid partials
├── templates/       # JSON templates (Online Store 2.0)
└── templates/customers/  # Customer account templates
```

---

## Naming Conventions

### Sections
- Always `kebab-case.liquid`
- Kebab-case aligns with web conventions (URLs, HTML attributes, CSS class names all use hyphens) and avoids filesystem issues — some systems are case-insensitive, making `HeroBanner.liquid` and `herobanner.liquid` indistinguishable.
- Name should describe the section's purpose

```
hero-banner.liquid
product-carousel.liquid
testimonials.liquid
featured-collections.liquid
```

### Templates (JSON)
- Always JSON templates (Online Store 2.0)
- JSON templates enable merchants to add, remove, and reorder sections through the theme editor without touching code. Liquid-based templates lock the layout in code and remove this flexibility — which is the primary value of the Online Store 2.0 architecture.
- `kebab-case.json`
- Alternate templates: `product.kebab-case-name.json`

```
product.json
collection.json
index.json
product.with-video.json
```

### Snippets
- Always `kebab-case.liquid`
- Two naming approaches based on purpose:

**Section-specific snippets** — prefix with section name:
```
hero-banner-slide.liquid
hero-banner-video.liquid
search-modal-loader.liquid
search-modal-recent-searches.liquid
search-modal-trending-collections.liquid
```

**Purpose-based snippets** — name by function:
```
product-card.liquid
css.liquid
icon.liquid
responsive-image.liquid
price-display.liquid
```

### Assets
- CSS files: `section-name-stylesheet.css`
- JS files: `section-name-javascript.js`
- All `kebab-case`

```
hero-banner-stylesheet.css
hero-banner-javascript.js
product-carousel-stylesheet.css
product-carousel-javascript.js
```

---

## When to Create a Snippet

### 1. Data Rendering from Single Source of Truth
When rendering data from one object and the code is long, extract to a snippet. The classic example is a product card — it renders from a product object and is used in many places. Extracting data rendering into a snippet creates a single source of truth. When the product card design changes, you update one file instead of hunting through every section that renders products.

```liquid
{% render 'product-card', card_product: product %}
```

### 2. SVGs and Icons
Never render SVG markup directly in sections or templates. SVG markup is verbose (often 10-50 lines per icon). Inline SVGs bloat section files and make them hard to read. A snippet like `{% render 'icon', icon: 'cart' %}` keeps sections focused on structure and logic. Always use snippets for icons.

```liquid
{%- comment -%} ✅ GOOD {%- endcomment -%}
{% render 'icon', icon: 'cart' %}

{%- comment -%} ❌ BAD — SVG inline in section {%- endcomment -%}
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">...</svg>
```

### 3. Code Organization and Readability
When a section has distinct functional areas, extract each into a snippet to make the section file readable and maintainable.

```liquid
{%- comment -%} ✅ GOOD — clear, readable, each part is self-contained {%- endcomment -%}
{% render 'search-modal-loader' %}
{% render 'search-modal-recent-searches' %}
{% render 'search-modal-recently-viewed-products' %}
{% render 'search-modal-trending-collections' %}
{% render 'search-modal-categories' %}
{% render 'search-modal-best-sellers-products' %}

{%- comment -%} ❌ BAD — 300 lines of mixed HTML in one section file {%- endcomment -%}
```

### 4. Block Rendering
All blocks are rendered via snippets. Snippet name matches block type. This works hand-in-hand with `{% render %}`'s scope isolation — each block gets a clean variable scope, preventing naming collisions between blocks and their parent section.

```liquid
{%- comment -%} Block type: hero-banner-slide → snippet: hero-banner-slide.liquid {%- endcomment -%}
{% render 'hero-banner-slide', block: block %}
```

### When NOT to Create a Snippet
- Don't extract tiny pieces (2-3 lines) into snippets — that adds overhead without readability benefit
- Don't create snippets that are only used once AND are short — keep them inline if under ~15 lines
- Over-extracting creates navigation overhead — developers have to jump between files to understand a simple piece of markup. The goal is readability, and sometimes 10 inline lines are clearer than a snippet call plus a separate file.

---

## Architectural Principles

### Section Independence
Independence means a section works correctly regardless of which page template it appears on, what other sections surround it, or what position it occupies. This is the foundation of Shopify's drag-and-drop section reordering in the theme editor.

Each section must be fully self-contained:
- Its own CSS file
- Its own JS file (if interactive)
- No dependency on another section's assets
- Works regardless of page template or position

### Template Structure (JSON)
Templates define which sections appear and in what order. Keep them thin — all customization happens at the section level through schema settings. Thin templates mean merchants control their store through the visual editor, not by requesting code changes. If customization logic lives in the template, it's only changeable by a developer.

### Settings Schema (config/settings_schema.json)
Theme-level settings go here for values used across the entire theme. Section-specific settings always go in the section's schema, not here. Putting section-specific settings in `settings_schema.json` creates hidden coupling — the section depends on a global setting that might be changed without understanding which sections use it.

---

## Checklist

Validate file structure and organization decisions against these.

### Naming
- [ ] Sections: `kebab-case.liquid`
- [ ] Templates: `kebab-case.json` (Online Store 2.0)
- [ ] Snippets: `kebab-case.liquid`
- [ ] CSS assets: `section-name-stylesheet.css`
- [ ] JS assets: `section-name-javascript.js`

### Snippet Decisions
- [ ] Blocks rendered via snippets (snippet name matches block type)
- [ ] SVGs/icons in snippets, never inline in sections
- [ ] Distinct functional areas extracted to snippets for readability
- [ ] No over-extraction of tiny (2-3 line) pieces
- [ ] No single-use short snippets (under ~15 lines)

### Architecture
- [ ] Each section is fully self-contained (own CSS, own JS)
- [ ] No section depends on another section's assets
- [ ] Templates are thin — customization at section level via schema
- [ ] Section-specific settings in section schema, not global settings_schema.json