# Section Standards — Rules & Checklist

## Section File Rules
- File order: CSS asset call → HTML → JS asset call → Schema
- Wrapper: `<div class="{section-name}">` — class matches filename exactly
- No extra attributes on wrapper unless JS functionality requires them
- Blocks: always rendered via `{% render %}` snippets, never inline HTML
- Snippet name matches block type (`hero-banner-slide` block → `hero-banner-slide.liquid`)
- Multiple block types: `case/when` pattern (not if/elsif)
- Section settings = non-repeatable (background, heading, layout)
- Blocks = repeatable content (slides, cards, testimonials)
- Each section fully self-contained: own CSS, own JS, no cross-section dependencies
- Shared code goes in snippets, not duplicated across sections

## Schema Rules
- Schema order: name → class → settings → blocks → presets
- **All identifiers under 25 characters** (name, class, IDs, labels, block types, block names, preset names)
- Section name: Title Case
- Section class: kebab-case + `-section` suffix
- Setting IDs: `snake_case` with section/block context prefix (never generic like `image` or `title`)
- Setting labels: Title Case, section-specific
- Setting types: text (short), textarea (multi-line), richtext (formatted HTML), image_picker, video, video_url, url, select (3-7 options), checkbox (boolean), range (numeric), color, color_scheme
- Groups order using headers: Content → Style → Advanced
- Within groups: Media first (desktop then mobile) → Content → Actions
- Block type: kebab-case, block name: Title Case, must match (different format only)
- Block settings follow same ID/label conventions with block context prefix
- Presets: always at least one, name matches section name exactly
- Use abbreviations when prefix makes IDs exceed 25 chars

## Checklist

### File Structure
- [ ] File order: CSS → HTML → JS → Schema
- [ ] Wrapper `<div>` class matches section filename
- [ ] No extra attributes on wrapper unless JS functionality requires them

### Block Rendering
- [ ] Blocks rendered via `{% render %}` snippets — NEVER inline HTML
- [ ] Snippet name matches block type
- [ ] `case/when` used for multiple block types (not if/elsif)

### Section Independence
- [ ] Section has its own CSS file
- [ ] Section has its own JS file (if interactive)
- [ ] No dependency on another section's assets
- [ ] Works regardless of page template or position

### Settings
- [ ] Repeatable content uses blocks, not section settings
- [ ] Non-repeatable content uses section settings, not blocks

### Schema Structure
- [ ] Schema order: name, class, settings, blocks, presets
- [ ] Section name: Title Case
- [ ] Section class: kebab-case with `-section` suffix

### Character Length (all under 25 characters)
- [ ] Section name: under 25 chars
- [ ] Section class: under 25 chars
- [ ] All setting IDs: under 25 chars (use abbreviations if prefix makes it long)
- [ ] All setting labels: under 25 chars
- [ ] All block types: under 25 chars
- [ ] All block names: under 25 chars
- [ ] Preset name: under 25 chars

### Setting IDs & Labels
- [ ] All IDs use `snake_case` with section/block context prefix
- [ ] No generic IDs (`image`, `title`, `text`)
- [ ] All labels use Title Case
- [ ] Labels are section-specific, never generic

### Blocks
- [ ] Block type: kebab-case
- [ ] Block name: Title Case
- [ ] Block name and type match (different format only)
- [ ] Block settings follow same ID/label conventions with block context prefix

### Presets
- [ ] At least one preset defined
- [ ] Preset name matches section name
