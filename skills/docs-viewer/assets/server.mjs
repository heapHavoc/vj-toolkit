// Docs viewer — editorial board + reader for a project's docs/ folder.
// Runs from the skill directory against the current working directory:
//   node ~/.claude/skills/docs-viewer/assets/server.mjs
// Env: DOCS_VIEWER_PORT (default 4488), DOCS_DIR (default <cwd>/docs),
//      ROADMAP_DIR (folder name under DOCS, default "roadmap")
//
// Conventions it understands (all optional, degrades gracefully):
//   docs/*.md                                  -> core documents
//   docs/<roadmap>/phase-<N>-<slug>/overview.md  -> phase title
//   docs/<roadmap>/phase-<N>-<slug>/X.Y-*.md     -> specification cards
//   docs/<roadmap>/status-log.md with entries    -> delivery status (source of truth)
//     ## YYYY-MM-DD — X.Y Title — ✅ Complete

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const DOCS = process.env.DOCS_DIR ? path.resolve(process.env.DOCS_DIR) : path.join(ROOT, "docs");
const PORT = Number(process.env.DOCS_VIEWER_PORT || 4488);
// One roadmap folder per track. Point at another with ROADMAP_DIR=roadmap-pdp.
const ROADMAP = (process.env.ROADMAP_DIR || "roadmap").replace(/^\/+|\/+$/g, "");

// ---------- project name ----------

function titleCase(s) {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function projectName() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    if (pkg.name) return titleCase(pkg.name);
  } catch {}
  return titleCase(path.basename(ROOT));
}

// ---------- parsing ----------

async function readDoc(relPath) {
  return readFile(path.join(DOCS, relPath), "utf8");
}

const KNOWN_TITLES = {
  "prd.md": "Product Requirements (PRD)",
  "tdd.md": "Technical Design (TDD)",
  "api-contract.md": "API Contract",
  "readme.md": "README",
  "status-log.md": "Status Log",
};

function docTitle(fileName, content) {
  const known = KNOWN_TITLES[fileName.toLowerCase()];
  if (known) return known;
  const h1 = content.match(/^# (.+)$/m)?.[1];
  if (h1) return h1.trim();
  return titleCase(fileName.replace(/\.md$/i, ""));
}

// Entries look like: ## 2026-08-04 — 3.1 Ingestion API Endpoint — ✅ Complete
function parseStatusLog(md) {
  const entries = {};
  if (!md) return entries;
  const headingRe = /^## (\d{4}-\d{2}-\d{2}) — (\d+\.\d+) (.+?) — (.+)$/gm;
  const matches = [...md.matchAll(headingRe)];
  matches.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : md.length;
    const [, date, id, title, statusText] = m;
    entries[id] = {
      date,
      id,
      title: title.trim(),
      statusText: statusText.trim(),
      complete: /complete/i.test(statusText),
      body: md.slice(start, end).trim(),
    };
  });
  return entries;
}

