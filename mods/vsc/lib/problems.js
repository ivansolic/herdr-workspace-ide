// Which checks a folder has, and their output turned into one list of problems.
// Pure: no herdr imports, so it runs under node --test.
import { plainPath } from "./search.js";

export const PROBLEM_LIMIT = 1000;

// What a trust covers: the real folder and its device:inode (two spellings of one folder share it, a
// different folder later made at the same path is asked about again; on Linux a reused inode can
// carry it over), and the exact commands the prompt listed, so changed checks are asked about again.
// The record the Problems view trusts, from detect(): it must carry the checks for trustKey to cover them.
export const folderRecord = ({ realRoot, id, tools }) => ({ realRoot, id, tools });
export const trustKey = (on, folder) => `${on ?? ""}|${folder.realRoot}|${folder.id ?? ""}|${JSON.stringify((folder.tools ?? []).map(t => t.argv))}`;
// Shared key: { errors, warnings } of the folder the Problems view shows, for the rail's badge.
export const PROBLEM_COUNT = "vsc.problems";

const ESLINT_CONFIGS = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts",
  "eslint.config.cts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"];
const RUFF_CONFIGS = ["ruff.toml", ".ruff.toml"];

// Every path `detectTools` may ask about (relative to the folder), to check them in one call.
export const TOOL_FILES = ["tsconfig.json", "node_modules/.bin/tsc", "node_modules/.bin/eslint", ".venv/bin/ruff",
  "pyproject.toml", ...ESLINT_CONFIGS, ...RUFF_CONFIGS];

// [{ source, argv }] for the folder: only tools the project installs itself (Ruff may come from
// PATH, as it is installed per user, and then runs by its full path), never npx, which would
// download one. `present` holds the TOOL_FILES that exist; `tscConfigs` comes from tscTargets.
export function detectTools(present, { ruffPath = null, pyprojectRuff = false, tscConfigs = [] } = {}) {
  const tools = [];
  if (present.has("tsconfig.json") && present.has("node_modules/.bin/tsc"))
    for (const config of tscConfigs) tools.push({ source: "tsc", argv: ["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", config] });
  if (present.has("node_modules/.bin/eslint") && ESLINT_CONFIGS.some(f => present.has(f)))
    tools.push({ source: "eslint", argv: ["node_modules/.bin/eslint", "--format", "json", "."] });
  const ruffConfig = RUFF_CONFIGS.some(f => present.has(f)) || (present.has("pyproject.toml") && pyprojectRuff);
  const ruff = present.has(".venv/bin/ruff") ? ".venv/bin/ruff" : ruffPath?.startsWith("/") ? ruffPath : null;
  if (ruffConfig && ruff) tools.push({ source: "ruff", argv: [ruff, "check", "--output-format", "json", "--no-cache", "."] });
  return tools;
}

// JSON with comments and trailing commas, as tsconfig files are written; null when it does not parse.
// One pass that knows where strings are: comments and trailing commas are dropped outside them only.
export function parseJsonc(text) {
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i++; } else if (ch === '"') inString = false;
    } else if (ch === '"') { inString = true; out += ch; }
    else if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (ch === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; }
    else {
      // A closing bracket drops a comma just before it (outside strings, out never ends inside one).
      if (ch === "}" || ch === "]") { const end = out.trimEnd(); if (end.endsWith(",")) out = end.slice(0, -1); }
      out += ch;
    }
  }
  try { return JSON.parse(out); } catch { return null; }
}

// The configs tsc checks ({ configs, skipped }). A solution-style tsconfig.json (no files or include
// of its own, only references, as Vite writes it) checks nothing itself: each reference inside the
// folder is checked instead; references outside it are named in `skipped`, not run.
export function tscTargets(tsconfigText) {
  const config = parseJsonc(tsconfigText ?? "");
  const solution = config && Array.isArray(config.references) && config.references.length
    && Array.isArray(config.files) && config.files.length === 0
    && (config.include === undefined || (Array.isArray(config.include) && config.include.length === 0));
  if (!solution) return { configs: ["tsconfig.json"], skipped: [] };
  const configs = [], skipped = [];
  for (const ref of config.references) {
    const path = String(ref?.path ?? "").replace(/^\.\//, "").replace(/\/$/, "");
    if (!plainPath(path)) { skipped.push(String(ref?.path ?? "")); continue; }
    configs.push(path.endsWith(".json") ? path : `${path}/tsconfig.json`);
  }
  return { configs, skipped };
}

const problem = (file, line, col, severity, message, source, code) => ({ file, line, col, severity, message, source, code });

// tsc --pretty false: "path(line,col): error TS1234: message", continued on indented lines.
export function parseTsc(out) {
  const problems = [];
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line);
    if (m) problems.push(problem(m[1], Number(m[2]), Number(m[3]), m[4], m[6], "tsc", m[5]));
    else if (/^\s+\S/.test(line) && problems.length) problems[problems.length - 1].message += ` ${line.trim()}`;
  }
  return problems;
}

// eslint --format json. Anything else (a crash message) is an error to show, not an empty list.
export function parseEslint(out) {
  let files;
  try { files = JSON.parse(out); } catch { throw new Error(`ESLint did not report results: ${out.trim().split("\n")[0] ?? ""}`); }
  return files.flatMap(f => (f.messages ?? []).map(m =>
    problem(f.filePath, m.line ?? 1, m.column ?? 1, m.severity === 2 || m.fatal ? "error" : "warning", m.message, "eslint", m.ruleId ?? null)));
}

// ruff check --output-format json. Lint findings are warnings; a syntax error (no code) is an error.
export function parseRuff(out) {
  let items;
  try { items = JSON.parse(out); } catch { throw new Error(`Ruff did not report results: ${out.trim().split("\n")[0] ?? ""}`); }
  return items.map(d => problem(d.filename, d.location?.row ?? 1, d.location?.column ?? 1, d.code ? "warning" : "error", d.message, "ruff", d.code ?? null));
}

// A tool's path in the folder's own spelling (`root`, as Explorer shows it): tools report paths
// relative to the folder, or absolute under its real path (`realRoot`, symlinks resolved).
export function toRootPath(path, root, realRoot) {
  if (!path.startsWith("/")) return `${root}/${path}`;
  for (const base of [root, realRoot]) if (path.startsWith(`${base}/`)) return `${root}${path.slice(base.length)}`;
  return path;
}

// Opens VS Code at the line and column (or the file or folder alone).
export function vscodeUrl(path, line, col) {
  const encoded = encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return `vscode://file${encoded}${line ? `:${line}:${col ?? 1}` : ""}`;
}

const rank = (p) => p.severity === "error" ? 0 : 1;

// { files: [{ file, problems }], errors, warnings, truncated }: files with errors first, errors
// first within a file, then by line; at most PROBLEM_LIMIT problems kept (the counts are of all).
export function groupByFile(problems) {
  const errors = problems.filter(p => p.severity === "error").length;
  const kept = [...problems].sort((a, b) => rank(a) - rank(b) || a.line - b.line).slice(0, PROBLEM_LIMIT);
  const byFile = new Map();
  for (const p of kept) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  const files = [...byFile].map(([file, list]) => ({ file, problems: list }))
    .sort((a, b) => rank(a.problems[0]) - rank(b.problems[0]) || a.file.localeCompare(b.file));
  return { files, errors, warnings: problems.length - errors, truncated: problems.length > PROBLEM_LIMIT };
}
