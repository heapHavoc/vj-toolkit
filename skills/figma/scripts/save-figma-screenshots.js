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
 * Requires: FIGMA_TOKEN environment variable (Personal Access Token)
 *   Create one at: https://www.figma.com/developers/api#access-tokens
 *
 * Output: .buildspace/artifacts/{feature}/screenshots/figma-{name}.png
 */

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

// ── .env loader (zero dependencies) ────────────────────────────

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Don't override existing env vars
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — that's fine, fall through to env var check
  }
}

loadEnv();

// ── Args ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };

  const fileKey = get('--file-key');
  const feature = get('--feature');
  const nodesJson = get('--nodes');
  const scale = get('--scale') || '2';  // 2x matches capture-sections.js DEVICE_SCALE

  if (!fileKey || !feature || !nodesJson) {
    console.error(
      'Usage: save-figma-screenshots.js --file-key <key> --feature <name> --nodes \'[{"id":"1:2","name":"hero-desktop"}]\' [--scale 2]'
    );
    process.exit(1);
  }

  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    console.error('Error: FIGMA_TOKEN environment variable is required.');
    console.error('Create a Personal Access Token at:');
    console.error('  https://www.figma.com/developers/api#access-tokens');
    process.exit(1);
  }

  let nodes;
  try {
    nodes = JSON.parse(nodesJson);
  } catch (err) {
    console.error(`Error: Invalid JSON for --nodes: ${err.message}`);
    process.exit(1);
  }

  for (const n of nodes) {
    if (!n.id || !n.name) {
      console.error(`Error: Each node needs "id" and "name". Got: ${JSON.stringify(n)}`);
      process.exit(1);
    }
  }

  return { fileKey, feature, nodes, scale, token };
}

// ── HTTP helpers ────────────────────────────────────────────────

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const makeRequest = (reqUrl) => {
      const mod = reqUrl.startsWith('https') ? https : require('node:http');
      mod.get(reqUrl, { headers }, (res) => {
        // Follow redirects (Figma S3 URLs redirect)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return makeRequest(res.headers.location);
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
          } else {
            resolve(Buffer.concat(chunks));
          }
        });
      }).on('error', reject);
    };
    makeRequest(url);
  });
}

// ── Figma API ───────────────────────────────────────────────────

async function getImageUrls(fileKey, nodeIds, scale, token) {
  const ids = nodeIds.join(',');
  const url = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=${scale}`;

  console.error(`[figma-save] Requesting image export for ${nodeIds.length} node(s)...`);

  const data = await httpGet(url, { 'X-Figma-Token': token });
  const json = JSON.parse(data.toString());

  if (json.err) {
    throw new Error(`Figma API error: ${json.err}`);
  }

  return json.images; // { "nodeId": "https://..." }
}

async function downloadImage(url, filepath) {
  const buffer = await httpGet(url, {});
  await writeFile(filepath, buffer);
  return buffer.length;
}

// ── Batching ────────────────────────────────────────────────────

const BATCH_SIZE = 3; // Figma render timeout hits at ~4+ large nodes at 2x

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

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
  const batches = chunk(nodes, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNodeIds = batch.map((n) => n.id);

    console.error(`[figma-save] Batch ${i + 1}/${batches.length}: ${batch.map((n) => n.name).join(', ')}`);

    let imageUrls;
    try {
      imageUrls = await getImageUrls(fileKey, batchNodeIds, scale, token);
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

      const filename = `figma-${node.name}.png`;
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
