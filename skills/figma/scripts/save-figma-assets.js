#!/usr/bin/env node
/**
 * save-figma-assets.js — Download image fill assets from Figma via REST API
 *
 * Discovers all IMAGE fills in a Figma frame's sections, downloads the original
 * uploaded images, and saves them to the figmaAssets folder.
 *
 * Usage:
 *   node save-figma-assets.js \
 *     --file-key <figma-file-key> \
 *     --feature <feature-name> \
 *     --node-id <top-level-node-id>
 *
 * Requires: FIGMA_TOKEN environment variable (Personal Access Token)
 *   Create one at: https://www.figma.com/developers/api#access-tokens
 *
 * Output: .buildspace/artifacts/{feature}/figmaAssets/{section}-image-{n}.{ext}
 *         assets-manifest.json content written to stdout
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
  const nodeId = get('--node-id');

  if (!fileKey || !feature || !nodeId) {
    console.error(
      'Usage: save-figma-assets.js --file-key <key> --feature <name> --node-id <node-id>'
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

  return { fileKey, feature, nodeId, token };
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
            resolve({
              buffer: Buffer.concat(chunks),
              contentType: res.headers['content-type'] || '',
            });
          }
        });
      }).on('error', reject);
    };
    makeRequest(url);
  });
}

// ── Figma API ───────────────────────────────────────────────────

async function getFileNodes(fileKey, nodeId, token) {
  const url = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  console.error(`[figma-assets] Fetching node tree for ${nodeId}...`);

  const { buffer } = await httpGet(url, { 'X-Figma-Token': token });
  const json = JSON.parse(buffer.toString());

  if (json.err) throw new Error(`Figma API error: ${json.err}`);
  return json.nodes[nodeId]?.document;
}

async function getImageFillUrls(fileKey, token) {
  const url = `https://api.figma.com/v1/files/${fileKey}/images`;
  console.error(`[figma-assets] Fetching image fill URLs...`);

  const { buffer } = await httpGet(url, { 'X-Figma-Token': token });
  const json = JSON.parse(buffer.toString());

  if (json.err) throw new Error(`Figma API error: ${json.err}`);
  // API returns under "meta.images" or "images" depending on version
  return json.meta?.images || json.images || {};
}

// ── Node tree traversal ────────────────────────────────────────

const SKIP_SECTIONS = ['header', 'footer', 'nav', 'navigation'];

function toKebabCase(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Recursively find all IMAGE fills in a node and its descendants.
 */
function findImageFills(node, results = []) {
  if (node.fills && Array.isArray(node.fills)) {
    for (const fill of node.fills) {
      if (fill.type === 'IMAGE' && fill.imageRef) {
        results.push({
          imageRef: fill.imageRef,
          sourceNode: node.id,
          sourceNodeName: node.name,
        });
      }
    }
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      findImageFills(child, results);
    }
  }

  return results;
}

/**
 * Walk top-level sections, discover IMAGE fills, deduplicate, and name them.
 */
function discoverAssets(topLevelNode) {
  const sections = topLevelNode.children || [];
  const assets = [];

  for (const section of sections) {
    const sectionName = toKebabCase(section.name);

    if (SKIP_SECTIONS.includes(sectionName)) {
      console.error(`[figma-assets] Skipping section: ${section.name}`);
      continue;
    }

    const fills = findImageFills(section);

    // Deduplicate by imageRef within a section
    const seen = new Set();
    let position = 0;

    for (const fill of fills) {
      if (seen.has(fill.imageRef)) continue;
      seen.add(fill.imageRef);
      position++;

      assets.push({
        name: `${sectionName}-image-${position}`,
        section: sectionName,
        imageRef: fill.imageRef,
        sourceNode: fill.sourceNode,
        sourceNodeName: fill.sourceNodeName,
      });
    }

    if (position > 0) {
      console.error(`[figma-assets] Section "${sectionName}": ${position} image(s)`);
    }
  }

  return assets;
}

// ── Download ───────────────────────────────────────────────────

function extFromContentType(contentType) {
  if (!contentType) return 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('svg')) return 'svg';
  return 'png';
}

const BATCH_SIZE = 3;

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const { fileKey, feature, nodeId, token } = parseArgs();

  const outputDir = path.resolve(`.buildspace/artifacts/${feature}/figmaAssets`);
  await mkdir(outputDir, { recursive: true });

  console.error(`[figma-assets] Feature: ${feature}`);
  console.error(`[figma-assets] File key: ${fileKey}`);
  console.error(`[figma-assets] Node ID: ${nodeId}`);

  // Step 1: Get node tree to discover IMAGE fills
  const topNode = await getFileNodes(fileKey, nodeId, token);
  if (!topNode) {
    console.error('[figma-assets] Error: Could not fetch node tree');
    process.exit(1);
  }

  // Step 2: Walk sections and collect IMAGE fills
  const assets = discoverAssets(topNode);

  if (assets.length === 0) {
    console.error('[figma-assets] No image fills found in any section.');
    console.log(JSON.stringify([], null, 2));
    return;
  }

  console.error(`[figma-assets] Found ${assets.length} image asset(s) total`);

  // Step 3: Get download URLs for all image fills in the file
  const imageUrls = await getImageFillUrls(fileKey, token);
  const availableRefs = Object.keys(imageUrls).length;
  console.error(`[figma-assets] Image fill URLs available: ${availableRefs}`);

  // Step 4: Download in batches
  const results = [];
  const batches = chunk(assets, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.error(
      `[figma-assets] Batch ${i + 1}/${batches.length}: ${batch.map((a) => a.name).join(', ')}`
    );

    const downloads = batch.map(async (asset) => {
      const url = imageUrls[asset.imageRef];
      if (!url) {
        console.error(
          `[figma-assets] ${asset.name}: no URL for imageRef ${asset.imageRef} — skipped`
        );
        return { ...asset, status: 'NO_URL' };
      }

      try {
        const { buffer, contentType } = await httpGet(url, {});
        const ext = extFromContentType(contentType);
        const filename = `${asset.name}.${ext}`;
        const filepath = path.join(outputDir, filename);

        await writeFile(filepath, buffer);
        console.error(
          `[figma-assets] ${asset.name}: saved ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`
        );

        return {
          ...asset,
          file: `figmaAssets/${filename}`,
          status: 'SAVED',
          bytes: buffer.length,
        };
      } catch (err) {
        console.error(`[figma-assets] ${asset.name}: FAILED — ${err.message}`);
        return { ...asset, status: 'FAILED', error: err.message };
      }
    });

    const batchResults = await Promise.all(downloads);
    results.push(...batchResults);
  }

  // Summary
  const saved = results.filter((r) => r.status === 'SAVED').length;
  const failed = results.filter((r) => r.status !== 'SAVED').length;
  console.error(`[figma-assets] Done: ${saved} saved, ${failed} failed/skipped`);

  // Output manifest (only saved assets) to stdout
  const manifest = results
    .filter((r) => r.status === 'SAVED')
    .map((r) => ({
      name: r.name,
      section: r.section,
      file: r.file,
      imageRef: r.imageRef,
      sourceNode: r.sourceNode,
      sourceNodeName: r.sourceNodeName,
    }));

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(`[figma-assets] Fatal: ${err.message}`);
  process.exit(1);
});
