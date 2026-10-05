---
name: css-standards
description: CSS standards for Shopify themes — BEM naming, section scoping, property ordering, responsive breakpoints, variables, loading strategy.
user-invocable: false
---

# CSS Standards

Covers both Tailwind CSS (scratch themes) and pure CSS (Dawn-based themes). Core conventions below apply to both. Tailwind-specific rules are at the end.

---

## Strict Rules

### 1. Parent Wrapper Scoping

Every CSS selector except the root block itself must begin with the section's parent wrapper class as a descendant selector. The parent wrapper class matches the section filename (`hero-banner.liquid` → `.hero-banner`). This applies inside media queries too.

Shopify sections can appear on any page in any order — unscoped selectors break when sections share similar class names.

```css
/* ✅ Correct — every child selector starts with the parent wrapper */
.home-stress {
    display: flex;
    flex-direction: column;
    gap: 2rem;
}

.home-stress .home-stress-container {
    display: flex;
    gap: 3rem;
    width: 100%;
}

.home-stress .home-stress-header .section-heading,
.home-stress .home-stress-header .section-details {
    text-align: center;
    margin-bottom: 3rem;
}

.home-stress .hourglass-image-container img {
    display: block;
    width: 25rem;
    height: 100%;
}

@media (min-width: 768px) {
    .home-stress .home-stress-container {
        justify-content: space-between;
        gap: 0;
    }

    .home-stress .home-stress-content {
        flex: 2;
        margin-top: 1rem;
    }
}

/* ❌ Wrong — child selector without parent wrapper */
.home-stress-container {
    display: flex;
}

/* ❌ Wrong — unscoped generic class */
.section-heading {
    text-align: center;
}
```

Only truly generic page-level CSS that is intentionally shared across sections can exist without a parent scope.

### 2. Performance-Aware CSS Loading

Never use bare `{{ file | asset_url | stylesheet_tag }}` — it is render-blocking. Every CSS file must use a loading strategy based on fold position.

Above the fold — preload:
```liquid
{{ 'hero-banner-stylesheet.css' | asset_url | stylesheet_tag: preload: true }}
```

Below the fold — lazy load (non-blocking):
```liquid
{%- assign css_url = 'testimonials-stylesheet.css' | asset_url -%}
<link rel="stylesheet" href="{{ css_url }}" media="print" onload="this.onload=null;this.media='all';">
<noscript><link rel="stylesheet" href="{{ css_url }}"></noscript>
```

### 3. No Decorative Comments

Do not add comments to CSS files. No header banners, no property group labels, no element descriptions.

```css
/* ❌ Wrong */
/* ========== Hero Banner Section ========== */
/* Block */
.hero-banner { ... }
/* Desktop */
@media (min-width: 768px) { ... }

/* ✅ Correct */
.hero-banner {
    display: flex;
    flex-direction: column;
}

@media (min-width: 768px) {
    .hero-banner .hero-banner__content {
        flex: 2;
    }
}
```

---

## File Convention

CSS lives in asset files (`assets/` directory), not inline `<style>` tags. The only exception is CSS dynamically generated from Liquid values.

Browser caching requires external files — inline `<style>` tags are re-parsed on every page load.

Section-specific CSS files follow this format:
```
section-name-stylesheet.css
```

---

## Class Naming

Use BEM (Block Element Modifier) for all class names. The block name matches the section name.

```
.section-name                     — Block (root selector, stands alone)
.section-name__element            — Element
.section-name__element--modifier  — Modifier
```

BEM naming does not exempt you from parent wrapper scoping (see Strict Rule 1). Even with BEM names, all child selectors include the parent wrapper:

```css
/* ✅ Correct — BEM names with parent wrapper */
.hero-banner {
    display: flex;
}

.hero-banner .hero-banner__content {
    flex: 1;
}

.hero-banner .hero-banner__image--rounded {
    border-radius: 1rem;
}

/* ❌ Wrong — BEM names without parent wrapper */
.hero-banner__content {
    flex: 1;
}
```

---

## CSS Property Ordering

Order properties from outside-in, mirroring the browser's box model:

1. **Layout** — display, position, top/right/bottom/left, z-index, float, clear
2. **Flexbox/Grid** — flex, flex-direction, align-items, justify-content, grid-template, gap
3. **Sizing** — width, height, min-width, max-width, min-height, max-height
4. **Spacing** — margin, padding
5. **Typography** — font-family, font-size, font-weight, line-height, letter-spacing, text-align, color
6. **Visual** — background, border, border-radius, box-shadow, opacity
7. **Effects** — transform, transition, animation
8. **Responsive** — media queries at the bottom

