// Reads every agent's local logs and prints usage sums as JSON, for the ai-usage panel.
// Runs under Node (the panel starts it with `exec`), so the panel never parses hundreds of MB itself.
// Files already read are skipped by size and modification time (cache in Herdr's data folder).
// Only usage figures leave this script: models, token counts, days, project folder names, git branches.
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseClaude, parseGemini, parseCodex, mergeDays, projectOf } from "./lib/usage.js";

const HOME = homedir();
// Claude Code deletes its transcripts after 30 days by default. What a deleted file added up to stays in
// the cache (usage figures only) for KEEP_DAYS after its last activity, so long periods keep their history.
const KEEP_DAYS = 400;
const CACHE = join(process.env.HERDR_APP_HOME ?? join(HOME, ".config/herdr-app"), "data/ai-usage/cache.json");
const CACHE_VERSION = 5;

const SOURCES = [
  { provider: "anthropic", root: join(HOME, ".claude/projects"), match: (p) => p.endsWith(".jsonl"), parse: parseClaude },
  { provider: "google", root: join(HOME, ".gemini/tmp"), match: (p) => /\/chats\/[^/]+\.jsonl?$/.test(p), parse: parseGemini },
  { provider: "openai", root: join(HOME, ".codex/sessions"), match: (p) => /rollout-[^/]+\.jsonl$/.test(p), parse: parseCodex },
];

async function walk(dir, match, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) await walk(path, match, out);
    else if (e.isFile() && match(path)) {
      const s = await stat(path).catch(() => null);
      if (s) out.push({ path, size: s.size, mtimeMs: s.mtimeMs });
    }
  }
  return out;
}

async function loadCache() {
  try {
    const c = JSON.parse(await readFile(CACHE, "utf8"));
    return c.version === CACHE_VERSION ? c.files : {};
  } catch { return {}; }
}

// The plan Claude Code's login records: plan fields only, never the email or name.
async function claudePlan() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? HOME;
    const a = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")).oauthAccount;
    if (!a) return null;
    return { organizationType: a.organizationType ?? null, seatTier: a.seatTier ?? null,
      rateLimitTier: a.userRateLimitTier ?? a.organizationRateLimitTier ?? null, extraUsage: a.hasExtraUsageEnabled === true };
  } catch { return null; }
}

const installed = async (path) => Boolean(await stat(path).catch(() => null));

const firstDay = (days) => Object.keys(days).sort()[0] ?? null;

// A folder's project: the repository it is in (the nearest folder holding .git; a worktree counts as
// its repository through projectOf), else the folder itself.
const roots = new Map();
async function projectFor(cwd) {
  if (!cwd) return null;
  if (roots.has(cwd)) return roots.get(cwd);
  let dir = cwd, found = null;
  while (dir && dir !== "/" && dir !== HOME) {
    if (await installed(join(dir, ".git"))) { found = dir; break; }
    dir = join(dir, "..");
  }
  const project = projectOf(found ?? cwd);
  roots.set(cwd, project);
  return project;
}

// { project: { days, branches, sub } } from a parse's { folder: { days, branches } }. `sub` holds the
// subagents' share of the same, which `days` and `branches` include.
async function byProject(places, fallback, days) {
  const out = {};
  const entries = places ? Object.entries(places) : [[null, { days, branches: {} }]];
  for (const [cwd, place] of entries) {
    const name = (await projectFor(cwd)) ?? fallback ?? "other";
    const into = (out[name] ??= { days: {}, branches: {} });
    mergeDays(into.days, place.days);
    for (const [branch, d] of Object.entries(place.branches ?? {})) mergeDays((into.branches[branch] ??= {}), d);
  }
  return out;
}

