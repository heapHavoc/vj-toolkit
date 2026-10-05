---
name: section-standards
description: Section file structure and schema standards — file ordering, wrappers, block rendering, schema conventions, setting IDs, presets.
user-invocable: false
---

# Section Standards

## Section File Structure
Every section file follows this order from top to bottom:

1. **CSS** — Asset file call
2. **HTML** — Section markup
3. **JS** — Asset file call
4. **Schema** — `{% schema %}` block

```liquid
{%- comment -%} 1. CSS {%- endcomment -%}
{{ 'hero-banner-stylesheet.css' | asset_url | stylesheet_tag: preload: true }}

{%- comment -%} 2. HTML {%- endcomment -%}
<div class="hero-banner">
  {%- for block in section.blocks -%}
    {%- case block.type -%}
      {%- when 'hero-banner-slide' -%}
        {% render 'hero-banner-slide', block: block %}
    {%- endcase -%}
  {%- endfor -%}
</div>

{%- comment -%} 3. JS {%- endcomment -%}
<script src="{{ 'hero-banner.js' | asset_url }}" defer></script>

{%- comment -%} 4. Schema {%- endcomment -%}
{% schema %}
{
  "name": "Hero Banner",
  "class": "hero-banner-section",
  "settings": [],
  "blocks": [],
  "presets": [
    {
      "name": "Hero Banner"
    }
  ]
}
{% endschema %}
```

Keep this order consistently. CSS loads first so the section renders styled before JS executes — preventing flash of unstyled content (FOUC). Schema at the bottom keeps the data contract separate from the rendering logic, making both easier to scan and edit independently. JS loads after HTML so the DOM elements it targets already exist.

## Section Wrapper
Every section has a `<div>` wrapper. The wrapper class name matches the section filename exactly.

A consistent wrapper class matching the filename makes CSS scoping predictable — when you see `hero-banner.liquid`, you know the root class is `.hero-banner` without opening the file.

```
Section file: hero-banner.liquid     → class="hero-banner"
Section file: product-carousel.liquid → class="product-carousel"
Section file: testimonials.liquid     → class="testimonials"
```

```liquid
<div class="hero-banner">
  <!-- section content -->
</div>
```

No extra `id`, `data-` attributes, or additional tags on the wrapper unless the section's functionality specifically requires them.

Keeping the wrapper minimal prevents attribute bloat. Add `data-` attributes only when JS needs to read configuration from the DOM.

## Block Rendering
Extract blocks into snippets using `{% render %}`. Liquid's `{% render %}` tag creates an isolated scope, preventing variable name collisions between blocks and the parent section. It also keeps the section file scannable — a section with 5 block types stays under 30 lines of Liquid instead of ballooning to hundreds.

```liquid
{%- comment -%} ✅ GOOD — block rendered via snippet {%- endcomment -%}
{%- for block in section.blocks -%}
  {%- case block.type -%}
    {%- when 'hero-banner-slide' -%}
      {% render 'hero-banner-slide', block: block %}
  {%- endcase -%}
{%- endfor -%}

{%- comment -%} ❌ BAD — block HTML inline in section {%- endcomment -%}
{%- for block in section.blocks -%}
  {%- case block.type -%}
    {%- when 'hero-banner-slide' -%}
      <div class="hero-banner-slide">
        <img src="{{ block.settings.hero_banner_slide_desktop_image | image_url }}">
        <div>{{ block.settings.hero_banner_slide_content }}</div>
      </div>
  {%- endcase -%}
{%- endfor -%}
```

The snippet name should match the block type: block type `hero-banner-slide` → snippet `hero-banner-slide.liquid`.

## Section Settings vs Block Settings
This distinction matters because blocks are repeatable — merchants can add, remove, and reorder them in the theme editor. Section settings are fixed — one instance per section.

- **Section settings** — single, non-repeatable things that affect the entire section (background color, section heading, layout style)
- **Block settings** — repeatable content units (slides, cards, testimonials, FAQ items)

If a merchant might want more than one of it, it's a block. If there's only ever one, it's a section setting.

## Multiple Block Types
When a section has multiple block types, use `case/when` to render each:

