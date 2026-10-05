---
name: figma
description: >
  Extract structured design context from Figma via the official MCP server.
  Captures layout, typography, colors, spacing, and screenshots.
  Use as the first step when building from a Figma design.
disable-model-invocation: true
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, mcp__figma__get_design_context, mcp__figma__get_screenshot, mcp__figma__get_metadata, mcp__figma__get_variable_defs
---

# Figma — Design Context Extraction

You are entering the Figma phase. Your job is to extract structured design context from a Figma frame using the official Figma MCP server, save it as artifacts, and hand off to the pipeline. Do NOT write implementation code. Do NOT plan implementation.

## Input
The Figma URLs: `$ARGUMENTS`

Expected format:
```
Desktop: <figma-url>
Mobile: <figma-url>
```

If both URLs are not provided, ask the user for both before proceeding. If the user says there is no mobile frame, proceed with desktop only.

---

## Step 1: Check Credentials & Validate MCP

**MANDATORY FIRST ACTION — run this bash command before doing anything else:**

```bash
echo "=== Credential Check ==="
if [ -n "$FIGMA_TOKEN" ]; then
  echo "FIGMA_TOKEN: set (env)"
elif [ -f .env ] && grep -q '^FIGMA_TOKEN=' .env; then
  echo "FIGMA_TOKEN: set (.env file)"
else
  echo "FIGMA_TOKEN: NOT FOUND"
fi

if [ -n "$SHOPIFY_STORE" ]; then
  echo "SHOPIFY_STORE: set (env)"
elif [ -f .env ] && grep -q '^SHOPIFY_STORE=' .env; then
  echo "SHOPIFY_STORE: set (.env file)"
else
  echo "SHOPIFY_STORE: not set (upload step will be skipped)"
fi

if [ -n "$SHOPIFY_ADMIN_TOKEN" ]; then
  echo "SHOPIFY_ADMIN_TOKEN: set (env)"
elif [ -f .env ] && grep -q '^SHOPIFY_ADMIN_TOKEN=' .env; then
  echo "SHOPIFY_ADMIN_TOKEN: set (.env file)"
else
  echo "SHOPIFY_ADMIN_TOKEN: not set (upload step will be skipped)"
fi
```

**You MUST run this check and read its output before proceeding.** Do NOT skip it. Do NOT try MCP calls first.

If `FIGMA_TOKEN` is NOT FOUND, stop and tell the user:
```
FIGMA_TOKEN is required to save Figma screenshots to disk.
1. Go to: https://www.figma.com/developers/api#access-tokens
2. Create a Personal Access Token
3. Add it to your project's .env file: FIGMA_TOKEN="your-token-here"
```
Wait for the user to add the token before continuing.

> **Note:** The screenshot and asset scripts have a built-in `.env` loader — they will
> read from `.env` automatically. You do NOT need to `source .env` before running them.

**After credentials are confirmed**, check that Figma MCP tools are available by calling `get_design_context` or `get_metadata`.

If the MCP tools are not available, stop and tell the user:
```
Figma MCP server not connected.
Run this command to add it:
  claude mcp add --transport http figma https://mcp.figma.com/mcp
Then restart Claude Code and authenticate via the browser when prompted.
Requires Figma Pro plan or higher for practical use (free plan = 6 calls/month).
```

Parse each Figma URL to extract:
- `fileKey` — from the URL path (e.g., `figma.com/design/{fileKey}/...`)
- `nodeId` — from the `node-id` query parameter (replace `-` with `:`)

---

## Step 2: Derive Feature Name

Derive a short kebab-case feature name from the design (e.g., `hero-banner`, `product-carousel`).

Use `Glob('.buildspace/artifacts/*/design-context.md')` to check for existing features. If one exists with the same name, confirm with the user that they want to overwrite it.

Create the artifacts directory and save the active feature name:
```bash
mkdir -p .buildspace/artifacts/{feature-name}/screenshots
echo "{feature-name}" > .buildspace/current-feature
```

---

## Step 3: Fetch Design Context (MCP)

Call `get_design_context(fileKey, nodeId)` for the desktop frame. This returns structured design data including:
- Layout hierarchy (flex/grid direction, alignment, gap, padding)
- Typography (font family, size, weight, line-height, color)
- Colors (exact hex/rgba values for backgrounds, text, borders, accents)
- Spacing (padding, margin, gap values)
- Component structure and nesting

