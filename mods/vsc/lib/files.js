// What kind of view a file gets, its editor language, and names for drafts and tabs.
// Pure: no herdr imports, so it runs under node --test.

export const EDIT_LIMIT = 1024 * 1024;     // readTextFile reads up to 1 MiB
export const READ_LIMIT = 8 * 1000 * 1000; // exec returns at most 8 MiB of output
export const DOCUMENT_LIMIT = 50 * 1000 * 1000; // PDFs and documents are converted, not read through exec

const MARKDOWN = new Set(["md", "mdx", "markdown"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const PDF = new Set(["pdf"]);
const DOCUMENTS = new Set(["docx", "doc", "rtf", "odt"]); // what macOS textutil reads
const BINARY = new Set(["zip", "gz", "tgz", "tar", "7z", "rar", "sqlite", "db", "exe", "dll", "so", "dylib",
  "woff", "woff2", "ttf", "otf", "mp3", "mp4", "mov", "wav", "class", "jar", "bin", "xlsx", "pptx", "lockb"]);
// Same overrides as Herdr's shipped files mod; other extensions are passed as-is.
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

export function baseName(path) {
  return String(path ?? "").split(/[\\/]/).pop();
}

function extension(path) {
  const name = baseName(path).toLowerCase(), dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export function sizeLimit(path) {
  const ext = extension(path);
  return PDF.has(ext) || DOCUMENTS.has(ext) ? DOCUMENT_LIMIT : READ_LIMIT;
}

// "markdown" | "image" | "code" | "readonly" | "pdf" | "document" | "binary" | "too-large"
export function classify(path, size) {
  const ext = extension(path);
  if (size > sizeLimit(path)) return "too-large";
  if (PDF.has(ext)) return "pdf";
  if (DOCUMENTS.has(ext)) return "document";
  if (IMAGES.has(ext)) return "image";
  if (BINARY.has(ext)) return "binary";
  if (size > EDIT_LIMIT) return "readonly";
  return MARKDOWN.has(ext) ? "markdown" : "code";
}

// Binary formats whose default app only shows them. Anything else (an extensionless file, a .jar,
// an .app) may be run by `open`, and files from git carry no quarantine flag to make macOS ask.
// Not svg: its default app is often a browser, which runs the scripts an SVG can carry.
const VIEW_ONLY = new Set([...PDF, ...DOCUMENTS, ...[...IMAGES].filter(ext => ext !== "svg"), "xlsx", "pptx", "mp3", "mp4", "mov", "wav"]);

// What the tab offers for a file it cannot show (or shows only in part): "open" in its default
// app, "reveal" in Finder, or null. `mode` is the octal permission string of `real`, where a
// symlink points (unknown counts as executable). `open` follows the link and the system picks the
// app by the target, so the link's name and the target's must both be view-only, and the same.
export function externalAction(kind, path, mode, real = path) {
  if (!["pdf", "document", "binary", "too-large"].includes(kind)) return null;
  const executable = !/^[0-7]{3,4}$/.test(String(mode ?? "")) || /[1357]/.test(String(mode).slice(-3));
  const ext = extension(path);
  return VIEW_ONLY.has(ext) && extension(real) === ext && !executable ? "open" : "reveal";
}

export function languageFor(path) {
  const ext = extension(path);
  return LANG[ext] ?? (ext || "txt");
}

// FNV-1a, enough to give each (machine, path) its own draft file.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

export function draftName(on, path) {
  const safe = baseName(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "file";
  return `${safe}-${hash(`${on ?? ""}|${path}`)}.txt`;
}

export function tabLabel(path, dirty) {
  return `${dirty ? "● " : ""}${baseName(path)}`;
}
