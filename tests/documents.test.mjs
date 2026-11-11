// PDF pages and text documents: the renderer and textutil run with the real tools (macOS only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDF_RENDERER, rendererName, compileArgs, installArgs, renderArgs, textArgs, documentArgs, defaultAppArgs, osNameArgs } from "../mods/vsc/lib/scripts.js";
import { documentHtml, renderedPages, documentFailed, parsePdfText, pdfTextHtml, textComplete, textStalled, textReadAction } from "../mods/vsc/lib/documents.js";
import { externalAction } from "../mods/vsc/lib/files.js";
import { spawnSync } from "node:child_process";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const has = (cmd, args) => { try { run(cmd, args); return true; } catch { return false; } };
const mac = process.platform === "darwin";
const swift = mac && has("/usr/bin/xcode-select", ["-p"]);

test("the renderer's name follows its source, so a changed source is compiled again", () => {
  assert.match(rendererName(PDF_RENDERER), /^render-[a-z0-9]+$/);
  assert.equal(rendererName(PDF_RENDERER), rendererName(PDF_RENDERER));
  assert.notEqual(rendererName(PDF_RENDERER), rendererName(PDF_RENDERER + "\n"));
  assert.notEqual(rendererName(PDF_RENDERER), rendererName(PDF_RENDERER, ["-Onone"]));
});

test("renderedPages reads the page count and refuses anything else", () => {
  assert.equal(renderedPages("12\n"), 12);
  assert.equal(renderedPages("0\n"), 0);
  assert.equal(renderedPages(""), null);
  assert.equal(renderedPages("x\n"), null);
});

test("parsePdfText: the page count line, then per page a t/o mark, a tab and its text ended by a NUL", () => {
  assert.deepEqual(parsePdfText("3\nt\tone\0o\ttwo\nlines\0"),
    { total: 3, pages: ["one", "two\nlines"], recognized: [false, true] });
  assert.deepEqual(parsePdfText("2\nt\t\0t\t\0"), { total: 2, pages: ["", ""], recognized: [false, false] });
  assert.equal(parsePdfText("x\n"), null);
  assert.equal(parsePdfText("1\nno mark\0"), null);
});

test("textComplete: a read must return every asked page that exists", () => {
  const read = (n, total) => ({ total, pages: Array(n).fill("x"), recognized: Array(n).fill(false) });
  assert.equal(textComplete(read(20, 231), 1, 20), true);
  assert.equal(textComplete(read(11, 231), 221, 20), true);
  assert.equal(textComplete(read(19, 231), 1, 20), false);
  // Output cut off in the middle of a page: parsePdfText drops the unfinished one.
  assert.equal(textComplete(parsePdfText("3\nt\tone\0t\ttw"), 1, 3), false);
});

test("textStalled: a read that added nothing, or a file now shorter than what is shown", () => {
  const read = (n, total) => ({ total, pages: Array(n).fill("x"), recognized: Array(n).fill(false) });
  assert.equal(textStalled(read(20, 231), 40), false);
  assert.equal(textStalled(read(0, 30), 40), true);
  assert.equal(textStalled(read(5, 30), 40), true);
  assert.equal(textStalled(read(11, 231), 231), false);
});

test("textReadAction: an old version's read is discarded before it can look like a stall", () => {
  const read = (n, total) => ({ total, pages: Array(n).fill("x"), recognized: Array(n).fill(false) });
  assert.equal(textReadAction(read(20, 231), true, 40), "append");
  // The file shrank to 15 pages and its reload finished while pages 21-40 were read.
  assert.equal(textReadAction(read(0, 15), false, 15), "discard");
  assert.equal(textReadAction(read(0, 15), true, 40), "stall");
  assert.equal(textReadAction(read(20, 231), false, 40), "discard");
});

