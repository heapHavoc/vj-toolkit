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
 *     --node-id <top-level-node-id> \
 *     [--viewport desktop|mobile] [--refresh]
 *
 * Requires: FIGMA_TOKEN environment variable (Personal Access Token)
 *   Create one at: https://www.figma.com/developers/api#access-tokens
 *
 * Section names come from extract-figma-sections.js (figma-dumps/*-index.json)
 * when it has run for the same node; the node tree is read from its raw cache.
 * Images already in assets-manifest.json (same imageRef) are skipped, so the
 * desktop and mobile runs merge into one manifest.
 *
 * Output: .buildspace/artifacts/{feature}/figmaAssets/{section}[-{viewport}]-image-{n}.{ext}
 *         .buildspace/artifacts/{feature}/assets-manifest.json (merged, also printed to stdout)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const {
  requireToken, parseFlags, httpGet, figmaApi, getNodes, toKebabCase, chunk, artifactsDir,
} = require('./lib/figma');

// ── Args ────────────────────────────────────────────────────────

function parseArgs() {
  const flags = parseFlags();
  const fileKey = flags['file-key'];
  const feature = flags.feature;
  const nodeId = flags['node-id'];

  if (!fileKey || !feature || !nodeId) {
    console.error(
      'Usage: save-figma-assets.js --file-key <key> --feature <name> --node-id <node-id> [--refresh]'
    );
    process.exit(1);
  }

  const viewport = typeof flags.viewport === 'string' ? flags.viewport : null;
  return { fileKey, feature, nodeId, viewport, refresh: Boolean(flags.refresh), token: requireToken() };
}

// ── Figma API ───────────────────────────────────────────────────
// The node tree comes from the shared raw cache, so this is free when
// extract-figma-sections.js already ran for the same node.

async function getFileNodes(fileKey, nodeId, feature, token, refresh) {
  console.error(`[figma-assets] Loading node tree for ${nodeId}...`);
  const json = await getNodes({ fileKey, nodeId, feature, token, refresh });
  return json.nodes[nodeId]?.document;
}

async function getImageFillUrls(fileKey, token) {
  console.error(`[figma-assets] Fetching image fill URLs...`);
  const json = await figmaApi(`/v1/files/${fileKey}/images`, token);
  return json.meta?.images || json.images || {};
}

// ── Node tree traversal ────────────────────────────────────────

const SKIP_SECTIONS = ['header', 'footer', 'nav', 'navigation'];

/**
 * Recursively find all IMAGE fills in a node and its descendants.
 */
function findImageFills(node, results = []) {
  if (node.visible === false) return results;
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
 * Section names/mode from extract-figma-sections.js, so asset names match the
 * dumps and sections.json. Falls back to Figma layer names when absent.
 */
function loadExtractIndex(feature, nodeId) {
  const dir = path.join(artifactsDir(feature), 'figma-dumps');
  if (!fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('-index.json'))) {
    const index = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (index.nodeId === nodeId) return index;
  }
  return null;
}

/**
 * Walk top-level sections, discover IMAGE fills, deduplicate, and name them.
 */
function discoverAssets(topLevelNode, index, viewport) {
  const byId = new Map((index?.sections ?? []).map((s) => [s.figmaNodeId, s]));
  const findNode = (node, id) => {
    if (node.id === id) return node;
    for (const c of node.children ?? []) {
      const hit = findNode(c, id);
      if (hit) return hit;
    }
    return null;
  };
  let sections;
  if (index?.mode === 'section') sections = [topLevelNode];
  else if (index) sections = index.sections.map((s) => findNode(topLevelNode, s.figmaNodeId)).filter(Boolean);
  else sections = (topLevelNode.children || []).filter((c) => c.visible !== false);
  const assets = [];

  for (const section of sections) {
    const known = byId.get(section.id);
    const sectionName = known?.name ?? toKebabCase(section.name);
    const prefix = viewport ? `${sectionName}-${viewport}` : sectionName;

    if (known?.skipped || SKIP_SECTIONS.includes(sectionName)) {
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
        name: `${prefix}-image-${position}`,
        section: sectionName,
        ...(viewport ? { viewport } : {}),
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

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const { fileKey, feature, nodeId, viewport, refresh, token } = parseArgs();

  const outputDir = path.resolve(`.buildspace/artifacts/${feature}/figmaAssets`);
  await mkdir(outputDir, { recursive: true });

  console.error(`[figma-assets] Feature: ${feature}`);
  console.error(`[figma-assets] File key: ${fileKey}`);
  console.error(`[figma-assets] Node ID: ${nodeId}`);

  // Step 1: Get node tree to discover IMAGE fills
  const topNode = await getFileNodes(fileKey, nodeId, feature, token, refresh);
  if (!topNode) {
    console.error('[figma-assets] Error: Could not fetch node tree');
    process.exit(1);
  }

  // Step 2: Walk sections and collect IMAGE fills
  const manifestPath = path.join(artifactsDir(feature), 'assets-manifest.json');
  const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
  const knownRefs = new Set(existing.map((a) => a.imageRef));
  const index = loadExtractIndex(feature, nodeId);
  const assets = discoverAssets(topNode, index, viewport ?? index?.viewport ?? null)
    .filter((a) => !knownRefs.has(a.imageRef));

  if (assets.length === 0) {
    console.error('[figma-assets] No new image fills found (already in manifest or none in design).');
    if (!fs.existsSync(manifestPath)) await writeFile(manifestPath, '[]\n');
    console.log(JSON.stringify(existing, null, 2));
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
        const { buffer, headers } = await httpGet(url, {});
        const contentType = headers['content-type'] || '';
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

  const added = results
    .filter((r) => r.status === 'SAVED')
    .map((r) => ({
      name: r.name,
      section: r.section,
      ...(r.viewport ? { viewport: r.viewport } : {}),
      file: r.file,
      imageRef: r.imageRef,
      sourceNode: r.sourceNode,
      sourceNodeName: r.sourceNodeName,
    }));

  // Merge into the manifest (existing entries keep their Shopify upload fields)
  const manifest = [...existing, ...added];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.error(`[figma-assets] assets-manifest.json: ${existing.length} existing + ${added.length} new`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(`[figma-assets] Fatal: ${err.message}`);
  process.exit(1);
});
