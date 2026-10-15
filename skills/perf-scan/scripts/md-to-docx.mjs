#!/usr/bin/env node
/**
 * md-to-docx.mjs — export a perf report (.md) to a client-ready .docx.
 *
 * House style (the google-document skill): Manrope throughout, black body text,
 * navy 1F3B4D title and headings, bordered tables with a light EEF3F7 header row,
 * US Letter with 0.75" margins, no em dashes. Handles headings, paragraphs with
 * **bold**, bullet and numbered lists (two levels), tables, blockquotes and code.
 *
 * The `docx` npm package is installed once into a per-user folder that survives
 * plugin updates ($PERF_DEPS_DIR, else $CLAUDE_PLUGIN_DATA/perf-deps, else
 * ~/.cache/shopify-theme-toolkit/perf-deps).
 *
 * Usage: node md-to-docx.mjs --in report.md [--out report.docx] [--subtitle "Performance Audit | site | Month YYYY"]
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRAND = '1F3B4D';
const LIGHT = 'EEF3F7';
const BLACK = '000000';
const FONT = 'Manrope';
const TABLE_TOTAL = 10080;

export function depsDir(env = process.env) {
  if (env.PERF_DEPS_DIR) return env.PERF_DEPS_DIR;
  if (env.CLAUDE_PLUGIN_DATA) return path.join(env.CLAUDE_PLUGIN_DATA, 'perf-deps');
  return path.join(os.homedir(), '.cache', 'shopify-theme-toolkit', 'perf-deps');
}

function loadDocx() {
  for (const dir of [SCRIPTS_DIR, depsDir()]) {
    try {
      return createRequire(path.join(dir, 'package.json'))('docx');
    } catch {}
  }
  const dir = depsDir();
  process.stderr.write(`[md-to-docx] installing the docx package into ${dir} (one time)…\n`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(SCRIPTS_DIR, 'package.json'), path.join(dir, 'package.json'));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
  return createRequire(path.join(dir, 'package.json'))('docx');
}

export function clean(t) {
  return String(t)
    .replace(/^\s*—\s*$/, '-')
    .replace(/\s+—\s+/g, ', ')
    .replace(/—/g, '-')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\\\|/g, '|');
}

export const splitRow = (l) =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** Markdown → a flat list of blocks; kept separate from docx so it can be tested without the package. */
export function parseMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let title = null;
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^#\s/.test(line) && title == null) {
      flush();
      title = line.replace(/^#\s+/, '').trim();
      i++;
    } else if (line.startsWith('```')) {
      flush();
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) blocks.push({ type: 'code', text: lines[i++] });
      i++;
    } else if (/^#{1,2}\s/.test(line)) {
      flush();
      blocks.push({ type: 'h1', text: line.replace(/^#+\s*/, '') });
      i++;
    } else if (/^#{3,6}\s/.test(line)) {
      flush();
      blocks.push({ type: 'h2', text: line.replace(/^#+\s*/, '') });
      i++;
    } else if (/^\s*\|/.test(line)) {
      flush();
      const headers = splitRow(line);
      i += /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '') ? 2 : 1;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', headers, rows });
    } else if (/^\s*>\s?/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: q.join(' ').trim() });
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      i++;
    } else {
      const li = line.match(/^(\s*)([-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.*)$/);
      if (li) {
        flush();
        let text = li[3];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) text += ` ${lines[i++].trim()}`;
        blocks.push({ type: 'li', text, level: li[1].length >= 2 ? 1 : 0, numbered: /\d+\./.test(li[2]) });
      } else if (!line.trim()) {
        flush();
        i++;
      } else {
        para.push(line.trim());
        i++;
      }
    }
  }
  flush();
  return { title: title || 'Report', blocks };
}

function widthsFor(headers, rows) {
  const n = headers.length;
  const presets = { 1: [TABLE_TOTAL], 2: [3000, 7080], 3: [2600, 2900, 4580] };
  if (presets[n]) return presets[n];
  const lens = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || '').length)));
  const weights = lens.map((l) => Math.max(8, Math.min(l, 60)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = weights.map((x) => Math.floor((TABLE_TOTAL * x) / sum));
  w[w.length - 1] += TABLE_TOTAL - w.reduce((a, b) => a + b, 0);
  return w;
}

export async function convert(mdPath, outPath, subtitle) {
  const D = loadDocx();
  const { title, blocks } = parseMarkdown(readFileSync(mdPath, 'utf-8'));
  const runs = (text, base = {}) =>
    clean(text)
      .split(/(\*\*[^*]+\*\*)/g)
      .filter(Boolean)
      .map((part) => {
        const bold = part.startsWith('**') && part.endsWith('**');
        return new D.TextRun({ text: bold ? part.slice(2, -2) : part, bold: bold || base.bold, italics: false, size: base.size, color: BLACK, font: FONT });
      });
  const heading = (text, level) => new D.Paragraph({ heading: level === 1 ? D.HeadingLevel.HEADING_1 : D.HeadingLevel.HEADING_2, spacing: { before: level === 1 ? 360 : 280, after: level === 1 ? 160 : 120 }, children: [new D.TextRun({ text: clean(text).replace(/\*\*/g, ''), color: BRAND, bold: true, font: FONT })] });
  const cell = (text, { bold = false, fill = null, width }) =>
    new D.TableCell({
      width: { size: width, type: D.WidthType.DXA },
      shading: fill ? { type: D.ShadingType.CLEAR, fill, color: 'auto' } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new D.Paragraph({ children: runs(text, { bold, size: 20 }) })],
    });
  const children = [];
  for (const b of blocks) {
    if (b.type === 'h1') children.push(heading(b.text, 1));
    else if (b.type === 'h2') children.push(heading(b.text, 2));
    else if (b.type === 'p') children.push(new D.Paragraph({ spacing: { after: 120 }, children: runs(b.text) }));
    else if (b.type === 'quote') children.push(new D.Paragraph({ spacing: { after: 120 }, indent: { left: 360 }, children: runs(b.text) }));
    else if (b.type === 'code') children.push(new D.Paragraph({ spacing: { after: 40 }, indent: { left: 360 }, children: [new D.TextRun({ text: clean(b.text) || ' ', size: 20, color: BLACK, font: FONT })] }));
    else if (b.type === 'li') children.push(new D.Paragraph({ numbering: { reference: b.numbered ? 'numbers' : 'bullets', level: b.level }, spacing: { after: 80 }, children: runs(b.text) }));
    else if (b.type === 'table') {
      const widths = widthsFor(b.headers, b.rows);
      children.push(
        new D.Table({
          columnWidths: widths,
          width: { size: TABLE_TOTAL, type: D.WidthType.DXA },
          rows: [
            new D.TableRow({ tableHeader: true, children: b.headers.map((t, i) => cell(t, { bold: true, fill: LIGHT, width: widths[i] })) }),
            ...b.rows.map((r) => new D.TableRow({ children: b.headers.map((_, i) => cell(r[i] || '', { width: widths[i] })) })),
          ],
        })
      );
      children.push(new D.Paragraph({ spacing: { after: 120 }, children: [] }));
    }
  }
  const bulletLevels = (ref) => [
    { level: 0, format: ref === 'numbers' ? D.LevelFormat.DECIMAL : D.LevelFormat.BULLET, text: ref === 'numbers' ? '%1.' : '•', alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: ref === 'numbers' ? 300 : 240 } } } },
    { level: 1, format: D.LevelFormat.BULLET, text: '◦', alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 960, hanging: 240 } } } },
  ];
  const doc = new D.Document({
    numbering: { config: [{ reference: 'bullets', levels: bulletLevels('bullets') }, { reference: 'numbers', levels: bulletLevels('numbers') }] },
    styles: {
      default: { document: { run: { font: FONT, size: 22, color: BLACK } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, font: FONT, color: BRAND }, paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 26, bold: true, font: FONT, color: BRAND }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
        children: [
          new D.Paragraph({ spacing: { after: 60 }, children: [new D.TextRun({ text: clean(title), bold: true, size: 48, color: BRAND, font: FONT })] }),
          ...(subtitle ? [new D.Paragraph({ spacing: { after: 300 }, children: [new D.TextRun({ text: clean(subtitle), size: 22, color: BLACK, font: FONT })] })] : []),
          ...children,
        ],
      },
    ],
  });
  const buf = await D.Packer.toBuffer(doc);
  writeFileSync(outPath, buf);
  return { outPath, bytes: buf.length };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') out.in = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--subtitle') out.subtitle = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else return { error: `Unknown argument "${a}".` };
  }
  if (!out.help && !out.in) return { error: '--in is required.' };
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write('Usage: node md-to-docx.mjs --in report.md [--out report.docx] [--subtitle "..."]\n');
  if (args.error) {
    process.stderr.write(`md-to-docx: ${args.error}\n`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(args.in)) {
    process.stderr.write(`md-to-docx: ${args.in} not found.\n`);
    process.exitCode = 2;
    return;
  }
  const out = args.out || args.in.replace(/\.md$/i, '') + '.docx';
  const r = await convert(args.in, out, args.subtitle);
  process.stdout.write(`${JSON.stringify(r)}\n`);
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
    process.stderr.write(`md-to-docx crashed: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