If the response is truncated (large/complex design), use `get_metadata(fileKey, nodeId)` to get the node tree, then call `get_design_context` on individual child nodes.

If a mobile URL was provided, repeat for the mobile frame.

Optionally call `get_variable_defs()` to capture design tokens/variables defined in the Figma file.

---

## Step 4: Capture & Save Screenshots (Section by Section)

> **Why a script?** The MCP `get_screenshot` returns images inline in conversation —
> Claude can *view* them but cannot write the raw bytes to disk. This script uses
> the Figma REST API to export and download node images as PNG files.

> **Always capture section-by-section, not full-page.** Section-level screenshots are
> what the `/compare` step needs to match against code screenshots. Full-page captures
> also hit Figma's render timeout at 2x scale.

### 4a: Identify section node IDs

Call `get_metadata(fileKey, nodeId)` on the top-level frame to get the node tree. Identify the **direct child nodes** — these are the sections.

Skip Header and Footer nodes (unless the user explicitly asks for them).

### 4b: Build the nodes list

Build a JSON array with one entry per section. Each entry needs:
- `id` — the Figma node ID (e.g., `"49:376"`)
- `name` — kebab-case section name + viewport suffix (e.g., `"banner-desktop"`, `"tiers-desktop"`)

Example for desktop sections:
```json
[
  {"id": "49:376", "name": "banner-desktop"},
  {"id": "49:392", "name": "quote-desktop"},
  {"id": "49:394", "name": "how-it-works-desktop"}
]
```

If a mobile URL was provided, create a separate list with mobile node IDs:
```json
[
  {"id": "50:100", "name": "banner-mobile"},
  {"id": "50:110", "name": "quote-mobile"}
]
```

**Do NOT include a full-page entry.** Only individual sections.

### 4c: Run the save script

The script auto-batches nodes (3 per API call) to avoid Figma render timeouts.

For desktop sections:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/save-figma-screenshots.js \
  --file-key "{desktop-fileKey}" \
  --feature "{feature}" \
  --scale 2 \
  --nodes '{desktop-nodes-json}'
```

If mobile uses a different file key, run a second call:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/save-figma-screenshots.js \
  --file-key "{mobile-fileKey}" \
  --feature "{feature}" \
  --scale 2 \
  --nodes '{mobile-nodes-json}'
```

Output in `.buildspace/artifacts/{feature}/screenshots/`:
- `figma-{section}-desktop.png` — one per desktop section
- `figma-{section}-mobile.png` — one per mobile section (if provided)

### 4d: Write sections.json

After screenshots are saved, write `.buildspace/artifacts/{feature}/sections.json` — this is the **single source of truth** for section naming across the entire pipeline (`/plan`, `/execute`, `/compare`).

```json
[
  {
    "name": "banner",
    "figmaNodeId": "49:376",
    "figmaName": "BANNER",
    "screenshots": {
      "desktop": "screenshots/figma-banner-desktop.png",
      "mobile": "screenshots/figma-banner-mobile.png"
    }
  }
]
```

- `name` — kebab-case canonical name. This is what `/execute` uses in `selectors.json` and `/compare` uses for matching.
- `figmaNodeId` — the Figma node ID for this section
- `figmaName` — original name from the Figma layer tree
- `screenshots.desktop` — path to saved desktop screenshot (always present)
- `screenshots.mobile` — path to saved mobile screenshot (present only if mobile URL was provided, otherwise omit)

**Omit Header and Footer** from sections.json — they are not built or compared.

### 4e: Verify & display

After the script runs, use the `Read` tool to open each saved screenshot and present them to the user for visual review. If any node failed to export, report the error and try `get_screenshot(fileKey, nodeId)` via MCP as a fallback (inline-only, won't save to disk).

---

## Step 5: Discover & Download Image Assets

> **Why?** Designs contain uploaded images (hero photos, product shots, backgrounds)
> that are needed during implementation. This step downloads the originals from Figma
> so `/execute` can reference real assets instead of placeholders.

### 5a: Run the asset discovery & download script

The script auto-discovers IMAGE fills in each section, downloads the originals from
Figma's image fill API, and saves them to `figmaAssets/`. It batches downloads (3
concurrent) to respect rate limits.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/save-figma-assets.js \
  --file-key "{desktop-fileKey}" \
  --feature "{feature}" \
  --node-id "{desktop-top-level-nodeId}"
