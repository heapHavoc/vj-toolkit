# CSS Standards — Rules & Checklist

## Strict Rules
1. **Parent wrapper scoping**: Every child selector must start with the section's parent wrapper class (`.section-name .child`). Only the root block selector stands alone. Applies inside media queries too.
2. **Performance-aware loading**: Never bare `stylesheet_tag`. Above fold = `preload: true`. Below fold = `media="print" onload` lazy pattern.
3. **No decorative comments**: No header banners, no property group labels, no element descriptions.

## Rules
- Files: `assets/section-name-stylesheet.css`
- Class naming: BEM (`.section-name__element--modifier`), block name matches section name
- Property order: Layout → Flex/Grid → Sizing → Spacing → Typography → Visual → Effects
- Variables: `:root` custom properties for theme-wide values
- Schema-driven values: `style` attribute with CSS custom properties, never dynamic class names
- Responsive: mobile-first, `min-width` breakpoints only (320, 360, 475, 768, 1024, 1280, 1536)
- No arbitrary breakpoint values
- No inline `<style>` tags (exception: Liquid-generated dynamic CSS)
- Tailwind: class order matches property order, never mix with custom CSS on same element

## Checklist

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
- [ ] Layout → Flex/Grid → Sizing → Spacing → Typography → Visual → Effects → Responsive

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
