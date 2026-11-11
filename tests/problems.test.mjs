import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { detectTools, tscTargets, parseJsonc, parseTsc, parseEslint, parseRuff, toRootPath, vscodeUrl, groupByFile, PROBLEM_LIMIT } from "../mods/vsc/lib/problems.js";

const has = (...paths) => new Set(paths);

test("tools: only what the project itself installs, never npx", () => {
  assert.deepEqual(detectTools(has(), { ruffPath: "/usr/local/bin/ruff", pyprojectRuff: false }), []);
  const ts = detectTools(has("tsconfig.json", "node_modules/.bin/tsc"), { tscConfigs: ["tsconfig.json"] });
  assert.deepEqual(ts.map(t => [t.source, t.argv]), [["tsc", ["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json"]]]);
  // A solution-style tsconfig: one run per referenced config.
  const refs = detectTools(has("tsconfig.json", "node_modules/.bin/tsc"), { tscConfigs: ["tsconfig.app.json", "tsconfig.node.json"] });
  assert.deepEqual(refs.map(t => t.argv.at(-1)), ["tsconfig.app.json", "tsconfig.node.json"]);
  // A tsconfig without a local TypeScript runs nothing.
  assert.deepEqual(detectTools(has("tsconfig.json"), {}), []);
  const lint = detectTools(has("eslint.config.mjs", "node_modules/.bin/eslint"), {});
  assert.deepEqual(lint.map(t => t.argv), [["node_modules/.bin/eslint", "--format", "json", "."]]);
  assert.deepEqual(detectTools(has(".eslintrc.json", "node_modules/.bin/eslint"), {}).map(t => t.source), ["eslint"]);
  assert.deepEqual(detectTools(has("node_modules/.bin/eslint"), {}), []);
});

test("tools: Ruff from the project's .venv first, else from PATH, only with a Ruff config", () => {
  assert.deepEqual(detectTools(has("ruff.toml", ".venv/bin/ruff"), {}).map(t => t.argv[0]), [".venv/bin/ruff"]);
  // Ruff from PATH runs by its full path, shown as such in the trust prompt.
  assert.deepEqual(detectTools(has(".ruff.toml"), { ruffPath: "/usr/local/bin/ruff" }).map(t => t.argv), [["/usr/local/bin/ruff", "check", "--output-format", "json", "--no-cache", "."]]);
  assert.deepEqual(detectTools(has("pyproject.toml"), { ruffPath: "/usr/local/bin/ruff", pyprojectRuff: true }).map(t => t.source), ["ruff"]);
  assert.deepEqual(detectTools(has("pyproject.toml"), { ruffPath: "/usr/local/bin/ruff", pyprojectRuff: false }), []);
  assert.deepEqual(detectTools(has("ruff.toml"), { ruffPath: null }), []);
  // A relative answer from `command -v` (PATH holding ".") is never used.
  assert.deepEqual(detectTools(has("ruff.toml"), { ruffPath: "./ruff" }), []);
});

test("tsc: file(line,col): error TSnnnn, paths with spaces, continuation lines joined", () => {
  const out = [
    "src/my file.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/b.ts(10,1): error TS2345: Argument of type 'A' is not assignable to parameter of type 'B'.\r",
    "  Property 'x' is missing in type 'A'.",
    "Found 2 errors in 2 files.",
    "",
  ].join("\n");
  assert.deepEqual(parseTsc(out), [
    { file: "src/my file.ts", line: 3, col: 7, severity: "error", message: "Type 'string' is not assignable to type 'number'.", source: "tsc", code: "TS2322" },
    { file: "src/b.ts", line: 10, col: 1, severity: "error", message: "Argument of type 'A' is not assignable to parameter of type 'B'. Property 'x' is missing in type 'A'.", source: "tsc", code: "TS2345" },
  ]);
  assert.deepEqual(parseTsc("src/c.ts(1,1): warning TS6133: 'x' is declared but never used."), [
    { file: "src/c.ts", line: 1, col: 1, severity: "warning", message: "'x' is declared but never used.", source: "tsc", code: "TS6133" },
  ]);
});

