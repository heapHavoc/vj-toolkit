#!/usr/bin/env node
/**
 * save-figma-styles.js — Fetch shared styles (color/text/effect) via REST API
 *
 * Pulls the file's published style definitions so design tokens are captured
 * by name. Unpublished local styles do not appear here; extract-figma-sections.js
 * still reports any style referenced on nodes (from the /nodes response).
 *
 * Usage:
 *   node save-figma-styles.js \
 *     --file-key <figma-file-key> \
 *     --feature <feature-name> [--refresh]
 *
 * Run once per distinct file key: entries are merged into the same
 * figma-styles.json (replacing only that file key's previous entries).
 *
 * Requires: FIGMA_TOKEN environment variable (Personal Access Token)
 *
 * Output: .buildspace/artifacts/{feature}/figma-styles.json (also printed to stdout)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  requireToken, parseFlags, figmaApi, artifactsDir, rawDir, cachedJson, chunk,
} = require('./lib/figma');

// The /styles endpoint lists style metadata (name, type) but not the
// resolved value. Resolving values requires looking up each style's
// node in the file via /nodes and reading its fills/effects/type props.

function extractValue(node, styleType) {
  if (!node) return null;
  if (styleType === 'FILL' && Array.isArray(node.fills) && node.fills[0]) {
    const fill = node.fills[0];
    if (fill.type === 'SOLID' && fill.color) {
      const { r, g, b } = fill.color;
      const a = fill.opacity ?? fill.color.a ?? 1;
      const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
      return { hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase(), alpha: a };
    }
    return fill;
  }
  if (styleType === 'TEXT' && node.style) {
    return {
      fontFamily: node.style.fontFamily,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      lineHeightPx: node.style.lineHeightPx,
      letterSpacing: node.style.letterSpacing,
      textCase: node.style.textCase,
    };
  }
  if (styleType === 'EFFECT' && Array.isArray(node.effects)) {
    return node.effects;
  }
  return null;
}

async function main() {
  const flags = parseFlags();
  const fileKey = flags['file-key'];
  const feature = flags.feature;
  if (!fileKey || !feature) {
    console.error('Usage: node save-figma-styles.js --file-key <key> --feature <name> [--refresh]');
    process.exit(1);
  }
  const token = requireToken();
  const refresh = Boolean(flags.refresh);

  const stylesRes = await cachedJson(
    path.join(rawDir(feature), `styles-${fileKey}.json`),
    () => {
      console.error(`Fetching styles for file ${fileKey}...`);
      return figmaApi(`/v1/files/${fileKey}/styles`, token);
    },
    { refresh }
  );
  const styleMetas = stylesRes.meta?.styles ?? [];

  const resolved = {};
  for (const batch of chunk(styleMetas.map((s) => s.node_id), 50)) {
    console.error(`Resolving ${batch.length} style node(s)...`);
    const nodesRes = await figmaApi(`/v1/files/${fileKey}/nodes?ids=${batch.join(',')}`, token);
    for (const id of batch) resolved[id] = nodesRes.nodes?.[id]?.document ?? null;
  }

  const styles = styleMetas.map((meta) => ({
    fileKey,
    name: meta.name,
    type: meta.style_type,
    description: meta.description || undefined,
    nodeId: meta.node_id,
    value: extractValue(resolved[meta.node_id], meta.style_type),
  }));

  const outDir = artifactsDir(feature);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'figma-styles.json');
  const previous = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : [];
  const merged = [...previous.filter((s) => s.fileKey && s.fileKey !== fileKey), ...styles];
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');

  if (styleMetas.length === 0) console.error('No published shared styles found in this file.');
  console.error(`Saved ${styles.length} style(s) for ${fileKey} (${merged.length} total) to ${outPath}`);
  console.log(JSON.stringify(merged, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
