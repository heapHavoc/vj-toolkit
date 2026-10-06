#!/usr/bin/env node
/**
 * detect-server.js — Find the running local theme dev server for THIS project
 *
 * Probes the usual `shopify theme dev` ports (and any passed with --ports).
 * Several projects can run dev servers at once, so a port whose listening
 * process was started in the current directory wins; other projects' servers
 * are only used when no owner can be determined (e.g. lsof unavailable).
 *
 * Usage:
 *   node detect-server.js [--ports 9292,9293,9294]
 *
 * Output (stdout): { "url": "http://127.0.0.1:9293", "status": 200, "owned": true } or { "url": null }
 */

'use strict';

const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseFlags } = require('./lib/pw');

function probe(port, timeout) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout }, (res) => {
      res.resume();
      resolve({ port, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** Working directory of the process listening on `port`, or null if it can't be determined. */
function ownerDir(port) {
  try {
    const pid = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (!pid) return null;
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? path.resolve(line.slice(1)) : null;
  } catch {
    return null;
  }
}

async function main() {
  const flags = parseFlags();
  const ports = String(flags.ports ?? '9292,9293,9294,9295,9296')
    .split(',').map((p) => Number(p.trim())).filter(Boolean);
  const root = path.resolve(process.cwd());
  const owners = ports.map((port) => ({ port, dir: ownerDir(port) }));
  const ours = owners.filter((o) => o.dir && (root === o.dir || root.startsWith(o.dir + path.sep) || o.dir.startsWith(root + path.sep)));
  const foreign = owners.filter((o) => o.dir && !ours.includes(o));

  // A dev server's first response can take a while (it renders the page), so owned ports get a long timeout.
  let hit = null;
  if (ours.length) {
    hit = (await Promise.all(ours.map((o) => probe(o.port, 30000)))).find(Boolean);
  } else {
    const unknown = owners.filter((o) => !o.dir).map((o) => o.port);
    hit = (await Promise.all(unknown.map((p) => probe(p, 4000)))).find(Boolean);
  }

  for (const f of foreign) console.error(`[detect-server] skipped :${f.port} — it belongs to ${f.dir}`);
  if (!hit) {
    console.error(`No dev server for ${root} on ports ${ports.join(', ')}. Start it with: shopify theme dev (or the project's npm script).`);
    console.log(JSON.stringify({ url: null }));
    process.exit(2);
  }
  console.log(JSON.stringify({ url: `http://127.0.0.1:${hit.port}`, status: hit.status, owned: ours.some((o) => o.port === hit.port) }));
}

main();
