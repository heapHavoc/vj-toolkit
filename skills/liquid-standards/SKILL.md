---
name: liquid-standards
description: Liquid standards for Shopify .liquid files — variable naming, tags, render vs include, filters, null checks, whitespace, performance.
user-invocable: false
---

# Liquid Coding Standards

## Variable Naming

Liquid's own filters and objects use snake_case (`featured_image`, `money_with_currency`), so matching that convention keeps code visually consistent. Descriptive names matter because Liquid has no type system — the variable name is the only documentation of what a value represents.

- Use `snake_case` for all Liquid variable names
- Use descriptive names: `product_card_image` not `img` or `pi`
- Prefix captures with their context: `hero_title`, `card_price`, not just `title`, `price`

## Liquid Tag Style
Use `{% liquid %}` for logic-heavy blocks (3+ lines of logic). Use individual tags for simple single conditions wrapping HTML.

The `{% liquid %}` tag reduces template noise in logic-heavy blocks by eliminating repeated `{%` `%}` delimiters, making the logic easier to scan. Individual tags work better for simple conditions because they keep the HTML structure visible.

```liquid
# Logic block — use {% liquid %}
{% liquid
  assign featured_image = product.featured_image
  assign has_variants = product.variants.size > 1
  assign price = product.price | money_with_currency
%}

# Simple condition wrapping HTML — use individual tags
{% if section.settings.title != blank %}
  <h2>{{ section.settings.title }}</h2>
{% endif %}
```

## Render, Never Include
Always use `{% render %}`. Never use `{% include %}` — it is deprecated and breaks scope isolation.

The `{% include %}` tag leaks the parent scope into the snippet — every variable from the calling template becomes accessible inside the snippet, making behavior unpredictable when the same snippet is rendered from different contexts. `{% render %}` creates a clean, isolated scope.

- Pass only what the snippet needs: `{% render 'product-card', product: product, show_price: true %}`
- Never rely on parent scope inside a snippet

## Snippet Documentation
Every snippet must have a `{% doc %}` tag at the top documenting its props:

Since `{% render %}` enforces scope isolation, the snippet's interface is its parameters. Without documentation, the only way to know what a snippet accepts is to read its implementation.

```liquid
{% doc %}
  @param {string} title - The card title
  @param {product} product - The product object
  @param {boolean} [show_price] - Whether to show price (optional)
{% enddoc %}
```

- Types must be **lowercase**: `{string}`, `{number}`, `{boolean}`, `{object}`
- Liquid object types are valid: `{product}`, `{collection}`, `{color}`, etc.
- Array types use `[]` suffix: `{string[]}`, `{product[]}`
- Required params listed without brackets
- Optional params wrapped in `[brackets]`
- Always include type and description

## Null & Empty Checks

Liquid silently outputs empty strings for nil values instead of raising errors. Without explicit checks, missing data produces broken or invisible markup that's hard to debug — an unchecked image outputs a broken `<img>` tag, an unchecked metafield renders nothing with no indication why.

- Use `{% if variable != blank %}` for strings and objects
- Use `{% if collection.products.size > 0 %}` for collections and arrays
- Metafields must always have a check: `{% if product.metafields.custom.field != blank %}`
- Never output an object without checking if it exists first

## Whitespace Control
Use `{%-` and `-%}` on logic tags to prevent blank lines in rendered HTML. Do NOT use on output tags.

Without whitespace control, Liquid tags generate blank lines in the rendered HTML wherever a tag appears on its own line. This bloats the HTML output and can cause layout issues with whitespace-sensitive elements.

```liquid
{%- if product.available -%}
  <span>{{ product.price | money }}</span>
{%- endif -%}

{%- for item in collection.products -%}
  {{ item.title }}
{%- endfor -%}
```

Logic tags that get whitespace control: `if`, `elsif`, `else`, `endif`, `for`, `endfor`, `assign`, `capture`, `endcapture`, `case`, `when`, `endcase`, `liquid`, `unless`, `endunless`, `render`.

Output tags `{{ }}` stay as-is without whitespace stripping.

## Filters

Filters transform output at render time. Getting them right prevents security issues (XSS from unescaped user content), broken images (manually constructed URLs miss CDN optimization), and inconsistent pricing display.

- Use `| escape` on any user-generated content
- Use `| image_url` for all image source URLs, never construct URLs manually
- Use `| money_with_currency` for prices unless design explicitly requires otherwise
- Chain filters readably — if more than 3 filters, break across lines:
  ```liquid
  {{ product.title
    | strip_html
    | truncate: 50
    | escape
  }}
  ```

## Comments
Always use Liquid comments `{% comment %}{% endcomment %}`. Never use HTML comments `<!-- -->`.

HTML comments are sent to the browser and visible in page source — they expose internal implementation details to anyone who views source, add to page weight, and can confuse screen readers. Liquid comments are stripped during rendering and never reach the client.

- Comment the WHY of complex logic, not the WHAT

## Liquid Logic
- Keep logic minimal in templates — complex business logic should go in snippets
- Avoid deeply nested if/else (max 3 levels). Extract to snippets if deeper
- Use `case/when` instead of long `if/elsif` chains

## Performance

Liquid runs server-side on every page load. Unlike JavaScript that runs once in the browser, expensive Liquid operations (deeply nested loops, unnecessary iterations) add latency to every single page view and directly impact Core Web Vitals.

- Avoid unnecessary `for` loops — Liquid loops are expensive
- Use `limit` and `offset` on collection loops when full iteration isn't needed
- Pass only needed variables to snippets — don't pass entire objects when you only need one property

## Checklist

Validate every `.liquid` file against these before committing.

### Variable Naming
- [ ] All variables use `snake_case`
- [ ] Names are descriptive — no single-letter or abbreviated names
- [ ] Captures prefixed with context: `hero_title`, not `title`

### Tag Style
- [ ] Logic-heavy blocks (3+ lines) use `{% liquid %}` tag
- [ ] Simple single conditions wrapping HTML use individual tags
- [ ] `{% render %}` used everywhere — no `{% include %}` anywhere

### Snippet Documentation
- [ ] Every snippet has a `{% doc %}` tag at the top
- [ ] Required params listed without brackets
- [ ] Optional params wrapped in `[brackets]`
- [ ] Each param has type and description

### Null & Empty Checks
- [ ] Strings and objects checked with `!= blank`
- [ ] Collections and arrays checked with `.size > 0`
- [ ] Metafields always have a nil/blank check before use
- [ ] No raw object output without existence check

### Whitespace Control
- [ ] Logic tags use `{%-` and `-%}` whitespace stripping
- [ ] Output tags `{{ }}` do NOT have whitespace stripping

### Filters
- [ ] User-generated content uses `| escape`
- [ ] Image URLs use `| image_url` — never manually constructed
- [ ] Prices use `| money_with_currency` unless design requires otherwise
- [ ] Long filter chains (3+) broken across lines

### Comments
- [ ] All comments use `{% comment %}` — no HTML `<!-- -->` comments
- [ ] Comments explain WHY, not WHAT

### Performance
- [ ] No unnecessary `for` loops
- [ ] Collection loops use `limit`/`offset` when full iteration not needed
- [ ] Snippets receive only needed variables, not entire objects
