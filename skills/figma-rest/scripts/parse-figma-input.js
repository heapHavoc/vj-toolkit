#!/usr/bin/env node
/**
 * parse-figma-input.js — Normalise whatever the user pasted into Figma targets
 *
 * Accepts any of:
 *   - Dev Mode "Copy prompt":  Implement this design from Figma. @https://www.figma.com/design/...
 *   - A bare Figma link
 *   - Labelled lines:          Desktop: <url>  /  Mobile: <url>
 *
 * Usage:
 *   node parse-figma-input.js "<pasted text>"
 *   echo "<pasted text>" | node parse-figma-input.js
 *
 * Output (stdout): {
 *   links: [{ url, fileKey, nodeId, label }],
 *   desktop: {...} | null, mobile: {...} | null, unlabeled: [...]
 * }
 * `label` is "desktop", "mobile" or null. Unlabeled links are resolved by
 * frame width later (extract-figma-sections.js --viewport auto).
 */

'use strict';

const URL_RE = /https?:\/\/(?:www\.)?figma\.com\/(design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?[^\s)>"'\]]*/g;

const DESKTOP_RE = /\b(desktop|web|dt|large|laptop)\b/i;
const MOBILE_RE = /\b(mobile|mob|mweb|phone|small)\b/i;

function normaliseNodeId(raw) {
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  return id.replace(/(\d+)-(\d+)/g, '$1:$2');
}

function labelFor(text, matchIndex) {
  const lineStart = text.lastIndexOf('\n', matchIndex) + 1;
  const prefix = text.slice(lineStart, matchIndex);
  if (MOBILE_RE.test(prefix)) return 'mobile';
  if (DESKTOP_RE.test(prefix)) return 'desktop';
  return null;
}

function parse(text) {
  const links = [];
  const seen = new Set();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;]+$/, '');
    const fileKey = match[3] || match[2];
    let nodeId = null;
    try {
      nodeId = normaliseNodeId(new URL(url).searchParams.get('node-id'));
    } catch {
      // malformed URL — leave nodeId null
    }
    const key = `${fileKey}|${nodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url, fileKey, nodeId, label: labelFor(text, match.index) });
  }

  const desktop = links.find((l) => l.label === 'desktop') || null;
  const mobile = links.find((l) => l.label === 'mobile') || null;
  const unlabeled = links.filter((l) => !l.label);

  return { links, desktop, mobile, unlabeled };
}

async function readInput() {
  const arg = process.argv.slice(2).join(' ').trim();
  if (arg) return arg;
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

if (require.main === module) {
  readInput().then((text) => {
    const result = parse(text);
    if (result.links.length === 0) {
      console.error('No Figma design links found in input.');
      console.log(JSON.stringify(result, null, 2));
      process.exit(2);
    }
    const missingNode = result.links.filter((l) => !l.nodeId);
    if (missingNode.length) {
      console.error(`Warning: ${missingNode.length} link(s) have no node-id — select a frame in Figma and copy its link.`);
    }
    console.log(JSON.stringify(result, null, 2));
  });
}

module.exports = { parse, normaliseNodeId };
