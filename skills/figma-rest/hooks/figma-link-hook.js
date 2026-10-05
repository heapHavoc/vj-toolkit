#!/usr/bin/env node
/**
 * UserPromptSubmit hook — routes pasted Figma links / Dev Mode prompts to figma-rest.
 *
 * When the prompt contains a figma.com design link, injects context telling
 * Claude to use the figma-rest skill (REST, quota-free) instead of the official
 * Figma MCP tools. Silent for every other prompt.
 */

'use strict';

const path = require('node:path');
const SCRIPTS = path.join(__dirname, '..', 'scripts');
const { parse } = require(path.join(SCRIPTS, 'parse-figma-input.js'));

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let prompt = '';
  try {
    prompt = JSON.parse(raw).prompt ?? '';
  } catch {
    return;
  }
  if (/^\s*\/(shopify-theme-toolkit:)?figma-rest\b/.test(prompt)) return;

  const { links } = parse(prompt);
  if (!links.length) return;

  const summary = links
    .map((l) => `- ${l.label ?? 'viewport auto'}: fileKey=${l.fileKey} nodeId=${l.nodeId ?? 'MISSING'}`)
    .join('\n');

  const context = [
    'Figma link(s) detected in the user prompt:',
    summary,
    '',
    'Use the `figma-rest` skill (Skill tool, skill: "shopify-theme-toolkit:figma-rest", args: the user\'s message verbatim) when the user wants a design implemented, built, or extracted — this includes the Dev Mode prompt "Implement this design from Figma. @<link>".',
    'For a small lookup (one value, one node to compare against existing code), run `node ' + path.join(SCRIPTS, 'extract-figma-sections.js') + ' --file-key <key> --node-id <id> --feature <current feature> --mode section` and read the dump, or use mcp__figma-rest__get_figma_data.',
    'Do NOT call the official Figma MCP tools (mcp__figma__*, mcp__figma-desktop__*, mcp__claude_ai_Figma__*) — they are capped at 6 calls/month.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
});