// PRD files may start with: # PRD: 3.1 — Title   then **Key:** value lines.
function parsePrdHead(md) {
  const head = md.slice(0, 1500);
  const title =
    head.match(/^# (?:PRD:\s*)?[\d.]+\s*[—-]\s*(.+)$/m)?.[1]?.trim() ??
    head.match(/^# (.+)$/m)?.[1]?.trim();
  const meta = {};
  for (const m of head.matchAll(/^\*\*(.+?):\*\*\s*(.+)$/gm)) {
    meta[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return { title, meta };
}

function phaseTitleFromOverview(md, fallback) {
  const h1 = md.match(/^# (.+)$/m)?.[1] ?? fallback;
  return h1.replace(/^Phase \d+:\s*/, "").trim();
}

async function readStatusLog() {
  const rel = `${ROADMAP}/status-log.md`;
  if (!existsSync(path.join(DOCS, rel))) return {};
  return parseStatusLog(await readDoc(rel));
}

async function buildState() {
  if (!existsSync(DOCS)) {
    return { projectName: projectName(), error: "no-docs", coreDocs: [], phases: [], stats: { total: 0, complete: 0 } };
  }

  // core documents: top-level *.md, plus roadmap README / status log if present
  const coreDocs = [];
  const topEntries = await readdir(DOCS, { withFileTypes: true });
  for (const e of topEntries.filter((e) => e.isFile() && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
    const content = await readDoc(e.name);
    coreDocs.push({ path: e.name, title: docTitle(e.name, content) });
  }
  for (const rel of [`${ROADMAP}/README.md`, `${ROADMAP}/status-log.md`]) {
    if (existsSync(path.join(DOCS, rel))) {
      const content = await readDoc(rel);
      const fallback = rel === `${ROADMAP}/README.md` ? "Roadmap & Execution Order" : "Status Log";
      coreDocs.push({ path: rel, title: KNOWN_TITLES[path.basename(rel).toLowerCase()] === "README" ? fallback : docTitle(path.basename(rel), content) });
    }
  }

  // phases
  const phases = [];
  const roadmapDir = path.join(DOCS, ROADMAP);
  if (existsSync(roadmapDir)) {
    const logEntries = await readStatusLog();
    const dirents = await readdir(roadmapDir, { withFileTypes: true });
    const phaseDirs = dirents
      .filter((d) => d.isDirectory() && /^phase-\d+-/.test(d.name))
      .map((d) => ({ name: d.name, num: Number(d.name.match(/^phase-(\d+)-/)[1]) }))
      .sort((a, b) => a.num - b.num);

    for (const { name, num } of phaseDirs) {
      const files = await readdir(path.join(roadmapDir, name));
      const overviewRel = files.includes("overview.md") ? `${ROADMAP}/${name}/overview.md` : null;
      const title = overviewRel
        ? phaseTitleFromOverview(await readDoc(overviewRel), titleCase(name.replace(/^phase-\d+-/, "")))
        : titleCase(name.replace(/^phase-\d+-/, ""));

      const prdFiles = files
        .filter((f) => /^\d+\.\d+-.+\.md$/.test(f))
        .sort((a, b) => Number(a.match(/^\d+\.(\d+)-/)[1]) - Number(b.match(/^\d+\.(\d+)-/)[1]));

      const prds = [];
      for (const f of prdFiles) {
        const id = f.match(/^(\d+\.\d+)-/)[1];
        const rel = `${ROADMAP}/${name}/${f}`;
        const { title: prdTitle, meta } = parsePrdHead(await readDoc(rel));
        const entry = logEntries[id];
        prds.push({
          id,
          path: rel,
          title: prdTitle ?? titleCase(f.replace(/^\d+\.\d+-/, "").replace(/\.md$/, "")),
          priority: meta["priority"] ?? null,
          depends: meta["depends on"] ?? null,
          scope: meta["estimated scope"] ?? null,
          status: entry?.complete ? "complete" : "not_started",
          completedDate: entry?.complete ? entry.date : null,
          hasLogEntry: Boolean(entry),
        });
      }
      phases.push({ num, slug: name, title, overviewPath: overviewRel, prds });
    }
  }

  const allPrds = phases.flatMap((p) => p.prds);
  return {
    projectName: projectName(),
    coreDocs,
    phases,
    stats: {
      total: allPrds.length,
      complete: allPrds.filter((p) => p.status === "complete").length,
    },
  };
}

// ---------- http ----------

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8");
}

// Only .md files inside the docs dir are readable through the API.
function safeDocPath(rel) {
  const resolved = path.resolve(DOCS, rel);
  if (!resolved.startsWith(DOCS + path.sep)) return null;
  if (!resolved.endsWith(".md")) return null;
  return resolved;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/") {
      return send(res, 200, await readFile(path.join(ASSETS, "app.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/vendor/marked.js") {
      return send(res, 200, await readFile(path.join(ASSETS, "vendor", "marked.umd.js"), "utf8"), "application/javascript; charset=utf-8");
    }
    if (url.pathname === "/api/state") {
      return json(res, 200, await buildState());
    }
    if (url.pathname === "/api/doc") {
      const rel = url.searchParams.get("path") ?? "";
      const abs = safeDocPath(rel);
      if (!abs) return json(res, 400, { error: "invalid path" });
      const content = await readFile(abs, "utf8");
      const statusLog = await readStatusLog();
      const id = path.basename(rel).match(/^(\d+\.\d+)-/)?.[1];
      return json(res, 200, { path: rel, content, logEntry: id && statusLog[id] ? statusLog[id].body : null });
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    if (err.code === "ENOENT") return json(res, 404, { error: "not found" });
    console.error(err);
    return json(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`${projectName()} docs viewer -> http://localhost:${PORT}`);
  console.log(`Reading live from ${DOCS}`);
});