```css
.hero-banner {
    display: flex;
    position: relative;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 500px;
    padding: 3rem 1.5rem;
    text-align: center;
    color: #1a1a1a;
    background-color: #ffffff;
    border-radius: 8px;
}
```

---

## Variables and Dynamic Values

Create CSS custom properties at `:root` for theme-wide values (spacing, fonts, colors). Use these in section CSS rather than hard-coding values.

```css
:root {
    --section-spacing-sm: 2rem;
    --section-spacing-md: 4rem;
    --section-spacing-lg: 6rem;
    --font-heading: var(--font-heading-family);
    --font-body: var(--font-body-family);
}
```

When section settings need to affect styles, use the `style` attribute with CSS custom properties. Never construct class names dynamically.

```liquid
<section
  class="hero-banner"
  style="--hero-bg: {{ section.settings.background_color }}; --hero-padding: {{ section.settings.padding }}px;"
>
```

```css
.hero-banner {
    background-color: var(--hero-bg);
    padding: var(--hero-padding);
}
```

---

## Responsive Approach

Mobile-first always. Base styles are mobile, add `min-width` breakpoints for larger screens. This produces smaller CSS and ensures the mobile experience works even if a breakpoint is missed.

### Breakpoints
```
xxs: 320px    xs: 360px    sm: 475px    md: 768px
lg:  1024px   xl: 1280px   2xl: 1536px
```

Always use these exact values — never arbitrary values like `750px` or `990px`.

```css
.hero-banner {
    padding: 1.5rem;
    font-size: 1.25rem;
}

@media (min-width: 768px) {
    .hero-banner {
        padding: 3rem;
        font-size: 2rem;
    }
}

@media (min-width: 1024px) {
    .hero-banner {
        padding: 4rem;
        font-size: 2.5rem;
    }
}
```

---

## Tailwind (Scratch Themes Only)

Class ordering matches the CSS property order: Layout → Sizing → Spacing → Typography → Colors → Borders → Effects → Responsive variants last.

Extend the default config with project-specific tokens. Don't fight the defaults.

Never mix Tailwind classes and custom CSS classes on the same element — pick one approach per element.

---

## Checklist

Validate every CSS file against these before committing.

### File Convention
- [ ] CSS lives in `assets/` directory, not inline `<style>` tags
- [ ] File named `section-name-stylesheet.css`
- [ ] No bare `{{ file | asset_url | stylesheet_tag }}` — use performance-aware loading
- [ ] Above-fold sections use `preload` (`stylesheet_tag: preload: true`)
- [ ] Below-fold sections use lazy loading (`media="print"` + `onload` pattern)

### Comments
- [ ] No decorative header banners or separator comments
- [ ] No property group labels (`/* Block */`, `/* Desktop */`)
- [ ] No element description comments

### Class Naming
- [ ] All classes follow BEM: `.block__element--modifier`
- [ ] Block name matches the section name
- [ ] Names are semantic and descriptive

### Scoping
- [ ] Every child selector starts with the parent wrapper class (`.parent .child`)
- [ ] Only the root block selector (`.section-name`) stands alone
- [ ] Same parent wrapper rule applies inside media queries
- [ ] No standalone child selectors, even with BEM names
- [ ] No unscoped generic selectors (`.title`, `.container`)

### Property Ordering
- [ ] Layout properties first (display, position, z-index)
- [ ] Flexbox/Grid second (flex, align, justify, gap)
- [ ] Sizing third (width, height, min/max)
- [ ] Spacing fourth (margin, padding)
- [ ] Typography fifth (font, text, color)
- [ ] Visual sixth (background, border, shadow, opacity)
- [ ] Effects seventh (transform, transition, animation)
- [ ] Responsive last (media queries at the bottom)

### Variables
- [ ] Theme-wide values use CSS custom properties from `:root`
- [ ] No hard-coded colors/fonts that should come from theme settings
- [ ] Schema-driven values use `style` attribute with custom properties

### Responsive
- [ ] Mobile-first: base styles are mobile, breakpoints enhance
- [ ] Standard breakpoints used (320, 360, 475, 768, 1024, 1280, 1536)
- [ ] No arbitrary breakpoint values

### Tailwind (if applicable)
- [ ] Class ordering matches property ordering convention
- [ ] No mixing of Tailwind utilities and custom CSS on same element
- [ ] Tailwind config extended for project-specific tokens
