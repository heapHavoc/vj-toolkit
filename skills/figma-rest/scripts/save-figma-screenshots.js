#!/usr/bin/env node
/**
 * save-figma-screenshots.js — Download Figma node screenshots via REST API
 *
 * The Figma MCP `get_screenshot` returns images inline (base64) — Claude can
 * view them in conversation but cannot write the bytes to disk. This script
 * uses the Figma REST API to export nodes as PNGs and save them directly.
 *
 * Usage:
 *   node save-figma-screenshots.js \
 *     --file-key <figma-file-key> \
 *     --feature <feature-name> \
 *     --nodes '[{"id":"1:2","name":"hero-desktop"},{"id":"3:4","name":"hero-mobile"}]' \
 *     [--scale 2]
 *
 *   or take the sections straight from extract-figma-sections.js:
 *     --from-index desktop|mobile   (reads figma-dumps/{viewport}-index.json)
 *
 * Requires: FIGMA_TOKEN environment variable (Personal Access Token)
 *   Create one at: https://www.figma.com/developers/api#access-tokens
 *
 * Output: .buildspace/artifacts/{feature}/screenshots/figma-{name}.png
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { requireToken, parseFlags, httpGet, figmaApi, chunk, artifactsDir } = require('./lib/figma');

// ── Args ────────────────────────────────────────────────────────

function parseArgs() {
  const flags = parseFlags();
  const fileKey = flags['file-key'];
  const feature = flags.feature;
  const fromIndex = flags['from-index'];
  const scale = flags.scale || '1';

  if (!fileKey || !feature || (!flags.nodes && !fromIndex)) {
    console.error(
      'Usage: save-figma-screenshots.js --file-key <key> --feature <name> (--nodes \'[{"id":"1:2","name":"hero-desktop"}]\' | --from-index desktop|mobile) [--scale 2]'
    );
    process.exit(1);
  }

  const token = requireToken();

  let nodes;
  if (fromIndex) {
    const indexPath = path.join(artifactsDir(feature), 'figma-dumps', `${fromIndex}-index.json`);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    nodes = index.sections
      .filter((s) => !s.skipped)
      .map((s) => ({ id: s.figmaNodeId, name: `${s.name}-${index.viewport}`, ...(s.transparent ? { format: 'jpg' } : {}) }));
  } else {
    try {
      nodes = JSON.parse(flags.nodes);
    } catch (err) {
      console.error(`Error: Invalid JSON for --nodes: ${err.message}`);
      process.exit(1);
    }
  }

  for (const n of nodes) {
    if (!n.id || !n.name) {
      console.error(`Error: Each node needs "id" and "name". Got: ${JSON.stringify(n)}`);
      process.exit(1);
    }
  }

  return { fileKey, feature, nodes, scale, token };
}

// ── Figma API ───────────────────────────────────────────────────

async function getImageUrls(fileKey, nodeIds, scale, token, format = 'png') {
  const ids = nodeIds.join(',');
  const apiPath = `/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=${format}&scale=${scale}`;

  console.error(`[figma-save] Requesting image export for ${nodeIds.length} node(s)...`);

  const json = await figmaApi(apiPath, token);
  return json.images; // { "nodeId": "https://..." }
}

async function downloadImage(url, filepath) {
  const { buffer } = await httpGet(url, {});
  await writeFile(filepath, buffer);
  return buffer.length;
}

// ── Batching ────────────────────────────────────────────────────

const BATCH_SIZE = 3; // Figma render timeout hits at ~4+ large nodes at 2x


// ── Main ────────────────────────────────────────────────────────

async function main() {
  const { fileKey, feature, nodes, scale, token } = parseArgs();

  const outputDir = path.resolve(`.buildspace/artifacts/${feature}/screenshots`);
  await mkdir(outputDir, { recursive: true });

  console.error(`[figma-save] Feature: ${feature}`);
  console.error(`[figma-save] File key: ${fileKey}`);
  console.error(`[figma-save] Scale: ${scale}x`);
  console.error(`[figma-save] Nodes: ${nodes.map((n) => n.name).join(', ')}`);
  console.error(`[figma-save] Batch size: ${BATCH_SIZE}`);

  const results = [];
  const byFormat = new Map();
  for (const n of nodes) byFormat.set(n.format ?? 'png', [...(byFormat.get(n.format ?? 'png') ?? []), n]);
  const batches = [...byFormat.values()].flatMap((group) => chunk(group, BATCH_SIZE));

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNodeIds = batch.map((n) => n.id);

    console.error(`[figma-save] Batch ${i + 1}/${batches.length}: ${batch.map((n) => n.name).join(', ')}`);

    let imageUrls;
    try {
      imageUrls = await getImageUrls(fileKey, batchNodeIds, scale, token, batch[0].format ?? 'png');
    } catch (err) {
      console.error(`[figma-save] Batch ${i + 1} API failed: ${err.message}`);
      for (const node of batch) {
        results.push({ name: node.name, id: node.id, status: 'FAILED', error: err.message });
      }
      continue;
    }

    for (const node of batch) {
      const url = imageUrls[node.id];
      if (!url) {
        console.error(`[figma-save] ${node.name}: no image URL returned — skipped`);
        results.push({ name: node.name, id: node.id, status: 'NO_URL' });
        continue;
      }

      const filename = `figma-${node.name}.${node.format ?? 'png'}`;
      const filepath = path.join(outputDir, filename);

      try {
        const bytes = await downloadImage(url, filepath);
        results.push({ name: node.name, id: node.id, filename, status: 'SAVED', bytes });
        console.error(`[figma-save] ${node.name}: saved ${filename} (${(bytes / 1024).toFixed(1)}KB)`);
      } catch (err) {
        results.push({ name: node.name, id: node.id, status: 'FAILED', error: err.message });
        console.error(`[figma-save] ${node.name}: FAILED — ${err.message}`);
      }
    }
  }

  const saved = results.filter((r) => r.status === 'SAVED').length;
  const failed = results.filter((r) => r.status !== 'SAVED').length;

  console.error(`[figma-save] Done: ${saved} saved, ${failed} failed/skipped`);

  const manifest = {
    feature,
    fileKey,
    scale,
    timestamp: new Date().toISOString(),
    results,
  };

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(`[figma-save] Fatal: ${err.message}`);
  process.exit(1);
});
