import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDraft, parseDraft, restoreDecision, saveFailure, isSecretFile, joinPath, gitLetter } from "../mods/vsc/lib/editing.js";

const rec = (base, text, path = "/p/a.ts", on = null) => parseDraft(makeDraft(on, path, base, text));

test("drafts round-trip with their base, machine and path", () => {
  assert.deepEqual(rec("old", "mine"), { v: 1, on: null, path: "/p/a.ts", base: "old", text: "mine" });
  assert.equal(parseDraft("not json"), null);
  assert.equal(parseDraft(""), null);
});

test("no draft, or a draft equal to the file, is clean", () => {
  assert.deepEqual(restoreDecision("disk", null, null, "/p/a.ts"), { state: "clean" });
  assert.deepEqual(restoreDecision("disk", rec("x", "disk"), null, "/p/a.ts"), { state: "clean" });
});

test("a draft based on the current file is restored as unsaved", () => {
  assert.deepEqual(restoreDecision("disk", rec("disk", "mine"), null, "/p/a.ts"), { state: "restored", text: "mine", base: "disk" });
});

test("a draft based on an older file becomes a conflict, never a silent overwrite", () => {
  assert.deepEqual(restoreDecision("agent edit", rec("before", "mine"), null, "/p/a.ts"),
    { state: "conflict", text: "mine", base: "before", disk: "agent edit" });
});

test("a draft for another file (hash collision) or another machine is ignored", () => {
  assert.deepEqual(restoreDecision("disk", rec("disk", "mine", "/p/b.ts"), null, "/p/a.ts"), { state: "clean" });
  assert.deepEqual(restoreDecision("disk", rec("disk", "mine", "/p/a.ts", "vps"), null, "/p/a.ts"), { state: "clean" });
});

test("save failures are told apart", () => {
  assert.equal(saveFailure("same", null), "missing");
  assert.equal(saveFailure("same", "same"), "error");
  assert.equal(saveFailure("same", "changed"), "conflict");
});

test("secret files are recognized", () => {
  for (const name of [".env", ".env.local", "server.pem", "id_rsa", "id_ed25519", "cert.key", "store.p12", ".netrc", ".npmrc", "credentials"])
    assert.equal(isSecretFile(`/x/${name}`), true, name);
  for (const name of ["env.ts", "app.ts", "README.md", "keyboard.js", "environment.md"])
    assert.equal(isSecretFile(`/x/${name}`), false, name);
});

test("joinPath resolves relative links like a browser", () => {
  assert.equal(joinPath("/a/b", "c.md"), "/a/b/c.md");
  assert.equal(joinPath("/a/b", "./c.md"), "/a/b/c.md");
  assert.equal(joinPath("/a/b", "../c.md"), "/a/c.md");
  assert.equal(joinPath("/a/b", "/x/y.md"), "/x/y.md");
  assert.equal(joinPath("/a/b", "my%20notes.md"), "/a/b/my notes.md");
  assert.equal(joinPath("/a", "../../c.md"), "/c.md");
});

test("git status letters: unmerged first", () => {
  for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) assert.equal(gitLetter(xy), "U", xy);
  assert.equal(gitLetter("??"), "A");
  assert.equal(gitLetter("A "), "A");
  assert.equal(gitLetter(" D"), "D");
  assert.equal(gitLetter(" M"), "M");
  assert.equal(gitLetter("R "), "M");
});

import { lineEnding, toLineEnding, sameText, looksMisdecoded } from "../mods/vsc/lib/editing.js";

test("line endings are detected and put back on save", () => {
  assert.equal(lineEnding("a\r\nb\r\n"), "\r\n");
  assert.equal(lineEnding("a\nb\n"), "\n");
  assert.equal(lineEnding("one line"), "\n");
  assert.equal(toLineEnding("a\nb\n", "\r\n"), "a\r\nb\r\n");
  assert.equal(toLineEnding("a\r\nb", "\r\n"), "a\r\nb", "already CRLF stays as is");
  assert.equal(toLineEnding("a\r\nb", "\n"), "a\r\nb", "LF files are written exactly as typed");
});

test("an editor that shows CRLF as LF is not treated as a change", () => {
  assert.equal(sameText("a\nb", "a\r\nb"), true);
  assert.equal(sameText("a\nb", "a\r\nc"), false);
});

test("text decoded with replacement characters is flagged", () => {
  assert.equal(looksMisdecoded("caf�"), true);
  assert.equal(looksMisdecoded("café"), false);
});

test("a draft that only differs in line endings is clean", () => {
  assert.deepEqual(restoreDecision("a\r\nb", rec("a\r\nb", "a\nb"), null, "/p/a.ts"), { state: "clean" });
});

import { cleanupDraft } from "../mods/vsc/lib/editing.js";

test("start-up cleanup deletes a draft only when the file already holds its text", () => {
  const d = rec("base", "mine");
  assert.equal(cleanupDraft(d, "mine"), "delete");
  assert.equal(cleanupDraft(d, "mine".replace(/\n/g, "\r\n")), "delete");
  assert.equal(cleanupDraft(rec("b", "x\ny"), "x\r\ny"), "delete", "equal except line endings");
  assert.equal(cleanupDraft(d, "other"), "keep");
  assert.equal(cleanupDraft(d, null), "keep", "a missing or unreadable file keeps its draft (branch switch)");
});

test("drafts of secret files are always deleted, and remote drafts are kept", () => {
  assert.equal(cleanupDraft(rec("b", "SECRET=1", "/p/.env"), null), "delete");
  assert.equal(cleanupDraft(rec("b", "x", "/srv/a.ts", "vps"), null), "keep");
});

test("more secret file names", () => {
  for (const name of [".git-credentials", ".pgpass", ".htpasswd", "vault.kdbx"]) assert.equal(isSecretFile(`/x/${name}`), true, name);
});

test("a half-written draft is recognized and not offered as text", () => {
  assert.equal(parseDraft('{"v":1,"on":null,"path":"/p/a.ts","base":"x","te'), null);
  assert.equal(looksLikeDraft('{"v":1,"on":null,"pa'), true);
  assert.equal(looksLikeDraft("plain old draft text"), false);
});

import { looksLikeDraft } from "../mods/vsc/lib/editing.js";

test("a remote save's temporary file is never committed (it can hold part of a secret)", () => {
  assert.equal(isSecretFile("/srv/app/.vsc-save.Ab12Cd"), true);
  assert.equal(isSecretFile("src/.vsc-save.x"), false);
});
