import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatcher, findMatches, replaceText, replacerFor, changedRows, fuzzyScore, rankFiles, parseFileList, MAX_PREVIEW,
  grepCanNarrow, plainPath, insideFolder, planEntry } from "../mods/vsc/lib/search.js";

const opts = (o = {}) => ({ matchCase: false, wholeWord: false, regex: false, ...o });

test("empty query matches nothing", () => {
  assert.equal(buildMatcher("", opts()), null);
});

test("plain text is matched literally, case-insensitive by default", () => {
  const m = buildMatcher("a.b(", opts());
  assert.deepEqual(findMatches("A.B( axb(", m).matches.map(x => x.col), [1]);
  assert.equal(findMatches("A.B(", buildMatcher("a.b(", opts({ matchCase: true }))).matches.length, 0);
});

test("whole word skips matches inside longer words", () => {
  const m = buildMatcher("foo", opts({ wholeWord: true }));
  assert.deepEqual(findMatches("foo food afoo foo_bar foo.", m).matches.map(x => x.col), [1, 23]);
});

test("an invalid regular expression gives a message, not an exception", () => {
  const m = buildMatcher("a(", opts({ regex: true }));
  assert.equal(typeof m.error, "string");
  assert.equal(m.re, undefined);
});

test("matches carry 1-based line and column and a preview of the line", () => {
  const m = buildMatcher("needle", opts());
  const { matches } = findMatches("first\r\n  a needle here\nlast needle", m);
  assert.deepEqual(matches.map(x => [x.line, x.col]), [[2, 5], [3, 6]]);
  assert.deepEqual(matches[0].preview, { before: "  a ", match: "needle", after: " here" });
  // Context before the match is short, so the match stays in view in a narrow panel.
  assert.equal(findMatches("const value = alongerName.needle", m).matches[0].preview.before, "…alongerName.");
});

test("regex anchors work per line, and empty matches do not loop forever", () => {
  const m = buildMatcher("^", opts({ regex: true }));
  assert.equal(findMatches("a\nb\nc", m).matches.length, 3);
  const b = buildMatcher("\\b", opts({ regex: true }));
  assert.ok(findMatches("ab cd", b).matches.length <= 4);
});

test("the match limit stops early and says so", () => {
  const m = buildMatcher("x", opts());
  const r = findMatches("x".repeat(50), m, 10);
  assert.equal(r.matches.length, 10);
  assert.equal(r.truncated, true);
  assert.equal(findMatches("xx", m, 10).truncated, false);
});

test("long lines are cut around the match", () => {
  const m = buildMatcher("hit", opts());
  const line = "a".repeat(500) + "hit" + "b".repeat(500);
  const { preview } = findMatches(line, m).matches[0];
  assert.equal(preview.match, "hit");
  assert.ok(preview.before.startsWith("…") && preview.before.length <= 13);
  assert.ok(preview.before.length + preview.match.length + preview.after.length <= MAX_PREVIEW + 2);
});

test("replace in plain-text mode inserts the replacement literally", () => {
  const m = buildMatcher("a", opts());
  assert.deepEqual(replaceText("a A b", m, "$&$1", false), { text: "$&$1 $&$1 b", count: 2 });
});

test("replace in regex mode understands $1 groups", () => {
  const m = buildMatcher("(\\w+)@(\\w+)", opts({ regex: true }));
  assert.deepEqual(replaceText("x me@home y", m, "$2 at $1", true), { text: "x home at me y", count: 1 });
});

test("replace keeps Windows line endings", () => {
  const m = buildMatcher("old", opts());
  assert.equal(replaceText("old\r\nold\r\n", m, "new", false).text, "new\r\nnew\r\n");
});

test("replace with no match changes nothing", () => {
  const m = buildMatcher("zzz", opts());
  assert.deepEqual(replaceText("abc", m, "y", false), { text: "abc", count: 0 });
});

test("the preview lists only changed lines", () => {
  const rows = changedRows("a\nold\nb\n", "a\nnew\nb\n");
  assert.deepEqual(rows.map(r => [r.kind, r.text]), [["-", "old"], ["+", "new"]]);
});