```

If mobile uses a **different file key**, run a second call with the mobile file key and node ID. If mobile is in the same file, the desktop call already covers it (images are discovered by walking all sections in the frame).

The script:
1. Fetches the node tree via `GET /v1/files/:key/nodes`
2. Walks each section's descendants for fills with `type: "IMAGE"`
3. Skips Header/Footer sections (same rule as screenshots)
4. Deduplicates by `imageRef` within each section
5. Fetches download URLs via `GET /v1/files/:key/images`
6. Downloads and saves with names: `{section}-image-{n}.{ext}`
7. Outputs the manifest JSON to stdout

### 5b: Save assets-manifest.json

Capture the script's stdout and save it to `.buildspace/artifacts/{feature}/assets-manifest.json`.

The manifest is a JSON array:
```json
[
  {
    "name": "hero-image-1",
    "section": "hero",
    "file": "figmaAssets/hero-image-1.jpg",
    "imageRef": "abc123def",
    "sourceNode": "49:382",
    "sourceNodeName": "Hero Photo"
  }
]
```

If the script found zero images, save an empty array `[]` — this is not an error.

### 5c: Report to user

Tell the user how many image assets were found and downloaded, grouped by section.
If zero images found, note it and move on — not all designs have image fills.

---

## Step 6: Upload Assets to Shopify

> **Why?** Template JSON `image_picker` settings need Shopify-hosted file URLs.
> Uploading assets to Shopify Files (Settings > Files) ensures images are CDN-backed
> and available when the theme is deployed — no manual upload step for the merchant.

### 6a: Check Shopify credentials

Check both environment variables AND the `.env` file:
```bash
check_var() {
  local var_name=$1
  if [ -n "${!var_name}" ]; then
    echo "$var_name: set (env)"
  elif [ -f .env ] && grep -q "^${var_name}=" .env; then
    echo "$var_name: set (.env file)"
  else
    echo "$var_name: NOT FOUND"
  fi
}
check_var SHOPIFY_STORE
check_var SHOPIFY_ADMIN_TOKEN
```

Only if either is NOT FOUND in both locations, tell the user:
```
Shopify credentials are required to upload assets to your store.

1. Go to your Shopify admin: Settings > Apps and sales channels > Develop apps
2. Click "Create an app" (or use an existing dev app)
3. Under "Configuration" > "Admin API integration", enable these scopes:
   - write_files
   - read_files
4. Click "Install app" and copy the Admin API access token
5. Add to your .env file:

   SHOPIFY_STORE=your-store.myshopify.com
   SHOPIFY_ADMIN_TOKEN=shpat_xxxxx
```

> **Note:** The upload script has a built-in `.env` loader — it will read credentials
> from `.env` automatically. You do NOT need to `source .env` before running it.

If `assets-manifest.json` is empty (no image assets were downloaded in Step 5), skip this step entirely and move to Step 7.

### 6b: Confirm assets with user

Present the downloaded assets for review before uploading:
- List each asset: name, section, file path
- Use the `Read` tool to show image thumbnails inline

Then ask the user:
```
These [N] image assets will be uploaded to your Shopify store's Files (Settings > Files).
Confirm to proceed, or let me know if you'd like to exclude any.
```

Wait for the user's response:
- **User confirms** → proceed to 6c
- **User excludes assets** → remove those entries from `assets-manifest.json`, then proceed
- **User declines** → skip upload entirely, move to Step 7

### 6c: Run upload script

```bash
node ${CLAUDE_SKILL_DIR}/scripts/upload-shopify-assets.js \
  --feature "{feature}"
```

The script:
1. Reads `assets-manifest.json`
2. Skips entries that already have `shopifyUrl` (safe to re-run)
3. Calls `stagedUploadsCreate` to get presigned upload URLs (batches of 3)
4. Uploads files via multipart POST to the staged targets
5. Calls `fileCreate` to register files in Shopify
6. Polls until files reach `READY` status
7. Outputs the updated manifest JSON to stdout

### 6d: Update manifest

Capture the script's stdout to a **temp file first**, then replace the manifest. Do NOT redirect stdout directly to `assets-manifest.json` — the script reads that same file, so a direct redirect would truncate it before the script can read it.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/upload-shopify-assets.js \
  --feature "{feature}" > /tmp/assets-manifest-updated.json
# Only replace if the script succeeded (exit code 0)
cp /tmp/assets-manifest-updated.json .buildspace/artifacts/{feature}/assets-manifest.json
```

