// The shell scripts Search and Quick Open run, tried on a temporary folder with the system's sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIND, GREP, SIZES, REAL_FOLDERS, DETECT, RUN_BACKGROUND, privateFolderArgs } from "../mods/vsc/lib/scripts.js";

const sh = (script, ...args) => {
  try { return execFileSync("sh", ["-c", script, "vsc", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return e.stdout ?? ""; }
};
const names = (out) => out.split("\0").filter(Boolean).sort();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vsc-listing-"));
  const outside = mkdtempSync(join(tmpdir(), "vsc-outside-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src", "a.txt"), "Hello world\n");
  writeFileSync(join(root, "-dash.txt"), "hello\n");
  writeFileSync(join(root, "b.txt"), "nothing\n");
  writeFileSync(join(root, "big.txt"), Buffer.alloc(1048577, 97));
  writeFileSync(join(root, ".git", "config"), "hello\n");
  writeFileSync(join(outside, "secret.txt"), "hello\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "linked"));
  return { root, outside };
}

test("listing: files under the folder, .git skipped, links not followed", () => {
  const { root } = fixture();
  assert.deepEqual(names(sh(FIND, root)), ["./-dash.txt", "./b.txt", "./big.txt", "./src/a.txt"]);
});

test("grep narrowing: text as an argument, any case with -is, names starting with - are files", () => {
  const { root } = fixture();
  assert.deepEqual(names(sh(GREP, root, "-is", "hello", "src/a.txt", "-dash.txt", "b.txt", "gone.txt")), ["-dash.txt", "src/a.txt"]);
  assert.deepEqual(names(sh(GREP, root, "-s", "hello", "src/a.txt", "-dash.txt")), ["-dash.txt"]);
  assert.deepEqual(names(sh(GREP, root, "-is", "-e", "src/a.txt")), []);
});

test("size split: regular files up to 1 MiB, then over it; links and missing files in neither", () => {
  const { root } = fixture();
  const out = sh(SIZES, root, "./src/a.txt", "./big.txt", "./link.txt", "./gone.txt", "./-dash.txt");
  const parts = out.split("\0").filter(Boolean), at = parts.indexOf("--");
  assert.deepEqual(parts.slice(0, at).sort(), ["./-dash.txt", "./src/a.txt"]);
  assert.deepEqual(parts.slice(at + 1), ["./big.txt"]);
});

test("real folders: the root's real path first, then each folder's, empty when it does not exist", () => {
  const { root, outside } = fixture();
  const out = sh(REAL_FOLDERS, root, "./src", "./linked", "./gone").split("\0");
  assert.deepEqual(out.slice(0, 4), [realpathSync(root), realpathSync(join(root, "src")), realpathSync(outside), ""]);
});

test("tool detection: listed files that exist, ruff's full path, a [tool.ruff] table, the real folder and its id", () => {
  const { root } = fixture();
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".bin", "tsc"), "");
  writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'x'\n\n[tool.ruff]\nline-length = 100\n");
  const out = sh(DETECT, root, "tsconfig.json", "node_modules/.bin/tsc", "eslint.config.js").split("\0").filter(Boolean);
  assert.deepEqual(out.filter(e => !e.startsWith("@")), ["tsconfig.json", "node_modules/.bin/tsc"]);
  assert.ok(out.includes("@pyproject-ruff"));
  assert.ok(out.includes(`@real=${realpathSync(root)}`));
  const st = statSync(root);
  assert.ok(out.includes(`@id=${st.dev}:${st.ino}`), out.join(" "));
});

test("background run: in the real folder only, returns at once with the pid, then output and exit code", async () => {
  const { root } = fixture();
  const real = realpathSync(root), base = join(real, "run");
  const pid = sh(RUN_BACKGROUND, real, base, "60", "sh", "-c", "pwd -P; sleep 1; echo err >&2; exit 3").trim();
  assert.match(pid, /^\d+$/);
  for (let i = 0; i < 50 && !existsSync(`${base}.code`); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(readFileSync(`${base}.code`, "utf8").trim(), "3");
  assert.equal(readFileSync(`${base}.out`, "utf8"), `${real}\n`);
  assert.equal(readFileSync(`${base}.err`, "utf8"), "err\n");
});

test("background run: refuses a folder that is not its own real path (a symlink)", () => {
  const { root, outside } = fixture();
  const link = join(root, "linked");
  assert.equal(sh(RUN_BACKGROUND, link, join(outside, "run"), "60", "true").trim(), "");
});

test("background run: the time limit stops the program even with nobody waiting", async () => {
  const { root } = fixture();
  const real = realpathSync(root), base = join(real, "slow");
  sh(RUN_BACKGROUND, real, base, "1", "sleep", "30");
  for (let i = 0; i < 50 && !existsSync(`${base}.code`); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(existsSync(`${base}.code`), "stopped within 5 s");
  assert.equal(readFileSync(`${base}.code`, "utf8").trim(), "timeout");
});

test("private folder: the exact chmod arguments work with the system's chmod (BSD takes -- only before the mode)", () => {
  const { root } = fixture();
  execFileSync("chmod", privateFolderArgs(root));
  assert.equal(statSync(root).mode & 0o777, 0o700);
});
