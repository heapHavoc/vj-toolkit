#!/usr/bin/env node
/**
 * find-figma-frames.js — Find the other-viewport frame for a single pasted link
 *
 * Reads the file's top levels (GET /v1/files/:key?depth=2, then depth=3 if the
 * node is nested one level deeper, e.g. inside a SECTION) and lists sibling
 * frames of the opposite viewport, ranked by name similarity and proximity.
 *
 * Usage:
 *   node find-figma-frames.js --file-key <key> --node-id <id> --feature <name> [--refresh]
 *
 * Output (stdout): { target: {...}, targetViewport, candidates: [{ id, name, width, height, score }] }
 * Candidates are suggestions only — confirm the pick with the user.
 */

'use strict';

const path = require('node:path');
const { requireToken, parseFlags, figmaApi, rawDir, cachedJson } = require('./lib/figma');

const FRAME_TYPES = new Set(['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP']);
const VIEWPORT_WORDS = /\b(desktop|mobile|web|mweb|dt|mob|tablet|\d{3,4}(px)?)\b/gi;

function tokens(name) {
  return new Set(String(name).toLowerCase().replace(VIEWPORT_WORDS, ' ').split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

function findWithParent(node, id, parent = null) {
  if (node.id === id) return { node, parent };
  for (const child of node.children ?? []) {
    const hit = findWithParent(child, id, node);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const flags = parseFlags();
  const { 'file-key': fileKey, 'node-id': nodeId, feature } = flags;
  if (!fileKey || !nodeId || !feature) {
    console.error('Usage: find-figma-frames.js --file-key <key> --node-id <id> --feature <name> [--refresh]');
    process.exit(1);
  }
  const token = requireToken();

  let hit = null;
  for (const depth of [2, 3]) {
    const file = await cachedJson(
      path.join(rawDir(feature), `file-${fileKey}-depth${depth}.json`),
      () => {
        console.error(`[find-frames] GET file depth=${depth}`);
        return figmaApi(`/v1/files/${fileKey}?depth=${depth}`, token);
      },
      { refresh: Boolean(flags.refresh) }
    );
    hit = findWithParent(file.document, nodeId);
    if (hit) break;
  }

  if (!hit) {
    console.log(JSON.stringify({ target: null, candidates: [], note: 'Node is nested deeper than the top levels of its page — ask the user for the other viewport link.' }, null, 2));
    return;
  }

  const tb = hit.node.absoluteBoundingBox ?? {};
  const targetViewport = (tb.width ?? 0) < 600 ? 'mobile' : 'desktop';
  const wanted = targetViewport === 'desktop'
    ? (w) => w >= 320 && w < 600
    : (w) => w >= 1000;

  const candidates = (hit.parent?.children ?? [])
    .filter((c) => c.id !== nodeId && FRAME_TYPES.has(c.type) && c.visible !== false)
    .filter((c) => wanted(c.absoluteBoundingBox?.width ?? 0))
    .map((c) => {
      const b = c.absoluteBoundingBox;
      const distance = Math.hypot(b.x - tb.x, b.y - tb.y);
      const nameScore = similarity(hit.node.name, c.name);
      return {
        id: c.id,
        name: c.name,
        width: Math.round(b.width),
        height: Math.round(b.height),
        nameScore: Math.round(nameScore * 100) / 100,
        distance: Math.round(distance),
        score: Math.round((nameScore * 10 + 1 / (1 + distance / 2000)) * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  console.log(JSON.stringify({
    target: { id: hit.node.id, name: hit.node.name, width: Math.round(tb.width ?? 0), height: Math.round(tb.height ?? 0) },
    parent: hit.parent ? { id: hit.parent.id, name: hit.parent.name, type: hit.parent.type } : null,
    targetViewport,
    lookingFor: targetViewport === 'desktop' ? 'mobile' : 'desktop',
    candidates,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[find-frames] Fatal: ${err.message}`);
  process.exit(1);
});