test("pdfTextHtml numbers pages from `first` and escapes the text", () => {
  const html = pdfTextHtml(["a < b & c", "line 1\nline 2"], 3);
  assert.match(html, /Page 3/);
  assert.match(html, /Page 4/);
  assert.match(html, /a &lt; b &amp; c/);
  assert.match(html, /line 1<br>line 2/);
  assert.doesNotMatch(pdfTextHtml(["<script>x</script>"], 1), /<script>/);
  assert.match(pdfTextHtml(["", "x"], 1), /Page 1<\/h3><p><i>No text found on this page/);
  const ocr = pdfTextHtml(["read from a scan", "real text"], 1, [true, false]);
  assert.match(ocr, /Page 1 · recognized from the picture, may contain errors<\/h3>/);
  assert.match(ocr, /<h3>Page 2<\/h3>/);
});

test("textArgs: --text, the PDF, first page and count; absolute paths only", () => {
  assert.deepEqual(textArgs("/t/render", "/a/b.pdf", 1, 20), ["/t/render", ["--text", "/a/b.pdf", "1", "20"]]);
  assert.throws(() => textArgs("/t/render", "b.pdf", 1, 20));
});

test("documentHtml keeps the body and drops head, styles, scripts and images", () => {
  const html = '<html><head><title>T</title><style>p {color: red}</style></head><body><h1>Title</h1>'
    + '<script>alert(1)</script><p>Text <img src="file:///etc/x.png"> <a href="https://a.b">link</a></p></body></html>';
  const out = documentHtml(html);
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<a href="https:\/\/a.b">link<\/a>/);
  assert.doesNotMatch(out, /style|color: red|script|alert|<img|<title>/i);
  assert.equal(documentHtml("<p>no body tag</p>"), "<p>no body tag</p>");
});

test("default app: /usr/bin/open on macOS, xdg-open elsewhere, absolute paths only", () => {
  assert.deepEqual(defaultAppArgs(true, "/a/b.pdf"), ["/usr/bin/open", ["/a/b.pdf"]]);
  assert.deepEqual(defaultAppArgs(false, "/a/b.pdf"), ["xdg-open", ["/a/b.pdf"]]);
  assert.throws(() => defaultAppArgs(true, "-a.pdf"));
});

test("externalAction opens only view-only formats that are not executable", () => {
  assert.equal(externalAction("pdf", "/a/b.pdf", "644"), "open");
  assert.equal(externalAction("document", "/a/b.docx", "600"), "open");
  assert.equal(externalAction("binary", "/a/b.xlsx", "644"), "open");
  assert.equal(externalAction("pdf", "/a/b.pdf", "755"), "reveal");
  assert.equal(externalAction("binary", "/a/tool.jar", "644"), "reveal");
  assert.equal(externalAction("binary", "/a/README", "644"), "reveal");
  assert.equal(externalAction("too-large", "/a/big.pdf", null), "reveal");
  assert.equal(externalAction("code", "/a/b.ts", "644"), null);
  assert.equal(externalAction("image", "/a/b.png", "644"), null);
  assert.equal(externalAction("too-large", "/a/big.svg", "644"), "reveal");
  assert.equal(externalAction("too-large", "/a/big.png", "644"), "open");
  // A link named like a document but pointing elsewhere: `open` would use the target's app.
  assert.equal(externalAction("pdf", "/a/spec.pdf", "644", "/a/.x.terminal"), "reveal");
  assert.equal(externalAction("document", "/a/b.docx", "644", "/a/t.jar"), "reveal");
  assert.equal(externalAction("pdf", "/a/spec.pdf", "644", "/a/real.png"), "reveal");
  assert.equal(externalAction("pdf", "/a/spec.pdf", "644", "/b/spec.pdf"), "open");
});

test("documentArgs names the format and refuses others", () => {
  assert.deepEqual(documentArgs("/a/B.DOCX")[1].slice(0, 2), ["-format", "docx"]);
  assert.throws(() => documentArgs("/a/b.html"));
});

test("documentFailed: an exit code, textutil's read error, or nothing printed", () => {
  assert.equal(documentFailed({ code: 0, stdout: "<p>x</p>", stderr: "" }), false);
  assert.equal(documentFailed({ code: 1, stdout: "<p>x</p>", stderr: "" }), true);
  assert.equal(documentFailed({ code: 0, stdout: "", stderr: "Error reading a.docx.  The file isn't in the correct format." }), true);
  assert.equal(documentFailed({ code: 0, stdout: "  \n", stderr: "" }), true);
});

