// Diagrams: Mermaid blocks in Markdown, the renderer's arguments, and the renderer itself, run with
// the real WebKit on macOS (drawing, an error in the diagram, and that nothing loads from anywhere).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DIAGRAM_RENDERER, rendererName, compileArgs, diagramArgs } from "../mods/vsc/lib/scripts.js";
import { mermaidBlocks, diagramKind, drawioPages } from "../mods/vsc/lib/diagrams.js";
import { classify } from "../mods/vsc/lib/files.js";

const DRAWIO = join(dirname(fileURLToPath(import.meta.url)), "..", "mods", "vsc", "vendor", "drawio", "viewer-static.min.js");
const EXCALIDRAW = join(dirname(fileURLToPath(import.meta.url)), "..", "mods", "vsc", "vendor", "excalidraw", "excalidraw-utils.js");
const MERMAID = join(dirname(fileURLToPath(import.meta.url)), "..", "mods", "vsc", "vendor", "mermaid", "mermaid.min.js");
const swift = process.platform === "darwin" && spawnSync("/usr/bin/xcode-select", ["-p"]).status === 0;

test("Mermaid files are diagrams; their source opens as text", () => {
  assert.equal(diagramKind("/a/flow.mmd"), "mermaid");
  assert.equal(diagramKind("/a/Flow.MERMAID"), "mermaid");
  assert.equal(diagramKind("/a/notes.md"), null);
  assert.equal(diagramKind("/a/arch.drawio"), "drawio");
  assert.equal(diagramKind("/a/arch.dio"), "drawio");
  assert.equal(classify("/a/arch.drawio", 10), "code");
  assert.equal(classify("/a/flow.mmd", 10), "code");
  assert.equal(diagramKind("/a/board.excalidraw"), "excalidraw");
  assert.equal(classify("/a/board.excalidraw", 10), "code");
  // Excalidraw's own picture exports stay pictures.
  assert.equal(diagramKind("/a/board.excalidraw.svg"), null);
  assert.equal(diagramKind("/a/board.excalidraw.png"), null);
});

test("mermaidBlocks finds fenced mermaid blocks, numbered from 1, and nothing inside other fences", () => {
  const md = [
    "# Title", "```mermaid", "flowchart LR", "  A --> B", "```", "text",
    "````md", "```mermaid", "not a block", "```", "````",
    "~~~ mermaid", "sequenceDiagram", "  A->>B: hi", "~~~",
    "```js", "mermaid()", "```",
  ].join("\n");
  assert.deepEqual(mermaidBlocks(md), [
    { index: 1, line: 2, source: "flowchart LR\n  A --> B" },
    { index: 2, line: 12, source: "sequenceDiagram\n  A->>B: hi" },
  ]);
  assert.deepEqual(mermaidBlocks("```mermaid\nflowchart LR\n  A --> B"), [{ index: 1, line: 1, source: "flowchart LR\n  A --> B" }]);
  assert.deepEqual(mermaidBlocks("no diagrams"), []);
});

test("drawioPages: the page names of a draw.io file, entities decoded, numbered when unnamed", () => {
  const xml = '<mxfile><diagram name="Prva &amp; glavna" id="a">x</diagram><diagram id="b"><mxGraphModel/></diagram></mxfile>';
  assert.deepEqual(drawioPages(xml), ["Prva & glavna", "Page 2"]);
  assert.deepEqual(drawioPages("<mxGraphModel/>"), ["Page 1"]);
  // Entities outside Unicode (a broken or hostile file) must not throw while the tab renders.
  assert.deepEqual(drawioPages('<diagram name="&#x110000;"/><diagram name="&#99999999;x"/>'), ["\ufffd", "\ufffdx"]);
});

