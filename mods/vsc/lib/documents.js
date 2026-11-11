// Helpers for PDF and document tabs. Pure: no herdr imports, so it runs under node --test.

// The renderer's first line: the PDF's page count, or null if it printed something else.
export function renderedPages(stdout) {
  const line = String(stdout ?? "").split("\n")[0].trim();
  return /^\d+$/.test(line) ? Number(line) : null;
}

// textutil's HTML for TextView: the body only (TextView has no CSS, so a <style> would show as
// text), without scripts and images (an image could point at any file or server).
export function documentHtml(html) {
  const text = String(html ?? "");
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text)?.[1] ?? text;
  return body
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .trim();
}

// textutil exits 0 when it cannot read a file (or refuses one that is not in the named format):
// it says so on stderr and prints nothing.
export function documentFailed(r) {
  return r.code !== 0 || /^Error reading/m.test(r.stderr ?? "") || String(r.stdout ?? "").trim() === "";
}

// The text handed to plantuml: without a leading byte order mark (which shifts PlantUML's line
// numbers), or null when there is nothing to draw.
export function plantumlSource(text) {
  const source = String(text ?? "").replace(/^\ufeff/, "");
  return source.trim() ? source : null;
}

// What plantuml said on stderr, without the JVM's notice that it picked up our Java options.
// PlantUML's own "ERROR", line, message counts lines from its diagram's @start line: with one
// diagram in `source` that is turned into the file's line.
export function plantumlFailure(stderr, source = "") {
  const text = String(stderr ?? "").split("\n").filter(line => !/^Picked up JAVA_TOOL_OPTIONS/.test(line)).join("\n").trim();
  const own = /^ERROR\n(\d+)\n([\s\S]*)$/.exec(text);
  // Anything else (a Java stack trace): its first line, cut short.
  if (!own) return text.split("\n")[0].slice(0, 300);
  const starts = String(source).split(/\r?\n/).flatMap((line, i) => (/^\s*@start/i.test(line) ? [i] : []));
  const where = starts.length === 1 ? `Line ${starts[0] + Number(own[1]) + 1}` : `Line ${own[1]} after @start`;
  return `${where}: ${own[2].trim()}`;
}

// The renderer's --text output: the page count line, then per page a mark ("t" its own text,
// "o" recognized from the picture), a tab, and the text ended by a NUL.
export function parsePdfText(stdout) {
  const text = String(stdout ?? ""), split = text.indexOf("\n");
  const total = split > 0 && /^\d+$/.test(text.slice(0, split)) ? Number(text.slice(0, split)) : null;
  if (total === null) return null;
  const entries = text.slice(split + 1).split("\0").slice(0, -1);
  if (!entries.every(entry => /^[to]\t/.test(entry))) return null;
  return {
    total,
    pages: entries.map(entry => entry.slice(2).replace(/\r\n?/g, "\n").trim()),
    recognized: entries.map(entry => entry[0] === "o"),
  };
}

// Whether a --text read returned every page it was asked for.
export function textComplete(text, first, count) {
  return text.pages.length === Math.max(Math.min(count, text.total - first + 1), 0);
}

// A text read that cannot help: it added no pages, or the file now has fewer pages than are shown
// (it changed on disk; the reload will bring new pictures). Reading on would start the renderer
// again and again for nothing.
export function textStalled(read, shown) {
  return read.pages.length === 0 || read.total < shown;
}

// What to do with a finished text read: "discard" when it no longer belongs to the shown version
// (a reload or Show more happened meanwhile; checked first, so an old version's read can never look
// like a stall), "stall" when it cannot help, else "append".
export function textReadAction(read, stillCurrent, shown) {
  if (!stillCurrent) return "discard";
  return textStalled(read, shown) ? "stall" : "append";
}

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Pages' text as HTML for one selectable TextView, numbered from `first`. Recognized pages say so.
export function pdfTextHtml(pages, first, recognized = []) {
  return pages.map((text, i) => `<h3>Page ${first + i}${recognized[i] && text ? " · recognized from the picture, may contain errors" : ""}</h3><p>${text
    ? escapeHtml(text).replace(/\n/g, "<br>")
    : "<i>No text found on this page.</i>"}</p>`).join("\n");
}

// `unzip -l` output: [{ size, name }] per entry (names may contain spaces).
export function parseZipListing(stdout) {
  return String(stdout ?? "").split("\n").flatMap(line => {
    const m = /^\s*(\d+)\s+\d{2,4}-\d{2}-\d{2,4}\s+\d{2}:\d{2}\s+(.+)$/.exec(line);
    return m ? [{ size: Number(m[1]), name: m[2] }] : [];
  });
}

export const PICTURE_LIMITS = { count: 60, each: 20 * 1000 * 1000, total: 100 * 1000 * 1000 };
const MEDIA = { docx: "word/media/", odt: "Pictures/" };

// The pictures of a Word (docx) or OpenDocument (odt) file worth showing: formats the app draws,
// directly in the media folder, with plain names only (so no entry can name a path or an unzip
// pattern or option), in the order of the numbers in their names (Word numbers them as they
// appear), within PICTURE_LIMITS by the listed sizes. An archive can lie about sizes, so this is only
// a first filter: viewers.js counts the bytes each copy really wrote.
export function pictureEntries(entries, format) {
  const folder = MEDIA[format];
  if (!folder) return [];
  const name = new RegExp(`^${folder.replace("/", "\\/")}[A-Za-z0-9_ ()][A-Za-z0-9._ ()-]*\\.(png|jpe?g|gif|bmp|webp)$`, "i");
  const number = (e) => Number(/\d+/.exec(e.name.slice(folder.length))?.[0] ?? Infinity);
  const shown = entries.filter(e => name.test(e.name) && !e.name.includes("..") && e.size <= PICTURE_LIMITS.each)
    .sort((a, b) => number(a) - number(b) || a.name.localeCompare(b.name));
  const kept = [];
  let total = 0;
  for (const e of shown) {
    if (kept.length === PICTURE_LIMITS.count || total + e.size > PICTURE_LIMITS.total) break;
    kept.push(e); total += e.size;
  }
  return kept;
}
