// Explorer's file actions: names, copy names, and the scripts, tried with the system's sh, mv, cp and mkdir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, lstatSync, readdirSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validName, copyName, relativeTo, isInside, intoItself } from "../mods/vsc/lib/fileops.js";
import { FILE_NEW, FOLDER_NEW, ENTRY_MOVE, ENTRY_COPY, ENTRY_TRASH, ENTRY_DELETE, SAFE_PATH } from "../mods/vsc/lib/scripts.js";

const sh = (script, ...args) => {
  try { return { code: 0, out: execFileSync("sh", ["-c", script, "vsc", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, out: e.stdout ?? "" }; }
};

test("names: one path part, not . or .., no control characters, not too long", () => {
  for (const ok of ["a.js", ".env", "My File.md", "čćž.txt", "a..b"]) assert.equal(validName(ok), null, ok);
  for (const bad of ["", " ", "a/b", ".", "..", "a\nb", "a\u0000b", "x".repeat(256), "é".repeat(130)]) assert.equal(typeof validName(bad), "string", JSON.stringify(bad));
});

test("copy names as VS Code makes them, never one that exists", () => {
  assert.equal(copyName("a.js", new Set(["a.js"])), "a copy.js");
  assert.equal(copyName("a.js", new Set(["a.js", "a copy.js"])), "a copy 2.js");
  assert.equal(copyName("src", new Set(["src", "src copy", "src copy 2"])), "src copy 3");
  assert.equal(copyName(".env", new Set([".env"])), ".env copy");
  assert.equal(copyName("b.js", new Set()), "b.js");
});

test("relative paths and inside checks", () => {
  assert.equal(relativeTo("/r/p", "/r/p/src/a.js"), "src/a.js");
  assert.equal(relativeTo("/r/p", "/r/p"), "");
  assert.equal(relativeTo("/r/p", "/r/p2/a"), null);
  assert.equal(isInside("/r/p", "/r/p/src"), true);
  assert.equal(isInside("/r/p", "/r/p"), false);
  assert.equal(isInside("/r/p", "/r/pp"), false);
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vsc-ops-"))), outside = realpathSync(mkdtempSync(join(tmpdir(), "vsc-out-")));
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.js"), "a\n"); writeFileSync(join(root, "b.txt"), "b\n");
  writeFileSync(join(outside, "keep.txt"), "keep\n");
  symlinkSync(outside, join(root, "out"));
  return { root, outside };
}

test("new file and folder: created inside, never over an existing one, never through a link outside", () => {
  const { root, outside } = fixture();
  assert.equal(sh(FILE_NEW, root, "src", "n.js").code, 0);
  assert.equal(readFileSync(join(root, "src", "n.js"), "utf8"), "");
  assert.equal(sh(FILE_NEW, root, "", "b.txt").code, 5);
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b\n");
  assert.equal(sh(FOLDER_NEW, root, "", "lib").code, 0);
  assert.ok(lstatSync(join(root, "lib")).isDirectory());
  assert.equal(sh(FOLDER_NEW, root, "", "lib").code, 5);
  assert.equal(sh(FILE_NEW, root, "out", "x.js").code, 10);
  assert.ok(!existsSync(join(outside, "x.js")));
});

test("move (rename, cut and paste): never over an existing name, stays inside, moves a link not its target", () => {
  const { root, outside } = fixture();
  assert.equal(sh(ENTRY_MOVE, root, "b.txt", "src", "b2.txt").code, 0);
  assert.equal(readFileSync(join(root, "src", "b2.txt"), "utf8"), "b\n");
  assert.ok(!existsSync(join(root, "b.txt")));
  assert.equal(sh(ENTRY_MOVE, root, "src/a.js", "src", "b2.txt").code, 5);
  assert.equal(readFileSync(join(root, "src", "a.js"), "utf8"), "a\n");
  assert.equal(sh(ENTRY_MOVE, root, "src/a.js", "out", "a.js").code, 10);
  assert.equal(sh(ENTRY_MOVE, root, "out", "", "out2").code, 0);
  assert.ok(lstatSync(join(root, "out2")).isSymbolicLink());
  assert.deepEqual(readdirSync(outside), ["keep.txt"]);
});

test("copy: a new entry, never over an existing one, links copied as links", () => {
  const { root, outside } = fixture();
  assert.equal(sh(ENTRY_COPY, root, "src", "", "src copy").code, 0);
  assert.equal(readFileSync(join(root, "src copy", "a.js"), "utf8"), "a\n");
  assert.equal(sh(ENTRY_COPY, root, "b.txt", "", "src copy").code, 5);
  assert.equal(sh(ENTRY_COPY, root, "out", "src", "out").code, 0);
  assert.ok(lstatSync(join(root, "src", "out")).isSymbolicLink());
  assert.equal(sh(ENTRY_COPY, root, "b.txt", "out", "b.txt").code, 10);
  assert.deepEqual(readdirSync(outside), ["keep.txt"]);
});

// A stub folder of programs: each logs its arguments to <name>.log and succeeds.
function stubs(names, { uname = "Linux" } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "vsc-bin-"));
  for (const name of names) { writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/${name}.log"\n`); chmodSync(join(bin, name), 0o755); }
  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${uname}\n`); chmodSync(join(bin, "uname"), 0o755);
  return bin;
}
const withPath = (script, path, ...args) => {
  try { execFileSync("sh", ["-c", script, "vsc", ...args], { env: { ...process.env, PATH: path }, stdio: "pipe" }); return 0; }
  catch (e) { return e.status; }
};

test("trash elsewhere: gio trash with the absolute path; 11 when there is none; never the folder itself", () => {
  const { root } = fixture();
  const bin = stubs(["gio", "trash"]);
  assert.equal(withPath(ENTRY_TRASH, `${bin}:/usr/bin:/bin`, root, "src"), 0);
  assert.deepEqual(readFileSync(join(bin, "gio.log"), "utf8").trim().split("\n"), ["trash", "--", join(root, "src")]);
  assert.ok(!existsSync(join(bin, "trash.log")), "a trash program on PATH is never used");
  const none = stubs([]);
  assert.equal(withPath(ENTRY_TRASH, `${none}:/bin`, root, "b.txt"), 11);
  assert.equal(withPath(ENTRY_TRASH, `${bin}:/usr/bin:/bin`, root, ""), 10);
});

test("trash on macOS: Apple's /usr/bin/trash by its full path (Homebrew's trash reads -s as 'empty the Trash'), else Finder", () => {
  assert.match(ENTRY_TRASH, /\/usr\/bin\/trash -s "\$e"/);
  assert.doesNotMatch(ENTRY_TRASH, /(^|[^/])\btrash -s/);
  assert.match(ENTRY_TRASH, /\/usr\/bin\/osascript/);
  // Finder needs an alias, not a bare POSIX file (checked by hand: without "as alias" it fails).
  assert.match(ENTRY_TRASH, /POSIX file \(item 1 of argv\) as alias/);
});

test("scripts drop relative PATH entries, so a program planted in the folder is never run", () => {
  const { root } = fixture();
  writeFileSync(join(root, "gio"), "#!/bin/sh\ntouch planted\n"); chmodSync(join(root, "gio"), 0o755);
  const bin = stubs([]);
  assert.equal(withPath(ENTRY_TRASH, `.:${bin}:/bin`, root, "b.txt"), 11);
  assert.ok(!existsSync(join(root, "planted")));
  assert.equal(execFileSync("sh", ["-c", `${SAFE_PATH}; printf %s "$PATH"`], { env: { ...process.env, PATH: ".:/usr/bin::rel/x:/bin" }, encoding: "utf8" }), "/usr/bin:/bin");
});

test("rename by case only (a.txt to A.txt) works on a file system that ignores case", () => {
  const { root } = fixture();
  assert.equal(sh(ENTRY_MOVE, root, "b.txt", "", "B.txt").code, 0);
  assert.ok(readdirSync(root).includes("B.txt"));
  assert.equal(readFileSync(join(root, "B.txt"), "utf8"), "b\n");
});

test("a folder is never pasted into itself", () => {
  assert.equal(intoItself("src", "src"), true);
  assert.equal(intoItself("src", "src/lib"), true);
  assert.equal(intoItself("src", "srcx"), false);
  assert.equal(intoItself("src/a.js", ""), false);
});

test("permanent delete: only inside, never the folder itself, a link removed not its target", () => {
  const { root, outside } = fixture();
  assert.equal(sh(ENTRY_DELETE, root, "out").code, 0);
  assert.ok(!existsSync(join(root, "out")));
  assert.deepEqual(readdirSync(outside), ["keep.txt"]);
  assert.equal(sh(ENTRY_DELETE, root, "src").code, 0);
  assert.ok(!existsSync(join(root, "src")));
  assert.equal(sh(ENTRY_DELETE, root, "").code, 10);
  assert.equal(sh(ENTRY_DELETE, root, ".").code, 10);
  assert.ok(existsSync(join(root, "b.txt")));
});

test("rename by case uses a fresh private folder (mktemp -d), so no planted name can redirect it", () => {
  assert.match(ENTRY_MOVE, /mktemp -d "\$d\/\.vsc-rename\.XXXXXX"/);
  assert.doesNotMatch(ENTRY_MOVE, /\$\$/);
  const { root, outside } = fixture();
  assert.equal(sh(ENTRY_MOVE, root, "src", "", "Src").code, 0);
  assert.deepEqual(readdirSync(root).filter(n => n.startsWith(".vsc-rename")), []);
  assert.ok(readdirSync(root).includes("Src"));
  assert.deepEqual(readdirSync(outside), ["keep.txt"]);
});

test("a PATH of only relative folders falls back to the system folders, never to an empty PATH", () => {
  // /bin/sh by its full path: with this PATH, node itself could not find sh.
  assert.equal(execFileSync("/bin/sh", ["-c", `${SAFE_PATH}; printf %s "$PATH"`], { env: { ...process.env, PATH: ".:rel" }, encoding: "utf8" }), "/usr/bin:/bin");
});

test("a case-only rename that cannot finish or go back says where the entry is", () => {
  const { root } = fixture();
  // mv works once (into the private folder), then fails: the new and the old name both taken meanwhile.
  const bin = mkdtempSync(join(tmpdir(), "vsc-bin-")), count = join(bin, "n");
  writeFileSync(join(bin, "mv"), `#!/bin/sh\nn=$(cat "${count}" 2>/dev/null || echo 0); echo $((n+1)) > "${count}"\n[ "$n" = 0 ] && exec /bin/mv "$@"\nexit 1\n`); chmodSync(join(bin, "mv"), 0o755);
  let out = "", code = 0;
  try { out = execFileSync("sh", ["-c", ENTRY_MOVE, "vsc", root, "b.txt", "", "B.txt"], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" }); }
  catch (e) { code = e.status; out = e.stdout; }
  assert.equal(code, 12);
  assert.match(out, /\/\.vsc-rename\.[A-Za-z0-9]{6}\/x$/);
  assert.equal(readFileSync(out, "utf8"), "b\n");
});
