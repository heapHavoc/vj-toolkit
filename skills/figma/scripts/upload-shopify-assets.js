#!/usr/bin/env node
/**
 * upload-shopify-assets.js — Upload Figma assets to Shopify Files via Admin API
 *
 * Reads assets-manifest.json, uploads each image to Shopify via
 * stagedUploadsCreate → multipart upload → fileCreate, then polls until
 * files are READY and outputs an updated manifest with Shopify CDN URLs.
 *
 * Usage:
 *   node upload-shopify-assets.js --feature <feature-name>
 *
 * Requires environment variables:
 *   SHOPIFY_STORE       — Store domain (e.g., "my-store.myshopify.com")
 *   SHOPIFY_ADMIN_TOKEN — Admin API access token (with write_files scope)
 *
 * Output: Updated manifest JSON to stdout (original fields + shopifyUrl, shopifyFileId)
 */

'use strict';

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

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
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — fall through to env var check
  }
}

loadEnv();

// ── Constants ──────────────────────────────────────────────────

const API_VERSION = '2025-10';
const BATCH_SIZE = 3;
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30; // 60 seconds max wait

// ── Args ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };

  const feature = get('--feature');
  if (!feature) {
    console.error(
      'Usage: upload-shopify-assets.js --feature <name>'
    );
    process.exit(1);
  }

  let store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!store) {
    console.error('Error: SHOPIFY_STORE environment variable is required.');
    console.error('Set it to your store domain, e.g.: my-store.myshopify.com');
    process.exit(1);
  }

  if (!token) {
    console.error('Error: SHOPIFY_ADMIN_TOKEN environment variable is required.');
    console.error('Create a custom app in your Shopify admin:');
    console.error(
      '  Settings > Apps and sales channels > Develop apps'
    );
    console.error(
      '  Give it the "write_files" scope under Admin API access scopes.'
    );
    process.exit(1);
  }

  // Normalize store URL — strip protocol and trailing slash
  store = store.replace(/^https?:\/\//, '').replace(/\/$/, '');

  return { feature, store, token };
}

// ── HTTP helpers ───────────────────────────────────────────────

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);

    const req = mod.request(
      parsed,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': buf.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );

    req.on('error', reject);
    req.end(buf);
  });
}

async function shopifyGraphQL(store, token, query, variables) {
  const url = `https://${store}/admin/api/${API_VERSION}/graphql.json`;
  const body = JSON.stringify({ query, variables });

  const res = await httpsPost(url, {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': token,
  }, body);

  if (res.statusCode !== 200) {
    throw new Error(`Shopify API HTTP ${res.statusCode}: ${res.body}`);
  }

  const json = JSON.parse(res.body);
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// ── MIME type helper ──────────────────────────────────────────

function mimeFromExt(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

// ── Multipart upload ──────────────────────────────────────────

async function multipartUpload(targetUrl, parameters, fileBuffer, filename, mimeType) {
  const boundary = '----ShopifyUpload' + Date.now().toString(36);

  // Build form fields from stagedUploadsCreate parameters
  const parts = [];
  for (const { name, value } of parameters) {
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
    );
  }

  // File part (must be last for S3)
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;

  const footer = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(parts.join('') + fileHeader);
  const footerBuf = Buffer.from(footer);
  const body = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

  const res = await httpsPost(targetUrl, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  }, body);

  // S3 returns 201 Created on success, some endpoints return 200/204
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return true;
  }

  throw new Error(
    `Upload failed HTTP ${res.statusCode}: ${res.body.slice(0, 500)}`
  );
}

// ── GraphQL queries ───────────────────────────────────────────

const STAGED_UPLOADS_CREATE = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_CREATE = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        alt
        fileStatus
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILES_POLL = `
  query filesPoll($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on MediaImage {
        id
        fileStatus
        image {
          url
        }
      }
      ... on GenericFile {
        id
        fileStatus
        url
      }
    }
  }
`;