test("uname -s names the system", () => {
  const [cmd, args] = osNameArgs();
  assert.match(run(cmd, args).trim(), /^[A-Za-z]+$/);
});

test("HTML named .docx is refused", { skip: !mac && "textutil is macOS only" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-doc-"));
  // A file:// image stands in for a server: textutil would read it while converting HTML.
  writeFileSync(join(dir, "probe.png"), "x");
  writeFileSync(join(dir, "fake.docx"), `<html><body><img src="file://${join(dir, "probe.png")}">hi</body></html>`);
  const [cmd, args] = documentArgs(join(dir, "fake.docx"));
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  assert.equal(documentFailed({ code: r.status, stdout: r.stdout, stderr: r.stderr }), true);
  assert.doesNotMatch(r.stdout, /hi/);
});

test("a .doc that is really RTF reads with -format rtf", { skip: !mac && "textutil is macOS only" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-doc-"));
  writeFileSync(join(dir, "w.doc"), "{\\rtf1\\ansi Saved by Word as RTF.}");
  const asDoc = spawnSync(...documentArgs(join(dir, "w.doc")), { encoding: "utf8" });
  assert.equal(documentFailed({ code: asDoc.status, stdout: asDoc.stdout, stderr: asDoc.stderr }), true);
  const [cmd, args] = documentArgs(join(dir, "w.doc"), "rtf");
  assert.match(run(cmd, args), /Saved by Word as RTF\./);
  assert.throws(() => documentArgs(join(dir, "w.doc"), "html"));
});

test("textutil turns a .docx into HTML", { skip: !mac && "textutil is macOS only" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-doc-"));
  writeFileSync(join(dir, "t.txt"), "Naslov\n\nČćžšđ tekst.\n");
  run("textutil", ["-convert", "docx", join(dir, "t.txt"), "-output", join(dir, "-t.docx")]);
  const [cmd, args] = documentArgs(join(dir, "-t.docx"));
  const html = documentHtml(run(cmd, args));
  assert.match(html, /Čćžšđ tekst\./);
  assert.throws(() => documentArgs("-t.docx"));
});

