// The views cannot run under node, so a deleted method that is still called only fails in the app.
// This catches it: every `this.name(` used in a view class must be defined in that class.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../mods/vsc/views/", import.meta.url);
const INHERITED = new Set(["render", "init", "update", "close"]);

for (const file of readdirSync(dir).filter(f => f.endsWith(".js"))) {
  test(`views/${file}: every called method is defined`, () => {
    const src = readFileSync(new URL(file, dir), "utf8");
    const defined = new Set([...src.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z_]\w*)\s*\([^)]*\)\s*\{/gm)].map(m => m[1]));
    const fields = new Set([...src.matchAll(/this\.([a-zA-Z_]\w*)\s*=(?!=)/g)].map(m => m[1]));
    const called = new Set([...src.matchAll(/this\.([a-zA-Z_]\w*)\s*\(/g)].map(m => m[1]));
    const missing = [...called].filter(n => !defined.has(n) && !fields.has(n) && !INHERITED.has(n));
    assert.deepEqual(missing, [], `called but not defined in ${file}`);
  });
}

// Style setters take a value, never null ("expected a string, got nil" breaks the whole view):
// use .when(condition, el => el.bg(...)) for a style that is sometimes absent.
for (const file of readdirSync(dir).filter(f => f.endsWith(".js"))) {
  test(`views/${file}: no style setter is given null`, () => {
    const src = readFileSync(new URL(file, dir), "utf8");
    const nulls = [...src.matchAll(/\.(bg|text_color|border_color|child|tooltip)\([^()]*\?[^()]*:\s*(null|undefined)\s*\)/g)].map(m => m[0]);
    assert.deepEqual(nulls, [], `null passed in ${file}`);
  });
}

// The text with every arrow function's body removed: "=> { ... }" by braces, "=> expr" to the end
// of its line.
function withoutArrowBodies(text) {
  let out = "";
  for (let i = 0; i < text.length;) {
    if (text.startsWith("=>", i)) {
      let j = i + 2;
      while (text[j] === " ") j++;
      if (text[j] === "{") {
        let depth = 0;
        for (; j < text.length; j++) { if (text[j] === "{") depth++; else if (text[j] === "}" && --depth === 0) break; }
        i = j + 1;
      } else i = text.indexOf("\n", j) === -1 ? text.length : text.indexOf("\n", j);
      continue;
    }
    out += text[i++];
  }
  return out;
}

// Herdr refuses cx.notify() while a view renders ("not allowed during the render phase"), which
// also rules out starting work from render that notifies at once. Location changes are followed
// on a timer instead.
for (const file of readdirSync(dir).filter(f => f.endsWith(".js"))) {
  test(`views/${file}: render neither notifies nor starts a search, load or run`, () => {
    const src = readFileSync(new URL(file, dir), "utf8");
    const start = src.search(/^ {2}render\(/m);
    if (start === -1) return;
    // Handlers built inside render (arrow functions) may notify: their bodies are left out.
    const direct = withoutArrowBodies(src.slice(start, src.indexOf("\n  }\n", start)));
    assert.deepEqual([...direct.matchAll(/cx\.notify\(|this\.(load|schedule|run|afterSave)\(/g)].map(m => m[0]), [], `in render of ${file}`);
  });
}

// Object literals with a key twice: the last wins silently ({ on, ..., on: true } once lost a
// file's machine). Scans every module of the mod; a literal is a "{" after ( , = : [ ? or return.
function duplicateKeys(src) {
  const text = src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const before = text.slice(0, i).trimEnd();
    if (!/[(,=:[?]$|\breturn$/.test(before) || /=>$/.test(before)) continue;
    let depth = 0, part = "", keys = [];
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if ("{[(".includes(ch)) depth++;
      if ("}])".includes(ch)) depth--;
      if (depth === 0 || (depth === 1 && ch === ",")) {
        const p = part.trim(), m = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(p);
        if (m && !p.startsWith("...")) keys.push(m[1]);
        part = "";
        if (depth === 0) break;
      } else if (!(depth === 1 && ch === "{" && j === i)) part += ch;
    }
    const twice = keys.filter((k, n) => keys.indexOf(k) !== n);
    if (twice.length) found.push(`${twice.join(", ")} in ${text.slice(i, i + 60).replace(/\s+/g, " ")}`);
  }
  return found;
}

test("duplicate-key scan finds a key given twice", () => {
  assert.equal(duplicateKeys("x = { rel, on, old: 1, on: true };").length, 1);
  assert.deepEqual(duplicateKeys("x = { a, b: { a: 1 }, c: f({ a }) };"), []);
});

for (const sub of ["views/", "lib/", ""]) {
  const folder = new URL(`../mods/vsc/${sub}`, import.meta.url);
  for (const file of readdirSync(folder).filter(f => f.endsWith(".js"))) {
    test(`${sub}${file}: no object literal names a key twice`, () => {
      assert.deepEqual(duplicateKeys(readFileSync(new URL(file, folder), "utf8")), []);
    });
  }
}
