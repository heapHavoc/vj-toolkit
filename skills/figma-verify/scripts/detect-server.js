#!/usr/bin/env node
/**
 * detect-server.js — Find the running local theme dev server
 *
 * Probes the usual `shopify theme dev` ports (and any passed with --ports)
 * and prints the first base URL that answers.
 *
 * Usage:
 *   node detect-server.js [--ports 9292,9293,9294]
 *
 * Output (stdout): { "url": "http://127.0.0.1:9293", "status": 200 } or { "url": null }
 */

'use strict';

const http = require('node:http');
const { parseFlags } = require('./lib/pw');

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 4000 }, (res) => {
      res.resume();
      resolve({ port, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function main() {
  const flags = parseFlags();
  const ports = String(flags.ports ?? '9292,9293,9294,9295,9296')
    .split(',').map((p) => Number(p.trim())).filter(Boolean);
  const results = await Promise.all(ports.map(probe));
  const hit = results.find(Boolean);
  if (!hit) {
    console.error(`No dev server on ports ${ports.join(', ')}. Start it with: shopify theme dev (or the project's npm script).`);
    console.log(JSON.stringify({ url: null }));
    process.exit(2);
  }
  console.log(JSON.stringify({ url: `http://127.0.0.1:${hit.port}`, status: hit.status }));
}

main();
