import { test } from "node:test";
import assert from "node:assert/strict";
import { folderMarks, unsavedFolders } from "../mods/vsc/lib/tree.js";

test("folderMarks computes every ancestor folder's strongest mark once", () => {
  const map = folderMarks({ "/r/src/a.ts": "M", "/r/src/deep/n.ts": "A", "/r/conf/c.ts": "U" }, "/r");
  assert.equal(map.get("/r/src"), "M");
  assert.equal(map.get("/r/src/deep"), "A");
  assert.equal(map.get("/r/conf"), "U");
  assert.equal(map.get("/r"), "U");
  assert.equal(map.has("/"), false, "stops at the root it was given");
});

test("unsavedFolders lists every ancestor of unsaved files on that machine", () => {
  const set = unsavedFolders(null, new Set(["|/h/code/app/a.ts", "vps|/srv/x.ts"]));
  assert.ok(set.has("/h/code/app") && set.has("/h/code") && set.has("/h") && set.has("/"));
  assert.ok(!set.has("/srv"));
  assert.ok(unsavedFolders("vps", new Set(["vps|/srv/x.ts"])).has("/srv"));
});