The `case/when` pattern maps each block type to its snippet cleanly. It's more readable than chained `if/elsif` when there are 3+ block types, and it makes adding a new block type a one-line addition.

```liquid
{%- for block in section.blocks -%}
  {%- case block.type -%}
    {%- when 'hero-banner-slide' -%}
      {% render 'hero-banner-slide', block: block %}
    {%- when 'hero-banner-video' -%}
      {% render 'hero-banner-video', block: block %}
  {%- endcase -%}
{%- endfor -%}
```

## Section Independence
Independence means a section works correctly regardless of which page template it appears on, what other sections surround it, or what position it occupies. This is the foundation of Shopify's drag-and-drop section reordering.

Each section must be fully self-contained:
- No section should depend on another section's CSS or JS
- Sections should work regardless of page template or position
- Shared code goes in snippets, not duplicated across sections

---

## Section Schema Standards

### Schema Structure Order
Every section schema follows this order:
1. `name`
2. `class`
3. `settings`
4. `blocks`
5. `presets`

A consistent order makes schemas scannable across all sections — developers always know where to find settings vs blocks vs presets without scrolling through the entire schema.

### Character Length Limit
All schema identifier strings must be **under 25 characters**. This applies to:
- Section `name`
- Section `class`
- Block `type`
- Block `name`
- Preset `name`
- Setting `id`
- Setting `label`

Long names get truncated in the theme editor and cause readability issues. Keep them concise.

```
✅ "name": "Hero Banner"           (11 chars)
✅ "type": "banner-slide"           (12 chars)
✅ "id": "banner_heading"           (15 chars)
✅ "label": "Banner Heading"        (14 chars)

❌ "name": "Hero Banner With Video Background"   (34 chars)
❌ "id": "hero_banner_slide_desktop_image"        (33 chars)
❌ "label": "Hero Banner Slide Desktop Image"     (31 chars)
```

When prefixing creates IDs longer than 25 characters, use abbreviations:
```
✅ hero_slide_desk_img        (19 chars)  instead of  hero_banner_slide_desktop_image
✅ hero_slide_btn_text         (19 chars)  instead of  hero_banner_slide_button_text
✅ "Hero Slide Desk Image"    (21 chars)  instead of  "Hero Banner Slide Desktop Image"
```

### Section Name
- Use Title Case matching the section's purpose: `"name": "Hero Banner"`
- Must be under 25 characters

### Section Class
- Kebab-case with `-section` suffix
- Derived from the section name: `"class": "hero-banner-section"`
- Must be under 25 characters

The `-section` suffix distinguishes the Shopify-generated wrapper element from the section's internal CSS classes, preventing naming collisions with BEM block classes inside the section.

### Setting IDs
- Always `snake_case`
- Always prefix with section and block context — never use generic IDs

Shopify's theme editor flattens settings from all sections into a single namespace for metafield references and Liquid access. Generic IDs like `image` collide when multiple sections appear on the same page, while `hero_banner_slide_desktop_image` is instantly traceable to its source section. Prefixed IDs also make Liquid code self-documenting — `section.settings.hero_banner_heading` tells you exactly what you're accessing without checking the schema.

- The ID should read as: `section_block_element`

```
✅ banner_desk_image          (16 chars, prefixed, under 25)
✅ banner_slide_btn_text      (20 chars, prefixed, under 25)
✅ banner_slide_btn_url       (19 chars, prefixed, under 25)

❌ image                      (too generic)
❌ desktop_image              (too generic)
❌ button_text                (too generic)
❌ hero_banner_slide_desktop_image  (33 chars, over 25 limit)
```

### Setting Labels
- Use Title Case
- Always section-specific — never generic
- Label should mirror the ID in readable form

Labels appear in the Shopify theme editor where merchants customize their store. Section-specific labels like 'Hero Banner Slide Desktop Image' help merchants understand exactly which part of the page they're editing, while generic labels like 'Image' are ambiguous when the editor shows settings from multiple sections.

```
ID: banner_desk_image
Label: "Banner Desktop Image"

ID: banner_slide_btn_text
Label: "Banner Slide Btn Text"

❌ "Image"              (too generic)
❌ "Desktop Image"      (too generic)
❌ "Button Text"        (too generic)
```