Alternatively, capture the stdout in the conversation and use the Write tool to save the updated manifest. Logs are written to stderr, JSON manifest to stdout — do not mix them with `2>&1`.

The updated entries now include Shopify fields:
```json
{
  "name": "hero-image-1",
  "section": "hero",
  "file": "figmaAssets/hero-image-1.jpg",
  "imageRef": "abc123def",
  "sourceNode": "49:382",
  "sourceNodeName": "Hero Photo",
  "shopifyUrl": "https://cdn.shopify.com/s/files/1/xxxx/files/hero-image-1.jpg",
  "shopifyFileId": "gid://shopify/MediaImage/12345",
  "shopifyRef": "shopify://shop_images/hero-image-1.jpg"
}
```

- `shopifyUrl` — full CDN URL (for previews, debugging)
- `shopifyRef` — Shopify internal reference (for template JSON `image` values)

### 6e: Report

Tell the user:
- How many assets were uploaded successfully (with CDN URLs)
- Any failures and their errors
- If some files are still processing, note their `shopifyFileId` for manual check

---

## Step 7: Write design-context.md

Assemble all MCP data into `.buildspace/artifacts/{feature}/design-context.md`:

```markdown
# Design Context: {feature-name}

## Source
- Desktop: {figma-url}
- Mobile: {figma-url or "None"}
- Extracted: {timestamp}

## Design Tokens
| Token | Value | Usage |
|-------|-------|-------|
| {name} | {value} | {where it's used} |

## Sections

### {Section Name}

**Screenshots:**
- Desktop: `screenshots/figma-{section}-desktop.png`
- Mobile: `screenshots/figma-{section}-mobile.png`

**Layout:**
- Direction: {row/column}
- Alignment: {start/center/end}
- Gap: {value}
- Padding: {values}
- Max width: {value}

**Typography:**
| Element | Font | Size | Weight | Line Height | Color |
|---------|------|------|--------|-------------|-------|

**Colors:**
| Role | Value |
|------|-------|

**Spacing:**
| Property | Desktop | Mobile |
|----------|---------|--------|

**Elements:**
{Structured hierarchy of components in this section with key visual properties}

## Image Assets
See `assets-manifest.json` for full details.

| Asset | Section | File | Shopify URL |
|-------|---------|------|-------------|
| {name} | {section} | {file path} | {shopifyUrl or "—"} |
```

Fill every table with the actual values from the MCP response. Do not leave placeholders. If a value was not available from the MCP, omit the row rather than guessing.

For the Image Assets table, read `assets-manifest.json` and list each saved asset. If the manifest is empty (no image fills found), omit the Image Assets section entirely.

---

## Step 8: Present & Hand Off

Show the user:
1. Number of sections found
2. Each section screenshot for visual review
3. Key design values discovered (primary colors, fonts, notable spacing)
4. Number of image assets downloaded (if any), grouped by section

Then tell the user:
```
Design context extracted and saved.
- .buildspace/artifacts/{feature}/design-context.md — structured design specs
- .buildspace/artifacts/{feature}/sections.json — canonical section names (used by /execute and /compare)
- .buildspace/artifacts/{feature}/screenshots/ — visual references (section-by-section)
- .buildspace/artifacts/{feature}/assets-manifest.json — image asset references with Shopify CDN URLs (used by /execute)
- .buildspace/artifacts/{feature}/figmaAssets/ — downloaded image fills (local copies)
```

### Next Step
Tell the user:
```
→ Run /clarify to define requirements for this feature.
  Remaining: /clarify → /plan → /execute → /compare → /assess
```

**Context tip:** You can `/clear` before the next step — all data is in artifacts, not conversation.

---

## Rules
- Never write implementation code — this skill only extracts design context
- Never guess design values — only record what the MCP returns
- If an MCP call fails, report the error clearly with the suggested fix
- Present all section screenshots to the user for visual review
- Overwrite existing artifacts if re-running for the same feature