test("diagramArgs: known kinds and themes, a page number, absolute paths only", () => {
  assert.deepEqual(diagramArgs("/t/diagram", "mermaid", "/m/lib.js", "/c/a.mmd", "/c/a.png", "dark"),
    ["/t/diagram", ["mermaid", "/m/lib.js", "/c/a.mmd", "/c/a.png", "dark", "0"]]);
  assert.deepEqual(diagramArgs("/t/diagram", "drawio", "/m/v.js", "/c/a.drawio", "/c/a.png", "light", 2)[1].slice(-1), ["2"]);
  assert.throws(() => diagramArgs("/t/diagram", "drawio", "/m/v.js", "/c/a.drawio", "/c/a.png", "light", -1));
  assert.deepEqual(diagramArgs("/t/diagram", "excalidraw", "/m/e.js", "/c/a.excalidraw", "/c/a.png", "dark")[1][0], "excalidraw");
  assert.throws(() => diagramArgs("/t/diagram", "plantuml", "/m/lib.js", "/c/a.mmd", "/c/a.png", "dark"));
  assert.throws(() => diagramArgs("/t/diagram", "mermaid", "/m/lib.js", "/c/a.mmd", "/c/a.png", "blue"));
  assert.throws(() => diagramArgs("/t/diagram", "mermaid", "lib.js", "/c/a.mmd", "/c/a.png", "dark"));
});

test("each tool has its own name prefix, so cleaning one never removes the other", () => {
  assert.match(rendererName(DIAGRAM_RENDERER, ["-O"], "diagram"), /^diagram-[a-z0-9]+$/);
  assert.match(rendererName(DIAGRAM_RENDERER), /^render-/);
});

const run = (cmd, args) => new Promise(done => execFile(cmd, args, { encoding: "utf8" }, (error, stdout, stderr) =>
  done({ code: error ? (error.code ?? 1) : 0, stdout, stderr })));

test("the diagram renderer draws Mermaid, reports errors, and loads nothing", { skip: !swift && "no swiftc (Xcode command line tools)", timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-diagram-"));
  writeFileSync(join(dir, "diagram.swift"), DIAGRAM_RENDERER);
  const [cc, ccArgs] = compileArgs(join(dir, "diagram.swift"), join(dir, "diagram"));
  execFileSync(cc, ccArgs);
  const bin = join(dir, "diagram");

  writeFileSync(join(dir, "a.mmd"), "flowchart LR\n  A[Korisnik čćžšđ] --> B{Prijava?}\n");
  const ok = await run(...diagramArgs(bin, "mermaid", MERMAID, join(dir, "a.mmd"), join(dir, "a.png"), "light"));
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual([...readFileSync(join(dir, "a.png")).subarray(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
  // The compiled blocking rule is kept next to the program, not in ~/Library/WebKit.
  assert.ok(existsSync(join(dir, "webkit-rules")));

  writeFileSync(join(dir, "bad.mmd"), "flowchart LR\n  A -->\n");
  const bad = await run(...diagramArgs(bin, "mermaid", MERMAID, join(dir, "bad.mmd"), join(dir, "bad.png"), "light"));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Parse error/);
  assert.ok(!existsSync(join(dir, "bad.png")));

  // draw.io: a compressed file with two pages; each page draws on its own.
  writeFileSync(join(dir, "two.drawio"), readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "two-pages.drawio")));
  for (const page of [0, 1]) {
    const r = await run(...diagramArgs(bin, "drawio", DRAWIO, join(dir, "two.drawio"), join(dir, `two-${page}.png`), "light", page));
    assert.equal(r.code, 0, r.stderr);
  }
  assert.notDeepEqual(readFileSync(join(dir, "two-0.png")), readFileSync(join(dir, "two-1.png")));
  writeFileSync(join(dir, "broken.drawio"), "<mxfile><diagram>not xml<");
  assert.equal((await run(...diagramArgs(bin, "drawio", DRAWIO, join(dir, "broken.drawio"), join(dir, "broken.png"), "light"))).code, 2);

  // A stand-in library that tries to load from a local server and a local file: nothing may arrive.
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); res.end(); });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, "probe.js"), `var mermaid = { initialize() {}, async render() {
    try { await fetch("${url}/fetch"); } catch (e) {}
    await new Promise(done => { const i = new Image(); i.onload = i.onerror = done; i.src = "${url}/img.png"; });
    try { await fetch("file:///etc/hosts"); } catch (e) {}
    return { svg: '<svg width="50" height="20"><rect width="50" height="20"/></svg>' };
  } };`);
  const probe = await run(...diagramArgs(bin, "mermaid", join(dir, "probe.js"), join(dir, "a.mmd"), join(dir, "p.png"), "dark"));
  await new Promise(done => setTimeout(done, 500));
  server.close();
  assert.equal(probe.code, 0, probe.stderr);
  assert.deepEqual(hits, []);

  // WebRTC is outside content rules: a STUN request would reach the network. It must not exist.
  const udp = createSocket("udp4"), packets = [];
  udp.on("message", (m) => packets.push(m.length));
  await new Promise(done => udp.bind(0, "127.0.0.1", done));
  writeFileSync(join(dir, "rtc.js"), `var mermaid = { initialize() {}, async render() {
    const has = typeof RTCPeerConnection;
    if (has !== "undefined") {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udp.address().port}" }] });
      pc.createDataChannel("x");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(done => setTimeout(done, 1500));
    }
    return { svg: '<svg width="50" height="20"><rect width="50" height="20"/></svg>' };
  } };`);
  const rtc = await run(...diagramArgs(bin, "mermaid", join(dir, "rtc.js"), join(dir, "a.mmd"), join(dir, "r.png"), "light"));
  await new Promise(done => setTimeout(done, 500));
  udp.close();
  assert.equal(rtc.code, 0, rtc.stderr);
  assert.deepEqual(packets, [], "STUN packets left the renderer");
});

