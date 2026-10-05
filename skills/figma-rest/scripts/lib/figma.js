'use strict';

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// ── .env loader (zero dependencies) ────────────────────────────

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireToken() {
  loadEnv();
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    console.error('Error: FIGMA_TOKEN not set (env or .env file).');
    console.error('Create a Personal Access Token at: https://www.figma.com/developers/api#access-tokens');
    process.exit(1);
  }
  return token;
}

// ── Args ────────────────────────────────────────────────────────

function parseFlags(argv = process.argv.slice(2)) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

// ── HTTP ────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requestOnce(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        requestOnce(res.headers.location, headers).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

async function httpGet(url, headers = {}, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await requestOnce(url, headers);
    if (res.status === 200) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new HttpError(res.status, res.buffer.toString());
    }
    const retryAfter = Number(res.headers['retry-after']);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, 120) * 1000
      : 2000 * 2 ** attempt;
    console.error(`[figma] HTTP ${res.status} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${retries})`);
    await sleep(waitMs);
  }
}

async function figmaApi(apiPath, token) {
  const { buffer } = await httpGet(`https://api.figma.com${apiPath}`, { 'X-Figma-Token': token });
  const json = JSON.parse(buffer.toString());
  if (json.err) throw new Error(`Figma API error: ${json.err}`);
  return json;
}

// ── Cache ───────────────────────────────────────────────────────
// Raw responses live under .buildspace/artifacts/{feature}/raw/ so re-runs
// and sibling scripts don't spend API calls on data we already have.

function artifactsDir(feature) {
  return path.resolve(process.cwd(), '.buildspace/artifacts', feature);
}

function rawDir(feature) {
  return path.join(artifactsDir(feature), 'raw');
}

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9]+/g, '-');

function nodesCachePath(feature, fileKey, nodeId) {
  return path.join(rawDir(feature), `nodes-${fileKey}-${safeId(nodeId)}.json`);
}

async function cachedJson(cachePath, fetcher, { refresh = false } = {}) {
  if (!refresh && fs.existsSync(cachePath)) {
    console.error(`[figma] cache hit: ${path.relative(process.cwd(), cachePath)}`);
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }
  const json = await fetcher();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(json));
  return json;
}

async function getNodes({ fileKey, nodeId, feature, token, refresh = false }) {
  return cachedJson(
    nodesCachePath(feature, fileKey, nodeId),
    () => {
      console.error(`[figma] GET nodes ${nodeId}`);
      return figmaApi(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, token);
    },
    { refresh }
  );
}

// ── Misc ────────────────────────────────────────────────────────

function toKebabCase(str) {
  return String(str)
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = {
  loadEnv,
  requireToken,
  parseFlags,
  httpGet,
  HttpError,
  figmaApi,
  artifactsDir,
  rawDir,
  nodesCachePath,
  cachedJson,
  getNodes,
  toKebabCase,
  chunk,
  safeId,
};