function mergeProjects(target, projects, isSubagent = false) {
  for (const [name, p] of Object.entries(projects)) {
    const into = (target[name] ??= { days: {}, branches: {}, sub: { days: {}, branches: {} } });
    into.sub ??= { days: {}, branches: {} };
    for (const box of isSubagent ? [into, into.sub] : [into]) {
      mergeDays(box.days, p.days);
      for (const [branch, d] of Object.entries(p.branches)) mergeDays((box.branches[branch] ??= {}), d);
    }
  }
  return target;
}

async function main() {
  const keepSince = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  const cached = await loadCache(), next = {};
  const sessions = new Map(), limits = {};
  let read = 0;
  for (const src of SOURCES) {
    const found = await walk(src.root, src.match, []);
    const present = new Set(found.map((f) => f.path));
    // Files the agent has deleted since: their saved totals, while still within KEEP_DAYS.
    const gone = Object.entries(cached)
      .filter(([path, c]) => path.startsWith(src.root) && !present.has(path) && Date.parse(c.result?.last ?? 0) >= keepSince)
      .map(([path, c]) => ({ path, size: c.size, mtimeMs: c.mtimeMs, archived: true }));
    const files = [...found, ...gone];
    const subagentFiles = [];
    for (const f of files) {
      const hit = cached[f.path];
      let result = hit && (f.archived || (hit.size === f.size && hit.mtimeMs === f.mtimeMs)) ? hit.result : null;
      if (!result && f.archived) continue;
      if (!result) {
        try { result = src.parse(await readFile(f.path, "utf8")); read++; } catch { continue; }
      }
      next[f.path] = { size: f.size, mtimeMs: f.mtimeMs, result, ...(f.archived ? { archived: true } : {}) };
      if (!Object.keys(result.days).length) continue;
      if (result.limits && (!limits[src.provider] || result.limits.at > limits[src.provider].at)) limits[src.provider] = result.limits;
      // Claude writes a subagent's transcript under <session id>/subagents/: it joins its session below.
      if (f.path.includes("/subagents/")) { subagentFiles.push({ f, result }); continue; }
      const id = `${src.provider}:${result.session ?? basename(f.path).replace(/\.jsonl?$/, "")}`;
      // Gemini keeps chats under ~/.gemini/tmp/<project>/chats.
      const fallback = src.provider === "google" ? basename(join(f.path, "../..")) : null;
      const project = (await projectFor(result.cwd)) ?? fallback;
      const projects = await byProject(result.places ?? (result.cwd ? { [result.cwd]: { days: result.days, branches: {} } } : null), fallback, result.days);
      const prev = sessions.get(id);
      sessions.set(id, {
        id, provider: src.provider, project, branch: result.branch ?? null,
        first: firstDay(result.days), last: result.last ?? new Date(f.mtimeMs).toISOString(),
        days: prev ? mergeDays(prev.days, result.days) : result.days,
        projects: mergeProjects(prev?.projects ?? {}, projects),
        subagents: prev?.subagents ?? { count: 0, days: {} },
      });
    }
    for (const { f, result } of subagentFiles) {
      const parent = sessions.get(`${src.provider}:${basename(join(f.path, "../.."))}`);
      if (!parent) continue;
      parent.subagents.count++;
      mergeDays(parent.subagents.days, result.days);
      mergeProjects(parent.projects, await byProject(result.places, parent.project, result.days), true);
    }
  }
  await mkdir(join(CACHE, ".."), { recursive: true });
  await writeFile(CACHE, JSON.stringify({ version: CACHE_VERSION, files: next }));
  const out = {
    generatedAt: new Date().toISOString(),
    read,
    installed: {
      anthropic: await installed(join(HOME, ".claude")),
      google: await installed(join(HOME, ".gemini")),
      openai: await installed(join(HOME, ".codex")),
    },
    claudePlan: await claudePlan(),
    limits,
    keepDays: KEEP_DAYS,
    sessions: [...sessions.values()].sort((a, b) => String(b.last).localeCompare(String(a.last))),
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => { process.stderr.write(String(e?.stack ?? e)); process.exit(1); });