// The pixels of an RGB(A) 8-bit PNG: { w, h, bpp, out }.
function pixels(file) {
  const png = readFileSync(file);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20), depth = png[24], type = png[25];
  assert.equal(depth, 8);
  const bpp = type === 6 ? 4 : type === 2 ? 3 : assert.fail(`colour type ${type}`);
  const parts = [];
  for (let i = 8; i < png.length;) {
    const len = png.readUInt32BE(i), kind = png.toString("latin1", i + 4, i + 8);
    if (kind === "IDAT") parts.push(png.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      out[y * stride + x] = (line[x] + pred) & 255;
    }
  }
  return { w, h, bpp, out };
}

// The share of pixels that are clearly red (an image element's colour).
function redShare(file) {
  const { w, h, bpp, out } = pixels(file);
  let red = 0;
  for (let i = 0; i < out.length; i += bpp) if (out[i] > 200 && out[i + 1] < 80 && out[i + 2] < 80) red++;
  return red / (w * h);
}

// How many columns hold dark ink: the drawn width of black text on a light background.
function inkWidth(file) {
  const { w, h, bpp, out } = pixels(file);
  let columns = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { const i = (y * w + x) * bpp; if (out[i] < 100 && out[i + 1] < 100 && out[i + 2] < 100) { columns++; break; } }
  }
  return columns;
}