test("eslint: JSON per file, severity 2 is an error, fatal parse errors too", () => {
  const out = JSON.stringify([
    { filePath: "/r/src/a.js", messages: [
      { ruleId: "no-unused-vars", severity: 1, message: "'x' is assigned a value but never used.", line: 2, column: 7 },
      { ruleId: null, fatal: true, severity: 2, message: "Parsing error: Unexpected token", line: 5, column: 1 },
    ] },
    { filePath: "/r/src/clean.js", messages: [] },
  ]);
  assert.deepEqual(parseEslint(out), [
    { file: "/r/src/a.js", line: 2, col: 7, severity: "warning", message: "'x' is assigned a value but never used.", source: "eslint", code: "no-unused-vars" },
    { file: "/r/src/a.js", line: 5, col: 1, severity: "error", message: "Parsing error: Unexpected token", source: "eslint", code: null },
  ]);
  assert.throws(() => parseEslint("Oops! Something went wrong!"), /ESLint/);
});

test("ruff: JSON diagnostics; a syntax error (no code) is an error, the rest warnings", () => {
  const out = JSON.stringify([
    { code: "F401", message: "`os` imported but unused", filename: "/r/app.py", location: { row: 1, column: 8 } },
    { code: null, message: "SyntaxError: Expected an expression", filename: "/r/bad.py", location: { row: 3, column: 5 } },
  ]);
  assert.deepEqual(parseRuff(out), [
    { file: "/r/app.py", line: 1, col: 8, severity: "warning", message: "`os` imported but unused", source: "ruff", code: "F401" },
    { file: "/r/bad.py", line: 3, col: 5, severity: "error", message: "SyntaxError: Expected an expression", source: "ruff", code: null },
  ]);
  assert.deepEqual(parseRuff("[]"), []);
});

test("paths become the folder's own spelling, so a problem opens the tab Explorer would", () => {
  assert.equal(toRootPath("src/a.ts", "/tmp/p", "/private/tmp/p"), "/tmp/p/src/a.ts");
  assert.equal(toRootPath("/private/tmp/p/src/a.ts", "/tmp/p", "/private/tmp/p"), "/tmp/p/src/a.ts");
  assert.equal(toRootPath("/tmp/p/src/a.ts", "/tmp/p", "/private/tmp/p"), "/tmp/p/src/a.ts");
  assert.equal(toRootPath("/elsewhere/x.ts", "/tmp/p", "/private/tmp/p"), "/elsewhere/x.ts");
  assert.equal(toRootPath("/private/tmp/p-other/x.ts", "/tmp/p", "/private/tmp/p"), "/private/tmp/p-other/x.ts");
});

test("VS Code links go to the line and column, with #, ? and spaces escaped", () => {
  assert.equal(vscodeUrl("/Users/a/my proj/#1?.ts", 3, 7), "vscode://file/Users/a/my%20proj/%231%3F.ts:3:7");
  assert.equal(vscodeUrl("/Users/a/proj"), "vscode://file/Users/a/proj");
});

test("grouped by file, errors first within a file, files with errors first, limited", () => {
  const p = (file, line, severity) => ({ file, line, col: 1, severity, message: "m", source: "tsc", code: null });
  const groups = groupByFile([p("/b", 5, "warning"), p("/a", 9, "warning"), p("/b", 2, "error"), p("/b", 1, "warning")]);
  assert.deepEqual(groups.files.map(g => [g.file, g.problems.map(x => x.line)]), [["/b", [2, 1, 5]], ["/a", [9]]]);
  assert.deepEqual([groups.errors, groups.warnings, groups.truncated], [1, 3, false]);
  const many = groupByFile(Array.from({ length: PROBLEM_LIMIT + 5 }, (_, i) => p("/x", i, "error")));
  assert.equal(many.files[0].problems.length, PROBLEM_LIMIT);
  assert.equal(many.truncated, true);
  assert.equal(many.errors, PROBLEM_LIMIT + 5);
});

