// PDF pages, text documents and diagrams for editor tabs, and opening a file in its default app.
// This computer only: the tools (PDFKit and WebKit through swiftc, textutil) are macOS's.
import * as fs from "fs/promises";
import { exec, appHome } from "herdr";
import { PDF_RENDERER, DIAGRAM_RENDERER, diagramArgs, plantumlArgs, zipListArgs, PICTURE_COPY, rendererName, swiftCheckArgs, compileArgs, installArgs, renderArgs, textArgs, documentArgs, osNameArgs, defaultAppArgs } from "./scripts.js";
import { documentHtml, renderedPages, documentFailed, plantumlFailure, plantumlSource, parsePdfText, textComplete, parseZipListing, pictureEntries, PICTURE_LIMITS } from "./documents.js";
import { ensureFolder, TOOLS, CACHE } from "./storage.js";
import { MOD } from "./open.js";

export const PAGE_WIDTH = 1200;
// A first compile with an empty module cache took 29 s on a fast Mac, so the build gets its own
// exec timeout (Herdr 0.1.14; older versions ignore it and stop at 30 s).
const BUILD_LIMIT_MS = 4 * 60 * 1000;

const failure = (r) => (r.stderr || r.stdout || `exit code ${r.code}`).trim();

const RENDER_ERRORS = {
  2: "This file could not be read as a PDF.",
  3: "A page of this PDF could not be drawn.",
  4: "This PDF is locked with a password.",
};

export const pdfRenderer = () => tool(PDF_RENDERER, "render", "The PDF viewer");
export const diagramRenderer = () => tool(DIAGRAM_RENDERER, "diagram", "The diagram viewer");

