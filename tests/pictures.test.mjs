// Pictures inside Word and OpenDocument files: which archive entries count, the limits, and the
// real unzip extracting them (paths stripped, nothing outside the target folder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseZipListing, pictureEntries, PICTURE_LIMITS } from "../mods/vsc/lib/documents.js";
import { zipListArgs, PICTURE_COPY } from "../mods/vsc/lib/scripts.js";

const LISTING = `Archive:  /a/b.docx
  Length      Date    Time    Name
---------  ---------- -----   ----
      539  11-07-2026 08:56   [Content_Types].xml
    12345  11-07-2026 08:56   word/media/image1.png
      777  11-07-2026 08:56   word/media/image10.jpeg
      888  11-07-2026 08:56   word/media/image2.emf
       99  11-07-2026 08:56   word/media/my picture 3.gif
---------                     -------
    14648                     5 files
`;

test("parseZipListing reads sizes and names, names with spaces included", () => {
  assert.deepEqual(parseZipListing(LISTING).slice(1, 3), [
    { size: 12345, name: "word/media/image1.png" }, { size: 777, name: "word/media/image10.jpeg" }]);
  assert.equal(parseZipListing(LISTING).length, 5);
  assert.deepEqual(parseZipListing("garbage"), []);
});

test("pictureEntries: shown formats in the media folder, in document order, never odd names", () => {
  assert.deepEqual(pictureEntries(parseZipListing(LISTING), "docx").map(e => e.name),
    ["word/media/image1.png", "word/media/my picture 3.gif", "word/media/image10.jpeg"]);
  const odd = [
    { size: 1, name: "word/media/../../evil.png" }, { size: 1, name: "word/media/-x.png" },
    { size: 1, name: "word/media/a*.png" }, { size: 1, name: "word/media/sub/a.png" },
    { size: 1, name: "word/x.png" }, { size: 1, name: "Pictures/ok.png" },
  ];
  assert.deepEqual(pictureEntries(odd, "docx"), []);
  assert.deepEqual(pictureEntries(odd, "odt").map(e => e.name), ["Pictures/ok.png"]);
});

test("pictureEntries: too many, too big each, or too big together are cut off", () => {
  const many = Array.from({ length: PICTURE_LIMITS.count + 5 }, (_, i) => ({ size: 10, name: `word/media/image${i + 1}.png` }));
  assert.equal(pictureEntries(many, "docx").length, PICTURE_LIMITS.count);
  assert.deepEqual(pictureEntries([{ size: PICTURE_LIMITS.each + 1, name: "word/media/big.png" }], "docx"), []);
  // Each at the per-picture limit: only as many as the total allows.
  const heavy = Array.from({ length: 10 }, (_, i) => ({ size: PICTURE_LIMITS.each, name: `word/media/image${i + 1}.png` }));
  assert.equal(pictureEntries(heavy, "docx").length, Math.floor(PICTURE_LIMITS.total / PICTURE_LIMITS.each));
});

test("zip listing arguments: absolute paths only", () => {
  assert.deepEqual(zipListArgs("/a/b.docx"), ["/usr/bin/unzip", ["-l", "/a/b.docx"]]);
  assert.throws(() => zipListArgs("b.docx"));
});

// PICTURE_COPY copies one entry: $1 archive, $2 entry, $3 byte cap, $4 output; prints the bytes written.
const copy = (archive, entry, cap, out) =>
  Number(execFileSync("sh", ["-c", PICTURE_COPY, "vsc", archive, entry, String(cap), out], { encoding: "utf8" }).trim());

test("the real unzip lists and extracts only the chosen pictures, flat, inside the folder", { skip: !existsSync("/usr/bin/unzip") && "no unzip" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-pictures-"));
  mkdirSync(join(dir, "src", "word", "media"), { recursive: true });
  writeFileSync(join(dir, "src", "word", "document.xml"), "<w:document/>");
  writeFileSync(join(dir, "src", "word", "media", "image1.png"), "png");
  writeFileSync(join(dir, "src", "word", "media", "my picture 2.gif"), "gif");
  writeFileSync(join(dir, "src", "word", "media", "image3.emf"), "emf");
  execFileSync("/usr/bin/zip", ["-qr", join(dir, "doc.docx"), "."], { cwd: join(dir, "src") });
  const listing = execFileSync(...zipListArgs(join(dir, "doc.docx")), { encoding: "utf8" });
  const wanted = pictureEntries(parseZipListing(listing), "docx");
  assert.deepEqual(wanted.map(e => e.name), ["word/media/image1.png", "word/media/my picture 2.gif"]);
  assert.equal(copy(join(dir, "doc.docx"), "word/media/my picture 2.gif", 1000, join(dir, "pic-1.gif")), 3);
  assert.equal(readFileSync(join(dir, "pic-1.gif"), "utf8"), "gif");
});

test("a hostile archive cannot write more than the cap or copy what a symlink points at", { skip: !existsSync("/usr/bin/unzip") && "no unzip" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-hostile-"));
  // An entry that claims 1000 bytes in its headers but holds 5 MB (sizes patched after zipping).
  mkdirSync(join(dir, "src", "word", "media"), { recursive: true });
  writeFileSync(join(dir, "src", "word", "media", "image1.png"), Buffer.alloc(5 * 1024 * 1024, 65));
  execFileSync("/usr/bin/zip", ["-qr", join(dir, "bomb.docx"), "word"], { cwd: join(dir, "src") });
  const zip = readFileSync(join(dir, "bomb.docx"));
  for (const [sig, at] of [[0x04034b50, 22], [0x02014b50, 24]]) {
    for (let i = 0; i < zip.length - 4; i++) if (zip.readUInt32LE(i) === sig) zip.writeUInt32LE(1000, i + at);
  }
  writeFileSync(join(dir, "bomb.docx"), zip);
  const listed = pictureEntries(parseZipListing(execFileSync(...zipListArgs(join(dir, "bomb.docx")), { encoding: "utf8" })), "docx");
  assert.deepEqual(listed.map(e => [e.name, e.size]), [["word/media/image1.png", 1000]]);
  assert.equal(copy(join(dir, "bomb.docx"), "word/media/image1.png", 1001, join(dir, "bomb.png")), 1001);
  assert.equal(statSync(join(dir, "bomb.png")).size, 1001);

  // An entry stored as a symlink to a secret: the copy holds the link's text, never the secret.
  mkdirSync(join(dir, "link", "word", "media"), { recursive: true });
  writeFileSync(join(dir, "secret.txt"), "SECRET");
  symlinkSync(join(dir, "secret.txt"), join(dir, "link", "word", "media", "image1.png"));
  execFileSync("/usr/bin/zip", ["-qry", join(dir, "link.docx"), "word"], { cwd: join(dir, "link") });
  copy(join(dir, "link.docx"), "word/media/image1.png", 1001, join(dir, "link.png"));
  assert.doesNotMatch(readFileSync(join(dir, "link.png"), "utf8"), /SECRET/);
  // And one pointing at /dev/zero ends at once.
  mkdirSync(join(dir, "zero", "word", "media"), { recursive: true });
  symlinkSync("/dev/zero", join(dir, "zero", "word", "media", "image1.png"));
  execFileSync("/usr/bin/zip", ["-qry", join(dir, "zero.docx"), "word"], { cwd: join(dir, "zero") });
  const r = spawnSync("sh", ["-c", PICTURE_COPY, "vsc", join(dir, "zero.docx"), "word/media/image1.png", "1001", join(dir, "zero.png")], { timeout: 10000 });
  assert.equal(r.signal, null);
  assert.ok(statSync(join(dir, "zero.png")).size <= 1001);
});