test("the PDF renderer compiles and writes the asked pages", { skip: !swift && "no swiftc (Xcode command line tools)", timeout: 120000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-pdf-"));
  writeFileSync(join(dir, "render.swift"), PDF_RENDERER);
  // The way the tab builds it: swiftc into a .partial, then mv into place.
  const [cc, ccArgs] = compileArgs(join(dir, "render.swift"), join(dir, "render.partial"));
  run(cc, ccArgs);
  const [mv, mvArgs] = installArgs(join(dir, "render.partial"), join(dir, "render"));
  run(mv, mvArgs);
  assert.ok(!existsSync(join(dir, "render.partial")));
  // A three-page PDF, drawn by the system's own text-to-PDF path (cupsfilter).
  writeFileSync(join(dir, "t.txt"), "one\f two\f three\n");
  writeFileSync(join(dir, "t.pdf"), execFileSync("/usr/sbin/cupsfilter", [join(dir, "t.txt")], { stdio: ["ignore", "pipe", "ignore"] }));
  const [bin, args] = renderArgs(join(dir, "render"), join(dir, "t.pdf"), join(dir, "page-"), 2, 5, 400);
  assert.equal(renderedPages(run(bin, args)), 3);
  // Text mode: each asked page's text, nothing drawn.
  const text = parsePdfText(run(...textArgs(join(dir, "render"), join(dir, "t.pdf"), 2, 5)));
  assert.equal(text.total, 3);
  assert.equal(text.pages.length, 2);
  assert.match(text.pages[0], /two/);
  assert.match(text.pages[1], /three/);
  assert.deepEqual(text.recognized, [false, false]);
  // A scanned PDF (each page only a picture of a page, made by PDFKit): its text is recognized.
  mkdirSync(join(dir, "scan"));
  writeFileSync(join(dir, "scan", "scan.swift"), `import AppKit
import PDFKit
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!, out = PDFDocument()
for i in 0..<doc.pageCount {
  let page = doc.page(at: i)!, box = page.bounds(for: .mediaBox)
  out.insert(PDFPage(image: page.thumbnail(of: NSSize(width: box.width * 3, height: box.height * 3), for: .mediaBox))!, at: i)
}
exit(out.write(to: URL(fileURLWithPath: a[2])) ? 0 : 1)
`);
  writeFileSync(join(dir, "words.txt"), "Herdr reads scanned pages\fSecond scanned page here\n");
  writeFileSync(join(dir, "words.pdf"), execFileSync("/usr/sbin/cupsfilter", [join(dir, "words.txt")], { stdio: ["ignore", "pipe", "ignore"] }));
  run("/usr/bin/swiftc", [join(dir, "scan", "scan.swift"), "-o", join(dir, "scan", "scan")]);
  run(join(dir, "scan", "scan"), [join(dir, "words.pdf"), join(dir, "scanned.pdf")]);
  const scanned = parsePdfText(run(...textArgs(join(dir, "render"), join(dir, "scanned.pdf"), 1, 5)));
  assert.equal(scanned.total, 2);
  assert.deepEqual(scanned.recognized, [true, true]);
  assert.match(scanned.pages[0], /reads scanned pages/i);
  assert.match(scanned.pages[1], /Second scanned page/i);
  // A scan whose scanner stamped a page number as text: under 20 characters of its own, so it is
  // still read from its picture.
  writeFileSync(join(dir, "scan", "stamp.swift"), `import AppKit
import PDFKit
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
var box = doc.page(at: 0)!.bounds(for: .mediaBox)
let ctx = CGContext(URL(fileURLWithPath: a[2]) as CFURL, mediaBox: &box, nil)!
for i in 0..<doc.pageCount {
  let page = doc.page(at: i)!
  let picture = page.thumbnail(of: NSSize(width: box.width * 3, height: box.height * 3), for: .mediaBox)
  ctx.beginPDFPage(nil)
  ctx.draw(picture.cgImage(forProposedRect: nil, context: nil, hints: nil)!, in: box)
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  NSString(string: "\\(i + 7)").draw(at: NSPoint(x: box.width - 40, y: 20), withAttributes: [.font: NSFont.systemFont(ofSize: 10)])
  ctx.endPDFPage()
}
ctx.closePDF()
`);
  run("/usr/bin/swiftc", [join(dir, "scan", "stamp.swift"), "-o", join(dir, "scan", "stamp")]);
  run(join(dir, "scan", "stamp"), [join(dir, "words.pdf"), join(dir, "stamped.pdf")]);
  const own = parsePdfText(run(...textArgs(join(dir, "render"), join(dir, "stamped.pdf"), 1, 1)));
  assert.deepEqual(own.recognized, [true]);
  assert.match(own.pages[0], /reads scanned pages/i);
  assert.deepEqual(readdirSync(dir).filter(n => n.startsWith("page-")).sort(), ["page-2.png", "page-3.png"]);
  assert.ok(!existsSync(join(dir, "page-1.png")));
  writeFileSync(join(dir, "bad.pdf"), "not a pdf");
  assert.equal(spawnSync(bin, renderArgs(join(dir, "render"), join(dir, "bad.pdf"), join(dir, "x-"), 1, 1, 400)[1]).status, 2);
  // Without arguments a working renderer exits 1 at once (viewers.js startsUp).
  assert.equal(spawnSync(bin, []).status, 1);
  // A password-protected copy, written by PDFKit itself: exit 4.
  mkdirSync(join(dir, "lock"));
  writeFileSync(join(dir, "lock", "lock.swift"), `import PDFKit
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
exit(doc.write(to: URL(fileURLWithPath: a[2]), withOptions: [.userPasswordOption: "x", .ownerPasswordOption: "x"]) ? 0 : 1)
`);
  run("/usr/bin/swiftc", [join(dir, "lock", "lock.swift"), "-o", join(dir, "lock", "lock")]);
  run(join(dir, "lock", "lock"), [join(dir, "t.pdf"), join(dir, "locked.pdf")]);
  assert.equal(spawnSync(bin, renderArgs(join(dir, "render"), join(dir, "locked.pdf"), join(dir, "y-"), 1, 1, 400)[1]).status, 4);
});
