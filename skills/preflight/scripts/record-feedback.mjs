#!/usr/bin/env node
/**
 * record-feedback.mjs — attach the user's answer to "Did preflight miss or misjudge anything?"
 * to the latest finalized run, locally (runs/<run>/feedback.md) and in the shared run log.
 *
 * Usage:
 *   node record-feedback.mjs --root . --text "<the user's answer>" [--run-id <uuid>] [--config <path>]
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestRunDir, recordFeedback, telemetrySettings } from './lib/telemetry.mjs';

function parseArgs(argv) {
  const out = { root: '.', config: '.buildspace/preflight/preflight.config.json', text: null, runId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else return { error: `Unknown argument "${a}".` };
  }
  out.root = path.resolve(out.root);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: node record-feedback.mjs --root . --text "<answer>" [--run-id <uuid>] [--config path]\n');
    return;
  }
  if (args.error || !args.text?.trim()) {
    process.stderr.write(`record-feedback: ${args.error || '--text is required.'}\n`);
    process.exitCode = 2;
    return;
  }
  const outDir = path.join(args.root, '.buildspace', 'preflight');
  const runDir = latestRunDir(outDir);
  const runJson = runDir ? JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf-8')) : null;
  const runId = args.runId || runJson?.run_id;
  if (!runId) {
    process.stderr.write('record-feedback: no archived run found — finalize a run first.\n');
    process.exitCode = 2;
    return;
  }
  if (runDir && runJson?.run_id === runId) {
    writeFileSync(path.join(runDir, 'feedback.md'), `${args.text.trim()}\n`);
    writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ ...runJson, feedback: args.text.trim() }, null, 2));
  }
  const configFull = path.isAbsolute(args.config) ? args.config : path.join(args.root, args.config);
  const config = existsSync(configFull) ? JSON.parse(readFileSync(configFull, 'utf-8')) : null;
  const sent = await recordFeedback({ outDir, runId, feedback: args.text.trim(), settings: telemetrySettings(config) });
  console.log(JSON.stringify({ runId, savedTo: runDir ? path.relative(args.root, runDir) : null, sent }, null, 2));
}

function isRunDirectly() {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch((err) => {
    console.error(`record-feedback.mjs crashed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
