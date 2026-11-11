// Saving files on another machine: the checksum and the scripts, tried with the system's cksum and sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, statSync, chmodSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posixCksum, utf8Bytes, textChunks } from "../mods/vsc/lib/remote-text.js";
import { SAVE_PREPARE, SAVE_APPEND, SAVE_COMMIT, SAVE_ABORT } from "../mods/vsc/lib/scripts.js";

const sh = (script, ...args) => {
  try { return { code: 0, out: execFileSync("sh", ["-c", script, "vsc", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, out: e.stdout ?? "", err: e.stderr ?? "" }; }
};
const realCksum = (text) => execFileSync("cksum", { input: Buffer.from(text, "utf8"), encoding: "utf8" }).trim().split(/\s+/).slice(0, 2).join(" ");

test("cksum of text matches the system's cksum, as the commit script compares it", () => {
  for (const text of ["", "a", "hello\n", "line\r\nčćžšđ €😀\n", "x".repeat(70000)]) assert.equal(posixCksum(text), realCksum(text), JSON.stringify(text.slice(0, 20)));
});

test("UTF-8 bytes and chunks that stay under the per-argument limit", () => {
  assert.deepEqual([...utf8Bytes("aé€😀")], [...Buffer.from("aé€😀", "utf8")]);
  const text = "ab😀".repeat(20000), chunks = textChunks(text, 1000);
  assert.equal(chunks.join(""), text);
  // A chunk never splits a surrogate pair (an emoji), and stays under the limit.
  for (const c of chunks) { assert.ok(c.length <= 1000); assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(c)); }
  assert.deepEqual(textChunks("", 10), []);
});

function save(path, text, expected, { tamper = false } = {}) {
  const prep = sh(SAVE_PREPARE, path);
  if (prep.code !== 0) return prep;
  const [tmp, real] = prep.out.split("\0");
  for (const chunk of textChunks(text, 7)) assert.equal(sh(SAVE_APPEND, tmp, chunk).code, 0);
  if (tamper) writeFileSync(tmp, text.slice(0, -1));
  const done = sh(SAVE_COMMIT, tmp, real, expected === null ? "" : posixCksum(expected), posixCksum(text));
  if (done.code !== 0) sh(SAVE_ABORT, tmp);
  return done;
}

test("save: replaces the file when it still holds the expected text, keeping its mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-remote-")), file = join(dir, "a.txt");
  writeFileSync(file, "old\r\n"); chmodSync(file, 0o600);
  assert.equal(save(file, "new čž\r\n", "old\r\n").code, 0);
  assert.equal(readFileSync(file, "utf8"), "new čž\r\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["a.txt"], "no temporary file left");
});

test("save: refuses when the file changed since it was read, and leaves it alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-remote-")), file = join(dir, "a.txt");
  writeFileSync(file, "changed by someone\n");
  const r = save(file, "mine\n", "what I read\n");
  assert.equal(r.code, 5);
  assert.equal(readFileSync(file, "utf8"), "changed by someone\n");
  assert.deepEqual(readdirSync(dir), ["a.txt"]);
});

test("save: a new file only when none exists; an existing one is a conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-remote-")), file = join(dir, "new.txt");
  assert.equal(save(file, "fresh\n", null).code, 0);
  assert.equal(readFileSync(file, "utf8"), "fresh\n");
  assert.equal(save(file, "again\n", null).code, 5);
});

test("save: through a symlink, the file it points to is written and the link stays", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-remote-")), target = join(dir, "real.txt"), link = join(dir, "link.txt");
  writeFileSync(target, "v1\n"); symlinkSync(target, link);
  assert.equal(save(link, "v2\n", "v1\n").code, 0);
  assert.equal(readFileSync(target, "utf8"), "v2\n");
  assert.ok(statSync(link).isFile() && realpathSync(link) === realpathSync(target));
});

test("append and abort touch only the save's own temporary files", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-remote-")), other = join(dir, "notes.txt");
  writeFileSync(other, "keep\n");
  assert.notEqual(sh(SAVE_APPEND, other, "x").code, 0);
  assert.notEqual(sh(SAVE_ABORT, other).code, 0);
  assert.equal(readFileSync(other, "utf8"), "keep\n");
});

test("save: refuses when the uploaded text did not arrive whole, and changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-remote-")), file = join(dir, "a.txt");
  writeFileSync(file, "old\n");
  assert.equal(save(file, "new text\n", "old\n", { tamper: true }).code, 7);
  assert.equal(readFileSync(file, "utf8"), "old\n");
  assert.deepEqual(readdirSync(dir), ["a.txt"]);
});

test("save: the file keeps its group", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-remote-")), file = join(dir, "a.txt");
  writeFileSync(file, "old\n");
  // A group of this user's other than the folder's, so a replaced file would show the change.
  const groups = execFileSync("id", ["-G"], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
  const other = groups.find(g => g !== statSync(dir).gid);
  if (other === undefined) return; // only one group: nothing to tell apart here
  execFileSync("chgrp", [String(other), file]);
  assert.equal(save(file, "new\n", "old\n").code, 0);
  assert.equal(statSync(file).gid, other);
});

test("prepare: removes this save's stale temporary files (over an hour old) beside the file, keeps fresh ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-remote-")), file = join(dir, "a.txt");
  writeFileSync(file, "x\n");
  writeFileSync(join(dir, ".vsc-save.OLDOLD"), "partial secret");
  execFileSync("touch", ["-t", "202001010000", join(dir, ".vsc-save.OLDOLD")]);
  writeFileSync(join(dir, ".vsc-save.NEWNEW"), "another save in progress");
  const prep = sh(SAVE_PREPARE, file);
  assert.equal(prep.code, 0);
  const left = readdirSync(dir).sort();
  assert.ok(!left.includes(".vsc-save.OLDOLD"));
  assert.ok(left.includes(".vsc-save.NEWNEW"));
});