test("tsconfig with comments and trailing commas still parses", () => {
  assert.deepEqual(parseJsonc('{\n  // app\n  "files": [], /* none */\n  "references": [{ "path": "./a", },],\n  "x": "http://not/a/comment",\n}'),
    { files: [], references: [{ path: "./a" }], x: "http://not/a/comment" });
  assert.equal(parseJsonc("{ broken"), null);
  // Commas inside strings are text, not trailing commas.
  assert.deepEqual(parseJsonc('{ "a": "x,]", "b": ["y,}",], }'), { a: "x,]", b: ["y,}"] });
});

test("which configs tsc checks: tsconfig.json, or each reference of a solution-style one", () => {
  assert.deepEqual(tscTargets('{ "compilerOptions": {} }'), { configs: ["tsconfig.json"], skipped: [] });
  assert.deepEqual(tscTargets('{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "packages/web" }] }'),
    { configs: ["tsconfig.app.json", "packages/web/tsconfig.json"], skipped: [] });
  // References outside the folder are not run; they are named instead.
  assert.deepEqual(tscTargets('{ "files": [], "references": [{ "path": "../shared" }, { "path": "/abs/x.json" }] }'),
    { configs: [], skipped: ["../shared", "/abs/x.json"] });
  // A tsconfig with files or include of its own is checked as it is, references or not.
  assert.deepEqual(tscTargets('{ "include": ["src"], "references": [{ "path": "./b" }] }').configs, ["tsconfig.json"]);
  assert.deepEqual(tscTargets("not json").configs, ["tsconfig.json"]);
  // An empty include list is the same as none.
  assert.deepEqual(tscTargets('{ "files": [], "include": [], "references": [{ "path": "./tsconfig.app.json" }] }').configs, ["tsconfig.app.json"]);
});

// Trust covers the folder (real path and identity on disk) and the commands the prompt listed: when the
// checks change (a pulled branch adds eslint or a .venv ruff), the folder is asked about again.
test("trustKey: the same folder with the same checks keeps its trust; other checks or another folder do not", async () => {
  const { trustKey } = await import("../mods/vsc/lib/problems.js");
  const tsc = { source: "tsc", argv: ["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json"] };
  const eslint = { source: "eslint", argv: ["node_modules/.bin/eslint", "--format", "json", "."] };
  const folder = { realRoot: "/code/shop", id: "1:2", tools: [tsc] };
  assert.equal(trustKey(null, folder), trustKey(null, { ...folder, tools: [{ ...tsc }] }));
  assert.notEqual(trustKey(null, folder), trustKey(null, { ...folder, tools: [tsc, eslint] }));
  assert.notEqual(trustKey(null, folder), trustKey(null, { ...folder, id: "1:3" }));
  assert.notEqual(trustKey(null, folder), trustKey("vps", folder));
});

// The view's path: the record it trusts comes from folderRecord, so it carries the detected checks.
test("folderRecord: the Problems view's trust record holds the checks, so changed checks lose trust", async () => {
  const { folderRecord, trustKey } = await import("../mods/vsc/lib/problems.js");
  const tsc = { source: "tsc", argv: ["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json"] };
  const eslint = { source: "eslint", argv: ["node_modules/.bin/eslint", "--format", "json", "."] };
  const before = folderRecord({ realRoot: "/code/shop", id: "1:2", tools: [tsc], skipped: [] });
  const after = folderRecord({ realRoot: "/code/shop", id: "1:2", tools: [tsc, eslint], skipped: [] });
  assert.notEqual(trustKey(null, before), trustKey(null, after));
  assert.match(trustKey(null, before), /tsc/);
  const view = readFileSync(new URL("../mods/vsc/views/problems.js", import.meta.url), "utf8");
  assert.match(view, /this\.folder = folderRecord\(/);
  assert.doesNotMatch(view, /this\.folder = \{/);
});