// A compiled tool's path, built by the tab that needs it. Not shared between tabs (since Herdr
// 0.1.14 a mod's top level is): an exec's result belongs to the tab that started it, and closing
// that tab mid-build left every tab waiting on the shared promise for ever. Two tabs may build at
// once; every build uses its own file names, and only the final mv is shared.
async function tool(code, prefix, what) {
  const folder = await ensureFolder(TOOLS), name = rendererName(code, undefined, prefix), bin = `${folder}/${name}`;
  await dropStaleBuilds(folder, name);
  if (await fs.exists(bin)) return bin;
  const [check, checkArgs] = swiftCheckArgs();
  const tools = await exec(check, checkArgs).catch(() => null);
  if (tools?.code !== 0) throw new Error(`${what} works on macOS with the Xcode command line tools (xcode-select --install).`);
  const own = `${bin}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const source = `${own}.swift`, partial = `${own}.partial`;
  await fs.writeFile(source, code);
  try {
    const [cc, args] = compileArgs(source, partial);
    const r = await exec(cc, args, { timeout: BUILD_LIMIT_MS });
    if (r.code !== 0) throw new Error(`${what} could not be built: ${failure(r)}`);
    // Moved into place, so a tab never runs a half-written binary.
    const [mv, mvArgs] = installArgs(partial, bin);
    const moved = await exec(mv, mvArgs);
    if (moved.code !== 0) throw new Error(`${what} could not be installed: ${failure(moved)}`);
  } finally {
    await fs.unlink(source).catch(() => null);
    await fs.unlink(partial).catch(() => null);
  }
  // This tool built from an older source is no longer used; builds of this one (another window's) are left alone.
  for (const old of await fs.readdir(folder)) {
    if (old.startsWith(`${prefix}-`) && !old.startsWith(name)) await fs.unlink(`${folder}/${old}`).catch(e => console.log(`vsc: could not remove ${old}: ${e?.message ?? e}`));
  }
  return bin;
}

// Builds left when their tab or the app closed during the build: their names carry their start time.
async function dropStaleBuilds(folder, name) {
  for (const file of await fs.readdir(folder)) {
    const started = new RegExp(`^${name}\\.(\\d+)-`).exec(file);
    if (started && Date.now() - Number(started[1]) > BUILD_LIMIT_MS + 60 * 1000) {
      await fs.unlink(`${folder}/${file}`).catch(e => console.log(`vsc: could not remove ${file}: ${e?.message ?? e}`));
    }
  }
}

// A renderer that does not start at all (damaged, wrong architecture). Without arguments a working
// one exits 1 at once, so a slow page is never mistaken for a broken binary.
async function startsUp(bin) {
  const r = await exec(bin, []).catch(() => null);
  return r !== null && r.code !== 126 && r.code !== 127;
}

// Draws pages first..first+count-1 to "<prefix><page>.png"; returns the PDF's page count.
// A renderer that does not start is built again once.
export async function renderPdf(pdf, prefix, first, count) {
  const bin = await pdfRenderer();
  const [cmd, args] = renderArgs(bin, pdf, prefix, first, count, PAGE_WIDTH);
  let r = await exec(cmd, args).catch(e => e);
  if ((r instanceof Error || r.code === 126 || r.code === 127) && !(await startsUp(bin))) {
    await fs.unlink(bin).catch(() => null);
    const [again, againArgs] = renderArgs(await pdfRenderer(), pdf, prefix, first, count, PAGE_WIDTH);
    r = await exec(again, againArgs);
  }
  if (r instanceof Error) throw new Error(`This PDF could not be shown: ${r.message}`);
  const pages = r.code === 0 ? renderedPages(r.stdout) : null;
  if (pages === null) throw new Error(RENDER_ERRORS[r.code] ?? `This PDF could not be shown: ${failure(r)}`);
  return pages;
}

// The text of pages first..first+count-1: { total, pages, recognized }. Reading a scanned page's
// picture takes about a second, so a read gets the build's timeout rather than exec's 30 s.
export async function pdfText(pdf, first, count) {
  const [cmd, args] = textArgs(await pdfRenderer(), pdf, first, count);
  const r = await exec(cmd, args, { timeout: BUILD_LIMIT_MS });
  const text = r.code === 0 ? parsePdfText(r.stdout) : null;
  if (text === null) throw new Error(RENDER_ERRORS[r.code] ?? `The text of this PDF could not be read: ${failure(r)}`);
  // Output cut short (exec keeps at most 8 MiB) would shift every later page's number.
  if (!textComplete(text, first, count)) throw new Error("The text of these pages was cut short; it is not shown.");
  return text;
}

// The JS library each diagram kind is drawn with, shipped in the mod's vendor folder.
const LIBRARIES = { mermaid: "mermaid/mermaid.min.js", drawio: "drawio/viewer-static.min.js", excalidraw: "excalidraw/excalidraw-utils.js" };
const DIAGRAM_LIMIT_MS = 40 * 1000;

// Draws `source` (a diagram of `kind`; `page` of a draw.io file) to the picture `out`. Errors in
// the diagram come back as the library's message.
export async function renderDiagram(kind, source, out, theme, page = 0) {
  if (kind === "plantuml") return renderPlantuml(source, out);
  const library = `${appHome()}/mods/${MOD}/vendor/${LIBRARIES[kind]}`;
  if (!(await fs.exists(library))) throw new Error(`The ${kind} library is missing from the mod (${library}).`);
  const input = `${out}.src`;
  await fs.writeFile(input, source);
  try {
    const [cmd, args] = diagramArgs(await diagramRenderer(), kind, library, input, out, theme, page);
    const r = await exec(cmd, args, { timeout: DIAGRAM_LIMIT_MS });
    if (r.code === 2) throw Object.assign(new Error(`This diagram has an error:\n${r.stderr.trim()}`), { inDiagram: true });
    if (r.code !== 0) throw new Error(`The diagram could not be drawn: ${failure(r)}`);
  } finally {
    await fs.unlink(input).catch(() => null);
  }
}

// A PlantUML diagram, drawn by the plantuml installed here (in PlantUML's own colors: older
// versions have no dark mode). Stopped by its own script before exec's limit.
const PLANTUML_LIMIT_S = 30;
async function renderPlantuml(text, out) {
  const source = plantumlSource(text);
  if (source === null) throw Object.assign(new Error("This diagram is empty."), { inDiagram: true });
  const input = `${out}.src`;
  await fs.writeFile(input, source);
  try {
    const [cmd, args] = plantumlArgs(input, out, PLANTUML_LIMIT_S);
    const r = await exec(cmd, args, { timeout: DIAGRAM_LIMIT_MS });
    const said = plantumlFailure(r.stderr, source);
    if (r.code === 5) throw new Error("PlantUML diagrams are drawn by PlantUML installed on this computer (brew install plantuml, which brings Java). The diagram is never sent to a PlantUML server.");
    if (r.code === 2) throw Object.assign(new Error(`This diagram has an error:\n${said || "PlantUML could not read it."}`), { inDiagram: true });
    if (r.code === 4) throw new Error(`Drawing the diagram took over ${PLANTUML_LIMIT_S} s.`);
    if (r.code !== 0) throw new Error(`PlantUML could not draw this diagram: ${said || `exit code ${r.code}`}`);
  } finally {
    await fs.unlink(input).catch(() => null);
  }
}

// The pictures inside a Word (.docx) or OpenDocument (.odt) file, copied into the image cache as
// "<prefix>-pic-<n>.<ext>" (the app shows pictures only from its own folder): [{ path, name }],
// in document order. Each copy is capped at PICTURE_LIMITS.each + 1 bytes and counted by what was
// really written; one over the cap is dropped, and copying stops at the total. Other formats, or a
// file that is not a zip archive, have none.
export async function documentPictures(file, prefix) {
  const format = String(file).split(".").pop().toLowerCase();
  if (format !== "docx" && format !== "odt") return [];
  const [list, listArgs] = zipListArgs(file);
  const listed = await exec(list, listArgs);
  if (listed.code !== 0) return [];
  const entries = pictureEntries(parseZipListing(listed.stdout), format);
  if (!entries.length) return [];
  const cache = await ensureFolder(CACHE), pictures = [];
  let total = 0;
  for (const [i, entry] of entries.entries()) {
    const name = entry.name.split("/").pop(), copy = `${prefix}-pic-${i + 1}.${name.split(".").pop().toLowerCase()}`;
    const r = await exec("sh", ["-c", PICTURE_COPY, "vsc", file, entry.name, String(PICTURE_LIMITS.each + 1), `${cache}/${copy}`]);
    const size = r.code === 0 ? Number(r.stdout.trim()) : NaN;
    if (!Number.isFinite(size) || size === 0 || size > PICTURE_LIMITS.each || total + size > PICTURE_LIMITS.total) {
      await fs.unlink(`${cache}/${copy}`).catch(() => null);
      if (Number.isFinite(size) && total + size > PICTURE_LIMITS.total) break;
      continue;
    }
    total += size;
    pictures.push({ path: `${CACHE}/${copy}`, name });
  }
  return pictures;
}

async function isMac() {
  const [cmd, args] = osNameArgs();
  const os = await exec(cmd, args).catch(() => null);
  return os?.stdout.trim() === "Darwin";
}

// A Word, RTF or OpenDocument file as HTML for TextView.
export async function readDocument(path) {
  if (!(await isMac())) throw new Error("Documents are shown on macOS only (textutil).");
  const [cmd, args] = documentArgs(path);
  let r = await exec(cmd, args);
  // Word often saves RTF under .doc. RTF loads nothing from outside, so the retry is safe.
  if (documentFailed(r) && /\.doc$/i.test(path)) {
    const [rtf, rtfArgs] = documentArgs(path, "rtf");
    r = await exec(rtf, rtfArgs);
  }
  if (documentFailed(r)) throw new Error(`This document could not be read: ${failure(r)}`);
  return documentHtml(r.stdout);
}

export async function openInDefaultApp(path) {
  const [cmd, args] = defaultAppArgs(await isMac(), path);
  const r = await exec(cmd, args).catch(() => null);
  if (r?.code !== 0) throw new Error(r ? `No app opened this file: ${failure(r)}` : `${cmd} is not available here.`);
}
