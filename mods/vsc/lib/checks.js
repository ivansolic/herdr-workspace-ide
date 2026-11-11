// Runs a folder's checks (tsc, ESLint, Ruff) in the background and reads their problems.
// exec stops a program after 30 s, so each check runs detached with its output in vsc-cache;
// the view waits for the exit-code file.
import * as fs from "fs/promises";
import { exec, readTextFile, shared, setShared } from "herdr";
import { failure } from "./git.js";
import { DETECT, RUN_BACKGROUND } from "./scripts.js";
import { TOOL_FILES, trustKey, detectTools, tscTargets, parseTsc, parseEslint, parseRuff, toRootPath, vscodeUrl } from "./problems.js";
import { ensureFolder, CACHE } from "./storage.js";

const TRUSTED = "vsc.trusted"; // ["<machine>|<real folder path>|<device:inode>", ...]
// The run script stops a check after LIMIT_S; the panel stops waiting a little later in any case.
const POLL_MS = 500, LIMIT_S = 600, MAX_MS = (LIMIT_S + 60) * 1000;
const PARSERS = { tsc: parseTsc, eslint: parseEslint, ruff: parseRuff };

// { tools: [{ source, argv }], realRoot, id, skipped } for the folder: `id` is its device:inode,
// `skipped` the tsconfig references outside it, which are not checked.
export async function detect(root, on) {
  const r = await exec("sh", ["-c", DETECT, "vsc", root, ...TOOL_FILES], { on });
  if (r.code !== 0) throw new Error(failure(r));
  const entries = r.stdout.split("\0").filter(Boolean), value = (name) => entries.find(e => e.startsWith(`@${name}=`))?.slice(name.length + 2) ?? null;
  const realRoot = value("real") ?? root, present = new Set(entries);
  const tsconfig = present.has("tsconfig.json") ? await readTextFile(`${realRoot}/tsconfig.json`, { on }).catch(() => null) : null;
  const { configs, skipped } = tscTargets(tsconfig);
  const tools = detectTools(present, { ruffPath: value("ruff"), pyprojectRuff: present.has("@pyproject-ruff"), tscConfigs: configs });
  return { tools, realRoot, id: value("id"), skipped };
}


export function isTrusted(on, folder) {
  return Boolean(folder?.id) && (shared(TRUSTED) ?? []).includes(trustKey(on, folder));
}

export function setTrusted(on, folder, trusted) {
  const key = trustKey(on, folder), rest = (shared(TRUSTED) ?? []).filter(k => k !== key);
  setShared(TRUSTED, trusted ? [...rest, key] : rest);
}

let runs = 0;

// Starts one check in the real folder; { source, base, pid }. The script refuses when the folder's
// real path is no longer `realRoot` (a symlink retargeted since the folder was trusted).
async function start(realRoot, tool) {
  const base = `${await ensureFolder(CACHE)}/problems-${Date.now()}-${++runs}-${tool.source}`;
  const r = await exec("sh", ["-c", RUN_BACKGROUND, "vsc", realRoot, base, String(LIMIT_S), ...tool.argv]);
  if (r.code === 3) throw new Error("the folder now leads somewhere else; check it again.");
  if (r.code !== 0) throw new Error(failure(r));
  return { source: tool.source, base, pid: r.stdout.trim() };
}

// Stops a running check: the program, then the shell waiting for it.
export async function stop(run) {
  if (!/^\d+$/.test(run.pid)) return;
  await exec("sh", ["-c", 'pkill -P "$1" 2>/dev/null; kill "$1" 2>/dev/null; true', "vsc", run.pid]).catch(e => console.log(`vsc: could not stop ${run.source}: ${e?.message ?? e}`));
}

async function drop(base) {
  for (const ext of [".out", ".err", ".code", ".timeout"]) await fs.unlink(`${base}${ext}`).catch(() => null);
}

// Waits for one check to end ({ problems } or { error }); `alive()` false stops waiting (and the check).
async function finish(run, root, realRoot, cx, alive) {
  const started = Date.now();
  try {
    for (;;) {
      const code = (await fs.readFile(`${run.base}.code`, "utf8").catch(() => "")).trim();
      if (code === "timeout") return { error: `${run.source} took longer than ${LIMIT_S / 60} minutes and was stopped.` };
      if (code !== "") {
        const out = await fs.readFile(`${run.base}.out`, "utf8").catch(() => "");
        const err = await fs.readFile(`${run.base}.err`, "utf8").catch(() => "");
        const problems = out.trim() === "" ? [] : PARSERS[run.source](out);
        // A failed run that names no problem (a broken config, a crash) is an error, never "no problems".
        if (code !== "0" && !problems.length) return { error: `${run.source} failed (exit ${code}): ${(err.trim() || out.trim() || "no output").split("\n")[0]}` };
        return { problems: problems.map(p => ({ ...p, file: toRootPath(p.file, root, realRoot) })) };
      }
      if (!alive()) { await stop(run); return { stopped: true }; }
      if (Date.now() - started > MAX_MS) { await stop(run); return { error: `${run.source} took longer than ${LIMIT_S / 60} minutes and was stopped.` }; }
      await cx.sleep(POLL_MS);
    }
  } catch (e) {
    return { error: `${run.source}: ${e?.message ?? e}` };
  } finally {
    await drop(run.base);
  }
}

// Runs every tool at once; { problems, errors: [message] }, or null when `alive()` turned false.
export async function runChecks(root, realRoot, tools, cx, alive) {
  const started = await Promise.all(tools.map(tool => start(realRoot, tool).catch(e => ({ source: tool.source, failed: String(e?.message ?? e) }))));
  const results = await Promise.all(started.map(run => run.failed ? { error: `${run.source}: ${run.failed}` } : finish(run, root, realRoot, cx, alive)));
  if (results.some(r => r.stopped)) return null;
  // Two tsconfigs can include the same file: each problem is listed once.
  const seen = new Set(), problems = results.flatMap(r => r.problems ?? []).filter(p => {
    const key = JSON.stringify([p.file, p.line, p.col, p.source, p.code, p.message]);
    return !seen.has(key) && seen.add(key);
  });
  return { problems, errors: results.filter(r => r.error).map(r => r.error) };
}

// Opens VS Code at the line (or the file or folder alone): its `code` command first, which also
// works without the vscode:// handler, else the system's URL opener.
export async function openInVSCode(path, line, col) {
  if (!path.startsWith("/")) throw new Error(`Not an absolute path: ${path}`);
  const args = line ? ["--goto", `${path}:${line}:${col ?? 1}`] : [path];
  const viaCode = await exec("code", args).catch(() => null);
  if (viaCode?.code === 0) return;
  // macOS opens URLs with `open`; on Linux `open` is often openvt, so only xdg-open is used there.
  const os = await exec("uname", ["-s"]).catch(() => null);
  const opener = os?.stdout.trim() === "Darwin" ? "open" : "xdg-open";
  const r = await exec(opener, [vscodeUrl(path, line, col)]).catch(() => null);
  if (r?.code === 0) return;
  throw new Error("VS Code could not be opened: its `code` command is not on PATH and no app opens vscode:// links.");
}
