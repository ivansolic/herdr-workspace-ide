import { test } from "node:test";
import assert from "node:assert/strict";
import { liveOnly, addedIds } from "../mods/vsc/lib/registry.js";

test("an editor registry keeps only entries whose tab or pane still exists", () => {
  assert.deepEqual(liveOnly({ "|/a": "t1", "|/b": "p9", "box|/c": "t2" }, new Set(["t1", "t2"])), { "|/a": "t1", "box|/c": "t2" });
});

test("the new tab or pane is the one id that was not there before; none or several is no answer", () => {
  assert.equal(addedIds(new Set(["a", "b"]), new Set(["a", "b", "c"])), "c");
  assert.equal(addedIds(new Set(["a"]), new Set(["a"])), null);
  assert.equal(addedIds(new Set(["a"]), new Set(["a", "b", "c"])), null);
});
