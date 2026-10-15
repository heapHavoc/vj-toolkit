/**
 * psi.mjs — call the PageSpeed Insights v5 API.
 *
 * Key: $PAGESPEED_API_KEY, else the first line of .buildspace/.psi-key. Without
 * a key the API still answers, at a much lower quota. The key is never printed:
 * it is stripped from every error message and log line.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export function apiKey(root, env = process.env) {
  if (env.PAGESPEED_API_KEY?.trim()) return { key: env.PAGESPEED_API_KEY.trim(), source: 'PAGESPEED_API_KEY' };
  const file = path.join(root, '.buildspace', '.psi-key');
  if (existsSync(file)) {
    const key = readFileSync(file, 'utf-8').split('\n')[0].trim();
    if (key) return { key, source: '.buildspace/.psi-key' };
  }
  return { key: null, source: null };
}

export const redact = (text, key) => (key ? String(text).split(key).join('***') : String(text));

export function requestUrl(pageUrl, strategy, key, categories = CATEGORIES) {
  const u = new URL(ENDPOINT);
  u.searchParams.set('url', pageUrl);
  u.searchParams.set('strategy', strategy);
  for (const c of categories) u.searchParams.append('category', c);
  if (key) u.searchParams.set('key', key);
  return u.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One PSI run with retries. Returns { ok, json?, error? }. */
export async function runPsi(pageUrl, strategy, { key = null, attempts = 3, timeoutMs = 120000, fetchImpl = fetch, log = () => {} } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(requestUrl(pageUrl, strategy, key), { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (res.ok && json?.lighthouseResult) return { ok: true, json };
      const message = json?.error?.message || `HTTP ${res.status}`;
      lastError = redact(message, key);
      if (!RETRY_STATUS.has(res.status) && !/lighthouse returned error/i.test(message)) break;
    } catch (err) {
      lastError = redact(err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : err.message, key);
    }
    if (attempt < attempts) {
      const wait = 5000 * attempt;
      log(`  ${strategy}: ${lastError} — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  return { ok: false, error: lastError };
}