test("the diagram renderer draws Excalidraw scenes with their images, offline", { skip: !swift && "no swiftc (Xcode command line tools)", timeout: 300000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-excalidraw-"));
  writeFileSync(join(dir, "diagram.swift"), DIAGRAM_RENDERER);
  const [cc, ccArgs] = compileArgs(join(dir, "diagram.swift"), join(dir, "diagram"));
  execFileSync(cc, ccArgs);
  const bin = join(dir, "diagram"), scene = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "scene.excalidraw");

  for (const theme of ["light", "dark"]) {
    const r = await run(...diagramArgs(bin, "excalidraw", EXCALIDRAW, scene, join(dir, `${theme}.png`), theme));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...readFileSync(join(dir, `${theme}.png`)).subarray(1, 4)], [0x50, 0x4e, 0x47]);
  }
  assert.notDeepEqual(readFileSync(join(dir, "light.png")), readFileSync(join(dir, "dark.png")));
  // The scene's 80x80 red picture (a data URL in the file) is drawn: a few percent of the picture.
  assert.ok(redShare(join(dir, "light.png")) > 0.02, `red share ${redShare(join(dir, "light.png"))}`);

  // Deleted elements are left out: only the deleted picture is red.
  const data = JSON.parse(readFileSync(scene, "utf8"));
  data.elements.find(e => e.type === "image").isDeleted = true;
  writeFileSync(join(dir, "deleted.excalidraw"), JSON.stringify(data));
  assert.equal((await run(...diagramArgs(bin, "excalidraw", EXCALIDRAW, join(dir, "deleted.excalidraw"), join(dir, "deleted.png"), "light"))).code, 0);
  assert.ok(redShare(join(dir, "deleted.png")) < 0.001);

  for (const [name, text, message] of [["broken", "{ not json", /JSON cannot be read/], ["empty", '{"type":"excalidraw"}', /no elements/],
    ["other", '{"elements": 5}', /no elements/], ["none", '{"elements": []}', /nothing to draw/],
    ["gone", JSON.stringify({ elements: [{ ...data.elements[0], isDeleted: true }] }), /nothing to draw/], ["nan", JSON.stringify({ elements: [{ ...data.elements[0], x: "abc" }] }), /nothing to draw/]]) {
    writeFileSync(join(dir, `${name}.excalidraw`), text);
    const r = await run(...diagramArgs(bin, "excalidraw", EXCALIDRAW, join(dir, `${name}.excalidraw`), join(dir, `${name}.png`), "light"));
    assert.equal(r.code, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, message);
    assert.ok(!existsSync(join(dir, `${name}.png`)));
  }

  // Text that would end the page's script early in HTML ("<!--" then "<script") draws like any text.
  const tricky = JSON.parse(readFileSync(scene, "utf8"));
  tricky.elements[1].text = tricky.elements[1].originalText = "<!-- <script> x </script>";
  writeFileSync(join(dir, "tricky.excalidraw"), JSON.stringify(tricky));
  const t = await run(...diagramArgs(bin, "excalidraw", EXCALIDRAW, join(dir, "tricky.excalidraw"), join(dir, "tricky.png"), "light"));
  assert.equal(t.code, 0, t.stderr);
  // No "-->" after it in the file: an arrow would end the HTML comment and hide the hang.
  writeFileSync(join(dir, "tricky.mmd"), "flowchart LR\n  A[\"<!-- <script> x\"]\n");
  const m = await run(...diagramArgs(bin, "mermaid", MERMAID, join(dir, "tricky.mmd"), join(dir, "tricky-m.png"), "light"));
  assert.equal(m.code, 0, m.stderr);

  // Every Excalidraw font is the library's own (no font file is shipped beside it), drawn offline:
  // Excalifont is not drawn as Virgil, and fonts that would fall back to the same system font (Lilita One
  // and Liberation Sans to sans-serif, Comic Shanns and Cascadia to monospace: same text width) are not.
  const fonts = (family) => { const d = JSON.parse(readFileSync(scene, "utf8")); d.elements = [{ ...d.elements[1], fontFamily: family }]; return JSON.stringify(d); };
  for (const [family, name] of [[5, "excalifont"], [1, "virgil"], [7, "lilita"], [9, "liberation"], [8, "comic"], [3, "cascadia"]]) {
    writeFileSync(join(dir, `${name}.excalidraw`), fonts(family));
    assert.equal((await run(...diagramArgs(bin, "excalidraw", EXCALIDRAW, join(dir, `${name}.excalidraw`), join(dir, `${name}.png`), "light"))).code, 0);
  }
  assert.notDeepEqual(readFileSync(join(dir, "excalifont.png")), readFileSync(join(dir, "virgil.png")));
  for (const [a, b] of [["lilita", "liberation"], ["comic", "cascadia"]]) {
    const wa = inkWidth(join(dir, `${a}.png`)), wb = inkWidth(join(dir, `${b}.png`));
    assert.ok(Math.abs(wa - wb) > 5, `${a} ${wa} px and ${b} ${wb} px wide`);
  }
});