test("fuzzy: letters in order match, others don't", () => {
  assert.notEqual(fuzzyScore("mjs", "mods/vsc/main.js"), null);
  assert.equal(fuzzyScore("xyz", "mods/vsc/main.js"), null);
  assert.equal(fuzzyScore("", "a.js"), 0);
});

test("fuzzy: the file name beats the folder, consecutive beats scattered", () => {
  const name = fuzzyScore("main", "src/main.js"), folder = fuzzyScore("main", "main/src/x.js");
  assert.ok(name > folder);
  const tight = fuzzyScore("edit", "views/editor.js"), loose = fuzzyScore("edit", "views/e-d-i-t-x.js");
  assert.ok(tight > loose);
});

test("ranking: best first, recent files first when the query is empty, limited", () => {
  const files = ["src/a.js", "src/editor.js", "docs/edit-guide.md", "lib/b.js"];
  assert.equal(rankFiles("editor", files, [], 10)[0], "src/editor.js");
  assert.deepEqual(rankFiles("", files, ["lib/b.js"], 2), ["lib/b.js", "src/a.js"]);
  assert.equal(rankFiles("js", files, [], 2).length, 2);
});

test("file lists from -z output, capped", () => {
  assert.deepEqual(parseFileList("a\0b c\0\0", 10), { files: ["a", "b c"], truncated: false });
  assert.deepEqual(parseFileList("a\0b\0c\0", 2), { files: ["a", "b"], truncated: true });
  // Output cut off mid-name (the listing stops at a byte limit): the partial name is dropped.
  assert.deepEqual(parseFileList("a\0b\0par", 10), { files: ["a", "b"], truncated: true });
});

test("what one match becomes, as the result list shows it", () => {
  const groups = replacerFor(buildMatcher("(\\w+)@(\\w+)", opts({ regex: true })), "$2/$1", true);
  assert.equal(groups("me@home"), "home/me");
  assert.equal(replacerFor(buildMatcher("abc", opts()), "$1", false)("abc"), "$1");
  // A pattern that needs context outside the match (a lookbehind) shows the replacement as typed.
  assert.equal(replacerFor(buildMatcher("(?<=a)b", opts({ regex: true })), "[$&]", true)("b"), "[$&]");
});

test("grep narrows only what it matches exactly as JavaScript does", () => {
  assert.equal(grepCanNarrow("greet", opts()), true);
  assert.equal(grepCanNarrow("Ärger", opts({ matchCase: true })), true);
  // grep -i does not fold case beyond ASCII on every system: read the files instead.
  assert.equal(grepCanNarrow("ärger", opts()), false);
  assert.equal(grepCanNarrow("a.b", opts({ regex: true })), false);
});

test("listed paths must be plain relative paths", () => {
  for (const ok of ["a.js", "src/a.js", ".env", "a..b/c", "..a"]) assert.equal(plainPath(ok), true, ok);
  for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a/..", "./a", "a//b", "a/./b"]) assert.equal(plainPath(bad), false, bad);
});

test("a folder counts as inside only below the real root", () => {
  assert.equal(insideFolder("/r/repo", "/r/repo"), true);
  assert.equal(insideFolder("/r/repo", "/r/repo/src"), true);
  assert.equal(insideFolder("/r/repo", "/r/repo-other"), false);
  assert.equal(insideFolder("/r/repo", "/home/u"), false);
  assert.equal(insideFolder("/r/repo", ""), false);
  assert.equal(insideFolder("/", "/anything"), true);
});

test("a Replace preview entry keeps its machine apart from whether it is ticked", () => {
  const e = planEntry({ rel: "a.js", full: "/r/a.js", on: "box", old: "a", next: "b", count: 1 });
  assert.equal(e.on, "box");
  assert.equal(e.chosen, true);
  assert.equal(planEntry({ rel: "a.js", full: "/r/a.js", on: null, old: "a", next: "b", count: 1 }).on, null);
  assert.deepEqual(e.rows.map(r => r.kind), ["-", "+"]);
});
