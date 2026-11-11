import { test } from "node:test";
import assert from "node:assert/strict";
import { fileIcon, folderIcon } from "../mods/vsc/lib/icons.js";

test("known extensions get their icon and a theme color token", () => {
  assert.deepEqual(fileIcon("app.ts"), { icon: "file-code", color: "ansi4" });
  assert.deepEqual(fileIcon("README.md"), { icon: "file-text", color: "ansi4" });
  assert.deepEqual(fileIcon("data.json"), { icon: "braces", color: "ansi3" });
  assert.deepEqual(fileIcon("logo.PNG"), { icon: "image", color: "ansi5" });
  assert.deepEqual(fileIcon("run.sh"), { icon: "terminal", color: "ansi2" });
});

test("special file names win over their extension", () => {
  assert.deepEqual(fileIcon("package.json"), { icon: "package", color: "ansi1" });
  assert.deepEqual(fileIcon(".gitignore"), { icon: "git", color: "ansi1" });
  assert.deepEqual(fileIcon("Dockerfile"), { icon: "container", color: "ansi4" });
  assert.deepEqual(fileIcon("pnpm-lock.yaml"), { icon: "lock", color: "dim" });
  assert.deepEqual(fileIcon(".env.local"), { icon: "key", color: "ansi3" });
});

test("unknown or extensionless files fall back to the plain file icon", () => {
  assert.deepEqual(fileIcon("LICENSE"), { icon: "file", color: "muted" });
  assert.deepEqual(fileIcon("notes.xyz"), { icon: "file", color: "muted" });
  assert.deepEqual(fileIcon(""), { icon: "file", color: "muted" });
});

test("folders show open or closed, special folders are dim", () => {
  assert.deepEqual(folderIcon("src", false), { icon: "folder", color: "muted" });
  assert.deepEqual(folderIcon("src", true), { icon: "folder-open", color: "muted" });
  assert.deepEqual(folderIcon("node_modules", false), { icon: "folder", color: "dim" });
});

test("only theme tokens, never hex colors", () => {
  for (const name of ["a.ts", "a.md", "a.json", "a.png", "x", "package.json"])
    assert.doesNotMatch(fileIcon(name).color, /^#/);
});
