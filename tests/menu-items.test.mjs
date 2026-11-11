import { test } from "node:test";
import assert from "node:assert/strict";
import { menuItems, menuHeight } from "../mods/vsc/lib/menu-items.js";

const ids = (items) => items.map(i => (i === "-" ? "-" : i.id));

test("file menu, as in VS Code", () => {
  assert.deepEqual(ids(menuItems({ kind: "file", on: null }, {})), [
    "side", "reveal", "terminal", "-", "pick-compare", "-", "cut", "copy", "-", "copy-path", "copy-relative", "-", "rename", "delete"]);
});

test("folder menu, with Paste only when something was cut or copied in this folder", () => {
  const folder = { kind: "folder", on: null, root: "/r" };
  assert.ok(!ids(menuItems(folder, {})).includes("paste"));
  assert.deepEqual(ids(menuItems(folder, { clip: { root: "/r", on: null } })), [
    "new-file", "new-folder", "reveal", "terminal", "find", "-", "cut", "copy", "paste", "-", "copy-path", "copy-relative", "-", "rename", "delete"]);
  assert.ok(!ids(menuItems(folder, { clip: { root: "/other", on: null } })).includes("paste"));
});

test("empty area: new entries in the top folder", () => {
  assert.deepEqual(ids(menuItems({ kind: "root", on: null, root: "/r" }, {})), ["new-file", "new-folder", "reveal", "terminal", "find"]);
});

test("Compare with Selected once another file of the same machine was picked", () => {
  const file = { kind: "file", on: "box", path: "/r/b.js" };
  assert.ok(ids(menuItems(file, { pick: { on: "box", path: "/r/a.js" } })).includes("compare"));
  assert.ok(!ids(menuItems(file, { pick: { on: null, path: "/r/a.js" } })).includes("compare"));
  assert.ok(!ids(menuItems(file, { pick: { on: "box", path: "/r/b.js" } })).includes("compare"));
});

test("Reveal in Finder only on this computer", () => {
  assert.ok(!ids(menuItems({ kind: "file", on: "box" }, {})).includes("reveal"));
});

test("height fits the items", () => {
  assert.equal(menuHeight(["a", "-", "b"].map(x => (x === "-" ? "-" : { id: x }))), 12 + 2 * 28 + 9);
});