### Setting Types — When to Use What
- `text` — short single-line content (headings, button text)
- `textarea` — multi-line content (descriptions)
- `richtext` — when merchants need basic formatting (bold, italic, links)
- `image_picker` — always prefer over URL fields for images
- `video` — for Shopify-hosted video
- `video_url` — for external video URLs (YouTube, Vimeo)
- `url` — for links; supports Shopify's link picker
- `select` — when there are 3-7 predefined options
- `checkbox` — for boolean on/off settings
- `range` — for numeric values with min/max
- `color` — for color pickers
- `color_scheme` — when integrating with theme color scheme system

Note: `richtext` outputs HTML — use it when the merchant needs bold/italic/links and you handle the HTML output in Liquid (usually rendering directly in a container). Use `textarea` when you want plain multi-line text without formatting markup. Use `text` for short single-line values that should never contain HTML.

### Settings Grouping Order
When a section has many settings, group them using `"header"` type in this order:
1. **Content** settings first (text, images, videos)
2. **Style** settings second (colors, layout options)
3. **Advanced** settings last (custom classes, visibility toggles)

### Settings Order Within Groups
Follow a logical flow within each group:
1. Media (images, videos) — desktop first, then mobile
2. Content (text, richtext)
3. Actions (button text, button URL)

### Blocks

#### Block Type
- Kebab-case: `"type": "banner-slide"`
- Must be under 25 characters

#### Block Name
- Title Case: `"name": "Banner Slide"`
- Block name and type must be the same — just different format (Title Case vs kebab-case)
- Must be under 25 characters

Matching names and types ensures the theme editor label corresponds exactly to what developers see in code. When a merchant sees 'Hero Banner Slide' in the editor and a developer sees `hero-banner-slide` in Liquid, there's zero ambiguity about what they're referring to.

- Name should be meaningful, derived from both the section name and block purpose

```
Section: "Hero Banner"
Block type: "banner-slide"          (12 chars)
Block name: "Banner Slide"          (12 chars)

Section: "Testimonials"
Block type: "testimonial-card"      (16 chars)
Block name: "Testimonial Card"      (16 chars)

❌ type: "slide"                    (too generic)
❌ name: "Slide"                    (too generic)
❌ type: "hero-banner-slide"        (17 chars OK, but prefer shorter)
```

#### Block Settings
Follow the same ID and label conventions as section settings. Prefix with the block context.

Block settings share the same flat namespace as section settings in the Shopify admin's internal APIs. The full context prefix prevents collisions between identically-named settings in different block types.

```
Block type: "banner-slide"
Setting ID: slide_desk_image         (16 chars)
Setting Label: "Slide Desk Image"    (16 chars)
```

### Presets
- Always define at least one preset

Presets make the section available in the theme editor's 'Add section' menu. Without a preset, the section exists in code but merchants cannot add it to pages through the editor — it becomes invisible to non-technical users.

- Preset name matches the section name exactly

```json
"presets": [
  {
    "name": "Hero Banner"
  }
]
```

### Complete Schema Example

```liquid
{% schema %}
{
  "name": "Hero Banner",
  "class": "hero-banner-section",
  "settings": [],
  "blocks": [
    {
      "type": "banner-slide",
      "name": "Banner Slide",
      "settings": [
        {
          "type": "image_picker",
          "id": "slide_desk_image",
          "label": "Slide Desktop Image"
        },
        {
          "type": "image_picker",
          "id": "slide_mob_image",
          "label": "Slide Mobile Image"
        },
        {
          "type": "video",
          "id": "slide_desk_video",
          "label": "Slide Desktop Video"
        },
        {
          "type": "video",
          "id": "slide_mob_video",
          "label": "Slide Mobile Video"
        },
        {
          "type": "richtext",
          "id": "slide_content",
          "label": "Slide Content"
        },
        {
          "type": "text",
          "id": "slide_btn_text",
          "label": "Slide Button Text"
        },
        {
          "type": "url",
          "id": "slide_btn_url",
          "label": "Slide Button URL"
        }
      ]
    }
  ],
  "presets": [
    {
      "name": "Hero Banner"
    }
  ]
}
{% endschema %}
```

---

## Checklist

Validate every section `.liquid` file against these.

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