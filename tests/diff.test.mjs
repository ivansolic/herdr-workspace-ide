import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff } from "../mods/vsc/lib/diff.js";

const kinds = (rows) => rows.map(r => r.kind + r.text).join("|");

test("identical texts have only context rows", () => {
  assert.equal(kinds(lineDiff("a\nb", "a\nb")), " a| b");
});

test("a changed line shows as removed then added, with both line numbers", () => {
  const rows = lineDiff("a\nb\nc", "a\nB\nc");
  assert.equal(kinds(rows), " a|-b|+B| c");
  assert.deepEqual(rows.map(r => [r.old, r.new]), [[1, 1], [2, null], [null, 2], [3, 3]]);
});

test("insertions and deletions in the middle keep the common lines", () => {
  assert.equal(kinds(lineDiff("a\nb\nc\nd", "a\nc\nx\nd")), " a|-b| c|+x| d");
});

test("empty sides", () => {
  assert.equal(kinds(lineDiff("", "x")), "-|+x");
  assert.equal(kinds(lineDiff("x", "")), "-x|+");
});

test("very large changed regions fall back to a plain replace instead of hanging", () => {
  const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n");
  const rows = lineDiff(a, b);
  // The replace shape (all removals, then all additions) shows the LCS was skipped.
  assert.ok(rows.slice(0, 5000).every(r => r.kind === "-") && rows.slice(5000).every(r => r.kind === "+"));
  assert.equal(rows.filter(r => r.kind === "-").length, 5000);
  assert.equal(rows.filter(r => r.kind === "+").length, 5000);
});
