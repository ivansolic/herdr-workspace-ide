#!/usr/bin/env node
// Builds mods/vsc/vendor/excalidraw/excalidraw-utils.js from @excalidraw/utils 0.1.8's dist/prod/index.js
// (the npm tarball, see vendor/excalidraw/SOURCE.md): the one change is that the embedded Liberation Sans
// 1.05 font (GPLv2 with font exceptions, no published source for that version) becomes a system font
// reference ("local:", as the library's own Helvetica entry), so its text is drawn with the system's font.
//
// Usage: node scripts/vendor-excalidraw.mjs <path to the original index.js> <output path>
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";

const ORIGINAL_SHA256 = "d859cee50c6148ba53192da5454d48d8370ced75449a678b6baefc293c29fe6e";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// The family names in a WOFF2 font's name table.
function families(woff2) {
  const b = woff2, count = b.readUInt16BE(12), compressed = b.readUInt32BE(20), tables = [], found = [];
  let p = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const x = b[p++]; v = v * 128 + (x & 127); if (!(x & 128)) return v; } };
  for (let i = 0; i < count; i++) {
    const flags = b[p++], known = flags & 63;
    if (known === 63) p += 4;
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
        found.push(platform === 1 ? raw.toString("latin1") : raw.swap16().toString("utf16le"));
      }
    }
    offset += t.length;
  }
  return found;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error("usage: node scripts/vendor-excalidraw.mjs <original index.js> <output>"); process.exit(1); }
const original = readFileSync(input);
if (sha256(original) !== ORIGINAL_SHA256) { console.error(`not the checked @excalidraw/utils 0.1.8 index.js (sha256 ${sha256(original)})`); process.exit(2); }

let replaced = 0;
const text = original.toString("utf8").replace(/"data:font\/woff2;base64,([A-Za-z0-9+/=]+)"/g, (literal, base64) => {
  if (!families(Buffer.from(base64, "base64")).some(f => /liberation/i.test(f))) return literal;
  replaced++;
  return '"local:"';
});
if (replaced !== 1) { console.error(`expected one Liberation font, found ${replaced}`); process.exit(3); }
writeFileSync(output, text);
console.log(`wrote ${output}\nsha256 ${sha256(Buffer.from(text))}`);