// ── Helpers ───────────────────────────────────────────────────

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const { feature, store, token } = parseArgs();

  const artifactsDir = path.resolve(`.buildspace/artifacts/${feature}`);
  const manifestPath = path.join(artifactsDir, 'assets-manifest.json');

  // Read existing manifest
  let manifest;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    console.error(`[shopify-upload] Cannot read ${manifestPath}: ${err.message}`);
    process.exit(1);
  }

  if (manifest.length === 0) {
    console.error('[shopify-upload] Manifest is empty — nothing to upload.');
    console.log(JSON.stringify([], null, 2));
    return;
  }

  // Skip assets that already have a Shopify URL (re-run safe)
  const toUpload = manifest.filter((a) => !a.shopifyUrl);
  const alreadyDone = manifest.filter((a) => a.shopifyUrl);

  if (toUpload.length === 0) {
    console.error(
      '[shopify-upload] All assets already have Shopify URLs — nothing to upload.'
    );
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (alreadyDone.length > 0) {
    console.error(
      `[shopify-upload] Skipping ${alreadyDone.length} already-uploaded asset(s)`
    );
  }

  console.error(
    `[shopify-upload] Uploading ${toUpload.length} asset(s) to ${store}`
  );

  // Load file buffers
  const loadable = [];
  for (const asset of toUpload) {
    const filePath = path.join(artifactsDir, asset.file);
    try {
      const buffer = await readFile(filePath);
      loadable.push({ asset, buffer, filePath });
      console.error(
        `[shopify-upload] Loaded ${asset.name} (${(buffer.length / 1024).toFixed(1)}KB)`
      );
    } catch (err) {
      console.error(
        `[shopify-upload] ${asset.name}: cannot read file — ${err.message}`
      );
      loadable.push({ asset, buffer: null, filePath, error: err.message });
    }
  }

  const uploadable = loadable.filter((a) => a.buffer !== null);
  if (uploadable.length === 0) {
    console.error('[shopify-upload] No files could be loaded — aborting.');
    process.exit(1);
  }

  // Process in batches
  const uploadResults = new Map(); // asset.name → { shopifyUrl, shopifyFileId, shopifyRef }
  const batches = chunk(uploadable, BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.error(
      `[shopify-upload] Batch ${i + 1}/${batches.length}: ${batch.map((a) => a.asset.name).join(', ')}`
    );

    // Step 1: Create staged uploads
    const stagedInput = batch.map(({ filePath }) => ({
      resource: 'IMAGE',
      filename: path.basename(filePath),
      mimeType: mimeFromExt(filePath),
      httpMethod: 'POST',
    }));

    let stagedTargets;
    try {
      const data = await shopifyGraphQL(store, token, STAGED_UPLOADS_CREATE, {
        input: stagedInput,
      });
      const { stagedTargets: targets, userErrors } =
        data.stagedUploadsCreate;

      if (userErrors?.length > 0) {
        console.error(
          `[shopify-upload] stagedUploadsCreate errors: ${JSON.stringify(userErrors)}`
        );
        continue;
      }

      stagedTargets = targets;
    } catch (err) {
      console.error(
        `[shopify-upload] stagedUploadsCreate failed: ${err.message}`
      );
      continue;
    }

    // Step 2: Upload files to staged targets
    const uploaded = [];
    for (let j = 0; j < batch.length; j++) {
      const { asset, buffer, filePath } = batch[j];
      const target = stagedTargets[j];

      try {
        await multipartUpload(
          target.url,
          target.parameters,
          buffer,
          path.basename(filePath),
          mimeFromExt(filePath)
        );
        console.error(`[shopify-upload] ${asset.name}: staged upload complete`);
        uploaded.push({ asset, resourceUrl: target.resourceUrl });
      } catch (err) {
        console.error(
          `[shopify-upload] ${asset.name}: upload failed — ${err.message}`
        );
      }
    }

    if (uploaded.length === 0) continue;

    // Step 3: Register files in Shopify
    const fileInputs = uploaded.map(({ asset, resourceUrl }) => ({
      originalSource: resourceUrl,
      alt: asset.sourceNodeName || asset.name,
      contentType: 'IMAGE',
    }));

    let createdFiles;
    try {
      const data = await shopifyGraphQL(store, token, FILE_CREATE, {
        files: fileInputs,
      });
      const { files, userErrors } = data.fileCreate;

      if (userErrors?.length > 0) {
        console.error(
          `[shopify-upload] fileCreate errors: ${JSON.stringify(userErrors)}`
        );
      }

      createdFiles = files || [];
    } catch (err) {
      console.error(
        `[shopify-upload] fileCreate failed: ${err.message}`
      );
      continue;
    }

    // Step 4: Poll until files are READY
    const fileIds = createdFiles.map((f) => f.id).filter(Boolean);

    if (fileIds.length > 0) {
      console.error(
        `[shopify-upload] Waiting for ${fileIds.length} file(s) to process...`
      );

      const readyFiles = new Map();

      for (let poll = 0; poll < MAX_POLLS; poll++) {
        await sleep(POLL_INTERVAL_MS);

        try {
          const data = await shopifyGraphQL(store, token, FILES_POLL, {
            ids: fileIds,
          });

          for (const node of data.nodes || []) {
            if (!node) continue;
            const url = node.image?.url || node.url;
            if (node.fileStatus === 'READY' && url) {
              readyFiles.set(node.id, url);
            } else if (node.fileStatus === 'FAILED') {
              console.error(
                `[shopify-upload] File ${node.id} processing FAILED`
              );
              readyFiles.set(node.id, null); // mark as done (failed)
            }
          }

          const pending = fileIds.filter((id) => !readyFiles.has(id));
          if (pending.length === 0) {
            console.error(
              `[shopify-upload] All ${fileIds.length} file(s) processed`
            );
            break;
          }

          console.error(
            `[shopify-upload] ${fileIds.length - pending.length}/${fileIds.length} done, polling...`
          );
        } catch (err) {
          console.error(`[shopify-upload] Poll error: ${err.message}`);
        }
      }

      // Map results back to assets
      for (let j = 0; j < uploaded.length; j++) {
        const { asset } = uploaded[j];
        const file = createdFiles[j];

        if (!file?.id) continue;

        const shopifyUrl = readyFiles.get(file.id);
        if (shopifyUrl) {
          // Extract filename from CDN URL for shopify:// reference
          // e.g., "https://cdn.shopify.com/.../files/banner-image-1.png?v=123" → "banner-image-1.png"
          const cdnFilename = new URL(shopifyUrl).pathname.split('/').pop();
          const shopifyRef = `shopify://shop_images/${cdnFilename}`;
          console.error(`[shopify-upload] ${asset.name}: ${shopifyRef}`);
          uploadResults.set(asset.name, {
            shopifyUrl,
            shopifyFileId: file.id,
            shopifyRef,
          });
        } else {
          console.error(
            `[shopify-upload] ${asset.name}: file created (${file.id}) but URL not available`
          );
          uploadResults.set(asset.name, { shopifyFileId: file.id });
        }
      }
    }
  }

  // Build final manifest — merge upload results into original manifest
  const finalManifest = manifest.map((entry) => {
    // Keep already-uploaded entries as-is
    if (entry.shopifyUrl) return entry;

    const result = uploadResults.get(entry.name);
    if (result) {
      return { ...entry, ...result };
    }
    return entry; // upload failed — keep original without shopifyUrl
  });

  // Summary
  const uploaded = finalManifest.filter((e) => e.shopifyUrl).length;
  const total = finalManifest.length;
  console.error(
    `[shopify-upload] Done: ${uploaded}/${total} assets have Shopify URLs`
  );

  console.log(JSON.stringify(finalManifest, null, 2));
}

main().catch((err) => {
  console.error(`[shopify-upload] Fatal: ${err.message}`);
  process.exit(1);
});
