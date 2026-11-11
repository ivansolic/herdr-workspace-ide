import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, sizeLimit, languageFor, draftName, tabLabel, baseName, EDIT_LIMIT, READ_LIMIT, DOCUMENT_LIMIT } from "../mods/vsc/lib/files.js";

test("classify picks the view by extension and size", () => {
  assert.equal(classify("notes.md", 10), "markdown");
  assert.equal(classify("README.MDX", 10), "markdown");
  assert.equal(classify("logo.png", 10), "image");
  assert.equal(classify("photo.JPEG", 10), "image");
  assert.equal(classify("app.ts", 10), "code");
  assert.equal(classify("LICENSE", 10), "code");
});

test("size limits: edit up to 1 MiB, read-only up to 8 MB, too large beyond", () => {
  assert.equal(EDIT_LIMIT, 1024 * 1024);
  assert.equal(READ_LIMIT, 8 * 1000 * 1000);
  assert.equal(classify("app.ts", EDIT_LIMIT), "code");
  assert.equal(classify("app.ts", EDIT_LIMIT + 1), "readonly");
  assert.equal(classify("notes.md", EDIT_LIMIT + 1), "readonly");
  assert.equal(classify("app.ts", READ_LIMIT + 1), "too-large");
  assert.equal(classify("logo.png", READ_LIMIT + 1), "too-large");
});

test("binary formats without a viewer are not opened as text", () => {
  assert.equal(classify("archive.zip", 10), "binary");
  assert.equal(classify("db.sqlite", 10), "binary");
  assert.equal(classify("sheet.xlsx", 10), "binary");
});

test("PDFs and text documents get their own views, up to 50 MB", () => {
  assert.equal(classify("doc.pdf", 10), "pdf");
  assert.equal(classify("Doc.PDF", 10), "pdf");
  for (const name of ["a.docx", "a.doc", "a.rtf", "a.odt"]) assert.equal(classify(name, 10), "document");
  assert.equal(DOCUMENT_LIMIT, 50 * 1000 * 1000);
  assert.equal(classify("doc.pdf", READ_LIMIT + 1), "pdf");
  assert.equal(classify("a.docx", DOCUMENT_LIMIT), "document");
  assert.equal(classify("doc.pdf", DOCUMENT_LIMIT + 1), "too-large");
  assert.equal(sizeLimit("doc.pdf"), DOCUMENT_LIMIT);
  assert.equal(sizeLimit("app.ts"), READ_LIMIT);
});

test("languageFor follows the shipped files mod: overrides, else the extension", () => {
  assert.equal(languageFor("a.ts"), "js");
  assert.equal(languageFor("a.tsx"), "js");
  assert.equal(languageFor("a.toml"), "yaml");
  assert.equal(languageFor("a.jsonc"), "json");
  assert.equal(languageFor("a.vue"), "html");
  assert.equal(languageFor("a.py"), "py");
  assert.equal(languageFor("A.MD"), "md");
  assert.equal(languageFor("noext"), "txt");
});

test("draftName is stable, distinct per machine and path, and file-name safe", () => {
  const a = draftName(null, "/a/b.ts"), b = draftName("vps", "/a/b.ts"), c = draftName(null, "/a/c.ts");
  assert.equal(a, draftName(null, "/a/b.ts"));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-z0-9-]+\.txt$/);
});

test("tab labels show the file name and an unsaved dot", () => {
  assert.equal(baseName("/a/b/c.ts"), "c.ts");
  assert.equal(baseName("C:\\a\\c.ts"), "c.ts");
  assert.equal(tabLabel("/a/c.ts", false), "c.ts");
  assert.equal(tabLabel("/a/c.ts", true), "● c.ts");
});