// The library is run with one rewrite (its final export{...} becomes a global) inside an HTML page:
// a newly vendored version must still be the checked file, with one export{ and nothing that ends a
// script early.
test("the vendored Excalidraw library is the checked file and fits the renderer's rewrite", () => {
  const folder = dirname(EXCALIDRAW), code = readFileSync(EXCALIDRAW);
  const recorded = /sha256 of excalidraw-utils\.js here: ([0-9a-f]{64})/.exec(readFileSync(join(folder, "SOURCE.md"), "utf8"))[1];
  assert.equal(createHash("sha256").update(code).digest("hex"), recorded);
  const text = code.toString("utf8");
  assert.equal(text.split("export{").length - 1, 1);
  assert.ok(!/<\/script/i.test(text) && !text.includes("<!--"));
  assert.ok(!existsSync(join(folder, "Virgil.ttf")), "fonts come from the library itself");
});

// The family names of the WOFF2 fonts embedded in a file as base64 data URLs (their name tables).
function embeddedFontFamilies(text) {
  const families = new Set();
  for (const m of text.matchAll(/;base64,([A-Za-z0-9+/=]{2000,})/g)) {
    const b = Buffer.from(m[1], "base64");
    if (b.toString("latin1", 0, 4) !== "wOF2") continue;
    const count = b.readUInt16BE(12), compressed = b.readUInt32BE(20), tables = [];
    let p = 48;
    const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const x = b[p++]; v = v * 128 + (x & 127); if (!(x & 128)) return v; } };
    for (let i = 0; i < count; i++) {
      const flags = b[p++], known = flags & 63, tag = known === 63 ? b.toString("latin1", p, (p += 4)) : known;
      let length = base128();
      const transformed = (known === 10 || known === 11) ? ((flags >> 6) & 3) === 0 : ((flags >> 6) & 3) !== 0;
      if (transformed) length = base128();
      tables.push({ name: known === 5, length });
    }
    const data = brotliDecompressSync(b.subarray(p, p + compressed));
    let offset = 0;
    for (const t of tables) {
      if (t.name) {
        const n = data.subarray(offset, offset + t.length), strings = n.readUInt16BE(4);
        for (let i = 0; i < n.readUInt16BE(2); i++) {
          const r = 6 + 12 * i, platform = n.readUInt16BE(r), id = n.readUInt16BE(r + 6), len = n.readUInt16BE(r + 8), at = n.readUInt16BE(r + 10);
          if (id !== 1) continue;
          const raw = Buffer.from(n.subarray(strings + at, strings + at + len));
          families.add(platform === 1 ? raw.toString("latin1") : raw.swap16().toString("utf16le"));
        }
      }
      offset += t.length;
    }
  }
  return families;
}

// Liberation Sans 1.05 (GPLv2 with font exceptions, and its source is not published for that version)
// is taken out of the vendored library by scripts/vendor-excalidraw.mjs; its text uses the system's font.
test("the vendored Excalidraw library embeds no Liberation font, and keeps the others", () => {
  const families = embeddedFontFamilies(readFileSync(EXCALIDRAW, "utf8"));
  assert.ok(![...families].some(f => /liberation/i.test(f)), [...families].join(", "));
  for (const kept of ["Excalifont", "Virgil", "Cascadia Code", "Lilita One"]) assert.ok(families.has(kept), `${kept} missing: ${[...families].join(", ")}`);
});
