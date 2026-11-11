// Editor tab: code with syntax colors, markdown with Preview/Edit, images, PDF pages, documents
// (read-only), and safe saving.
// Saving passes the text the edit was based on, so a file changed elsewhere is never overwritten silently.
// Unsaved text is kept as a draft (with that base) under the app's folder, because the app cannot
// stop a tab from closing. Secret files (.env, keys) never get a draft.
import { View, div, image, list } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar } from "gpui-base";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { exec, readTextFile, watchFolder, home, theme, settings, run, props as blockProps, nextCommand } from "herdr";
import { classify, sizeLimit, externalAction, languageFor, draftName, tabLabel, baseName, EDIT_LIMIT, READ_LIMIT } from "../lib/files.js";
import { makeDraft, parseDraft, looksLikeDraft, restoreDecision, saveFailure, isSecretFile, isPrivateMode, joinPath, lineEnding, toLineEnding, sameText, looksMisdecoded } from "../lib/editing.js";
import { claimTab, openFile, openDiagram, markUnsaved, markSaved } from "../lib/open.js";
import { lineDiff } from "../lib/diff.js";
import { holdImages } from "../lib/markdown.js";
import { pdfTextHtml, textReadAction } from "../lib/documents.js";
import { folderPath, ensureFolder, DRAFTS, CACHE } from "../lib/storage.js";
import { diffView, diagramView } from "../lib/ui.js";
import { diagramKind, mermaidBlocks, drawioPages } from "../lib/diagrams.js";
import { DiagramPicture, themeOf } from "../lib/drawing.js";
import { writeFile } from "../lib/remote.js";
import { renderPdf, pdfText, readDocument, documentPictures, openInDefaultApp, PAGE_WIDTH } from "../lib/viewers.js";
import { reveal } from "../lib/fileactions.js";

const DRAFT_DELAY = 800, POLL_MS = 3000, REMOTE_POLL_MS = 5000, REMOTE_IMAGE_LIMIT = 6 * 1000 * 1000, PAGE_STEP = 20;
// A draft base that no file can equal: legacy drafts without a base must not save silently.
const UNKNOWN_BASE = "\u0000unknown base";

const dirOf = (path) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";

// Size of a regular file. Devices, FIFOs and folders (also behind a symlink) are refused before
// anything reads them: a link to /dev/zero would otherwise never end.
async function fileSize(path, on) {
  const r = await exec("sh", ["-c", '[ -f "$1" ] || exit 3; wc -c < "$1"', "vsc", path], { on });
  if (r.code === 3) throw new Error("This is not a regular file, so it is not opened.");
  const size = Number.parseInt(r.stdout.trim(), 10);
  if (r.code !== 0 || !Number.isFinite(size)) throw new Error(r.stderr.trim() || "The file size could not be checked.");
  return size;
}

// Where a symlink really points and its permission bits, to recognize secret files behind other names.
async function realInfo(path, on) {
  // GNU stat first: on Linux `stat -f` means "file system" and would print several lines instead.
  const r = await exec("sh", ["-c", '(readlink -f -- "$1" 2>/dev/null || realpath "$1") ; (stat -L -c %a -- "$1" 2>/dev/null || stat -L -f %Lp -- "$1")', "vsc", path], { on });
  const lines = r.stdout.trim().split("\n");
  return { real: lines[0] || path, mode: lines.length > 1 ? lines.at(-1) : null };
}

async function fingerprint(path, on) {
  const r = await exec("cksum", ["--", path], { on }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim().split(/\s+/).slice(0, 2).join(" ") : "missing";
}

export default class FileEditor extends View {
  init(_props, cx) {
    const p = blockProps() ?? {};
    this.file = p.file; this.on = p.on ?? null;
    this.mode = "loading";   // loading | code | markdown | image | pdf | document | message
    this.kind = null;        // classify(): what the file is, whatever the tab could make of it
    this.readonly = true;
    this.disk = null;        // the text the buffer's edits are based on (writeFile's expected)
    this.conflict = null;    // the file's text when it differs from `disk` while there are edits
    this.missing = false;    // the file is gone; saving recreates it
    this.error = null;       // a save or draft failure that is not a conflict
    this.note = null;        // information, not a problem
    this.diagram = diagramKind(this.file); // drawn as a picture (Diagram) or edited as text (Source)
    this.picture = this.diagram ? new DiagramPicture(this.on, this.file) : null;
    this.diagramPage = 0;    // the shown page of a draw.io file
    this.pdfView = "pages";  // pages | text
    // The text of the shown pages, read while Text is shown: { base, pages, recognized }. It is only
    // shown when it belongs to the current pictures (same base) and has one entry per picture.
    this.pdfText = null;
    this.dirty = false; this.focused = false; this.preview = true; this.comparing = false; this.compareRows = null;
    this.gen = 0;            // bumped by save, reload and overwrite; stale disk reads compare it
    this.saving = false;
    this.secret = isSecretFile(this.file);
    this.draftQueue = Promise.resolve();
    this.draftPath = `${folderPath(DRAFTS)}/${draftName(this.on, this.file)}`;
    this.load(cx);
    this.listen(cx);
    // Another machine's folders cannot be watched from here: its file is compared on a timer.
    if (this.on) this.poll(cx, REMOTE_POLL_MS); else this.watch(cx);
  }

  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand()).split(".").pop();
        if (command === "save" && this.focused) await this.save(cx);
      }
    });
  }

  // Watch the file's folder; for files directly in home or / (huge recursive trees), or when
  // the watch is refused, compare a checksum on a timer instead.
  watch(cx) {
    const dir = dirOf(this.file);
    if (dir === home() || dir === "/") return this.poll(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        let changed;
        try { changed = await watchFolder(dir); } catch { this.poll(cx); return; }
        if (changed.some(p => p === this.file || p === dir)) await this.diskChanged(cx);
      }
    });
  }

  poll(cx, every = POLL_MS) {
    cx.spawn(async (cx) => {
      let last = await fingerprint(this.file, this.on);
      for (;;) {
        await cx.sleep(every);
        const next = await fingerprint(this.file, this.on);
        if (next !== last) { last = next; await this.diskChanged(cx); }
      }
    });
  }

  async diskChanged(cx) {
    const gen = this.gen;
    if (this.mode === "image") { if (gen === this.gen) await this.loadImage().catch(e => { this.error = String(e?.message ?? e); }); cx.notify(); return; }
    if (this.mode === "pdf" || this.mode === "document") {
      if (gen !== this.gen) return;
      try { if (this.mode === "pdf") { await this.loadPdf(this.pages.length); this.syncText(cx); } else await this.loadDocument(); this.error = null; }
      catch (e) { this.error = String(e?.message ?? e); }
      cx.notify(); return;
    }
    if (this.mode === "loading" || this.mode === "message") return;
    if (this.source === "head") { await this.loadReadonly().catch(() => null); cx.notify(); return; }
    const text = await readTextFile(this.file, { on: this.on }).catch(() => null);
    if (gen !== this.gen || this.saving) return; // a save or reload happened meanwhile: this read is stale
    if (text === null) { this.missing = true; cx.notify(); return; }
    this.missing = false;
    if (text === this.disk) { this.conflict = null; cx.notify(); return; }
    if (this.dirty) this.conflict = text;
    else { this.disk = text; this.state?.set_value(text); this.redraw(cx); }
    cx.notify();
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const size = await fileSize(this.file, this.on);
        const { real, mode } = await realInfo(this.file, this.on).catch(() => ({ real: this.file, mode: null }));
        // Secret by name, by where a symlink points, or because only its owner may read it.
        this.secret = this.secret || isSecretFile(real) || isPrivateMode(mode);
        this.fileMode = mode; this.realFile = real;
        const kind = classify(this.file, size);
        this.kind = kind; this.imageSize = size;
        if (kind === "too-large") this.fail(`This file is ${(size / 1e6).toFixed(1)} MB. Files over ${sizeLimit(this.file) / 1e6} MB are not opened.`);
        else if (kind === "binary") this.fail("Binary file · no preview");
        else if ((kind === "pdf" || kind === "document") && this.on) this.fail("PDFs and documents are shown only for files on this computer.");
        else if (kind === "pdf") {
          // The first PDF builds the viewer (about 8 s), so the wait says why.
          this.loadingText = "Preparing pages…"; cx.notify();
          await this.loadPdf(PAGE_STEP);
        }
        else if (kind === "document") await this.loadDocument();
        else if (kind === "image") await this.loadImage(size);
        else if (kind === "readonly") await this.loadReadonly();
        else { await this.loadText(kind); this.redraw(cx); }
      } catch (e) { this.fail(String(e?.message ?? e)); }
      finally { cx.notify(); }
    });
  }

  fail(message) { this.mode = "message"; this.message = message; }

  // A new stamp for every load: the image loader caches by path, and a tab reopened on the same
  // file must not reuse (or have the closed tab's cleanup delete) the old tab's names.
  nextStamp() {
    this.imageStamp = Math.max((this.imageStamp ?? 0) + 1, Date.now());
    return this.imageStamp;
  }

  // Page pictures go to the image cache under this tab's prefix (dropped with the tab, as images are).
  // Drawn PAGE_STEP at a time, so one exec never draws more than that (scanned pages are slow).
  async loadPdf(count) {
    const base = `${draftName(this.on, this.file).replace(/\.txt$/, "")}-${this.nextStamp()}-p`;
    const folder = await ensureFolder(CACHE);
    const wanted = Math.max(count, PAGE_STEP);
    let total = await renderPdf(this.file, `${folder}/${base}`, 1, PAGE_STEP);
    for (let first = PAGE_STEP + 1; first <= Math.min(total, wanted); first += PAGE_STEP) {
      total = await renderPdf(this.file, `${folder}/${base}`, first, PAGE_STEP);
    }
    const previous = this.pages ?? [];
    this.pageBase = base; this.pageCount = total;
    this.pages = Array.from({ length: Math.min(total, wanted) }, (_, i) => `${CACHE}/${base}${i + 1}.png`);
    this.mode = "pdf";
    await this.dropPages(previous);
  }

  async dropPages(pages) {
    for (const page of pages) await fs.unlink(`${folderPath("")}${page}`).catch(() => null);
  }

  morePages(cx) {
    if (this.addingPages) return;
    this.addingPages = true;
    cx.spawn(async (cx) => {
      const first = this.pages.length + 1, base = this.pageBase;
      try {
        await renderPdf(this.file, `${folderPath(CACHE)}/${base}`, first, PAGE_STEP);
        const last = Math.min(this.pageCount, first + PAGE_STEP - 1);
        const drawn = Array.from({ length: Math.max(last - first + 1, 0) }, (_, i) => `${CACHE}/${base}${first + i}.png`);
        // A reload meanwhile drew new pages under another name: these would mix two versions.
        if (base === this.pageBase) this.pages.push(...drawn);
        else await this.dropPages(drawn);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally { this.addingPages = false; cx.notify(); }
      this.syncText(cx);
    });
  }

  // Draws the diagram from the text as it is now (saved or not), while Diagram is shown.
  redraw(cx, { retry = false } = {}) {
    if (!this.diagram || this.mode !== "code" || !this.preview || !this.state) return;
    cx.spawn(async (cx) => {
      await this.picture.draw(this.diagram, this.state.value(), themeOf(theme().background), this.shownPage(), { retry });
      cx.notify();
    });
  }

  // A draw.io file's page names, found again only when the text changed; one name for other kinds.
  diagramPages() {
    if (this.diagram !== "drawio") return [];
    const source = this.state.value();
    if (this.pagesCache?.source !== source) this.pagesCache = { source, pages: drawioPages(source) };
    return this.pagesCache.pages;
  }

  // The page to draw: the chosen one, or the last when pages were removed.
  shownPage() {
    return Math.min(this.diagramPage, Math.max(this.diagramPages().length - 1, 0));
  }

  // Page buttons above a draw.io file with several pages.
  diagramPageBar(t) {
    const pages = this.diagramPages();
    if (pages.length < 2) return null;
    return h_flex().flex_none().flex_wrap().px(12).py(6).gap(2).items_center().border_b(1).border_color(t.border).bg(t.raised)
      .children(pages.map((name, i) => this.segment(`vsc-diagram-page-${i}`, name, i === this.shownPage(), cx => { this.diagramPage = i; this.redraw(cx, { retry: true }); }, t)));
  }

  // The Mermaid blocks of a Markdown preview, found again only when the text changed.
  diagramBlocks() {
    const source = this.state.value();
    if (this.blocksCache?.source !== source) this.blocksCache = { source, blocks: mermaidBlocks(source) };
    return this.blocksCache.blocks;
  }

  // Under the toolbar of a Markdown preview with Mermaid blocks: each opens in a tab or to the side.
  diagramBar(t) {
    if (this.mode !== "markdown" || !this.preview || this.comparing) return null;
    const blocks = this.diagramBlocks();
    if (!blocks.length) return null;
    return h_flex().flex_none().flex_wrap().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(12)
      .child(div().text_color(t.muted).child("Diagrams:"))
      .children(blocks.map(b => h_flex().gap(2)
        .child(this.button(`vsc-diagram-open-${b.index}`, `Diagram ${b.index}`, cx => { cx.spawn(async (cx) => openDiagram(this.file, b.index, this.on, cx)); }, t))
        .child(this.button(`vsc-diagram-side-${b.index}`, "Side", cx => { cx.spawn(async (cx) => openDiagram(this.file, b.index, this.on, cx, { side: true })); }, t))));
  }

  showPdfView(view, cx) {
    this.pdfView = view;
    this.syncText(cx);
  }

  // The text the Text view may show: pages read so far, in order, of the version whose pictures are
  // shown. `complete` when there is one entry per picture.
  shownText() {
    const text = this.pdfText;
    if (!text || text.base !== this.pageBase || text.pages.length > this.pages.length) return null;
    return { ...text, complete: text.pages.length === this.pages.length };
  }

  // Reads the text of pictures that have none yet, PAGE_STEP at a time, while Text is shown. Every
  // chunk is added only if nothing changed meanwhile (a reload, a Show more); otherwise the loop
  // starts over from what is still valid, so a page's text can never sit under another page's number.
  syncText(cx) {
    if (this.pdfView !== "text" || this.mode !== "pdf" || this.readingText) return;
    this.readingText = true; this.textWaiting = false;
    cx.spawn(async (cx) => {
      try {
        while (this.pdfView === "text" && !this.shownText()?.complete) {
          if (this.pdfText?.base !== this.pageBase) this.pdfText = { base: this.pageBase, pages: [], recognized: [] };
          const text = this.pdfText, first = text.pages.length + 1;
          const read = await pdfText(this.file, first, Math.min(PAGE_STEP, this.pages.length - first + 1));
          const current = this.pdfText === text && text.base === this.pageBase && text.pages.length === first - 1;
          const action = textReadAction(read, current, this.pages.length);
          // The file shrank under the shown pictures: stop here and stay in Text; the reload that
          // follows the change calls syncText for the new version.
          if (action === "stall") { this.textWaiting = true; this.error = "This PDF changed on disk; its text is read again once the new pages are shown."; break; }
          if (action === "append") { text.pages.push(...read.pages); text.recognized.push(...read.recognized); }
          cx.notify();
        }
      } catch (e) { this.error = String(e?.message ?? e); this.pdfView = "pages"; }
      finally { this.readingText = false; cx.notify(); }
    });
  }

  async loadDocument() {
    this.documentHtml = await readDocument(this.file);
    this.mode = "document";
    // Pictures come from the file itself (docx, odt); a new name per load, as for images.
    const previous = this.docPictures ?? [];
    const prefix = `${draftName(this.on, this.file).replace(/\.txt$/, "")}-${this.nextStamp()}`;
    this.docPictures = await documentPictures(this.file, prefix).catch(e => { console.log(`vsc: ${e?.message ?? e}`); return []; });
    this.note = this.docPictures.length
      ? "Read-only preview: layout and styles are not shown; the document's pictures are listed below its text."
      : "Read-only preview: layout, styles and pictures of the document are not shown.";
    for (const picture of previous) await fs.unlink(`${folderPath("")}${picture.path}`).catch(() => null);
  }

  // The document's pictures as thumbnails; each opens in its own tab.
  documentPicturesView(t) {
    const pictures = this.docPictures ?? [];
    if (!pictures.length) return null;
    return v_flex().gap(8).pt(20).mt(20).border_t(1).border_color(t.border)
      .child(div().text_size(12).text_color(t.muted).child(`Pictures (${pictures.length})`))
      .child(h_flex().flex_wrap().gap(10).children(pictures.map((picture, i) =>
        v_flex().id(`vsc-doc-picture-${i}`).w(180).gap(4).p(6).rounded(6).border_1().border_color(t.border).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { cx.spawn(async (cx) => openFile(`${folderPath("")}${picture.path}`, null, cx, { label: `${baseName(this.file)} · ${picture.name}`, recent: false })); })
          .child(div().h(130).flex().items_center().justify_center().child(image(picture.path).max_w_full().max_h_full()))
          .child(div().text_size(11).text_color(t.dim).truncate().child(picture.name)))));
  }

  openDefault(cx) {
    cx.spawn(async (cx) => {
      try {
        // Checked again at the click: a pull or checkout can have made the file a symlink since it loaded.
        const { real, mode } = await realInfo(this.file, null);
        this.fileMode = mode; this.realFile = real;
        if (externalAction(this.kind, this.file, mode, real) === "open") await openInDefaultApp(real);
        else await reveal(this.file);
      }
      catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  // image() only reads from the app's own folder, so the picture is copied into a cache there.
  async loadImage(size) {
    const ext = baseName(this.file).split(".").pop().toLowerCase();
    // A new name for every load: the image loader caches by path, so a changed picture needs a new one.
    const name = `${draftName(this.on, this.file).replace(/\.txt$/, "")}-${this.nextStamp()}.${ext}`;
    const folder = await ensureFolder(CACHE);
    if (this.on) {
      // Files on another machine come back as base64 text (exec returns text, at most 8 MiB),
      // which is a third larger than the image.
      if ((size ?? this.imageSize ?? 0) > REMOTE_IMAGE_LIMIT) throw new Error(`Images over ${REMOTE_IMAGE_LIMIT / 1e6} MB on another machine are not shown.`);
      const r = await exec("sh", ["-c", 'base64 < "$1"', "vsc", this.file], { on: this.on });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this image");
      await fs.writeFile(`${folder}/${name}`, new Uint8Array(Buffer.from(r.stdout.replace(/\s+/g, ""), "base64")));
    } else {
      // head -c: never more than the read limit, whatever the file turns out to be.
      const r = await exec("sh", ["-c", 'head -c "$3" -- "$1" > "$2"', "vsc", this.file, `${folder}/${name}`, String(READ_LIMIT)]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this image");
    }
    const previous = this.image;
    this.image = `${CACHE}/${name}`; this.mode = "image";
    if (previous) await fs.unlink(`${folderPath("")}${previous}`).catch(() => null);
  }

  async loadReadonly() {
    const r = await exec("head", ["-c", String(READ_LIMIT), "--", this.file], { on: this.on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this file");
    if (r.stdout.includes("\0")) { this.kind = "binary"; return this.fail("Binary file · no preview"); }
    this.source = "head";
    if (this.state) this.state.set_value(r.stdout);
    else this.makeEditor(r.stdout, true, "code");
    this.mode = "code";
    this.note = `Read-only: files over ${EDIT_LIMIT / 1024 / 1024} MB can be viewed but not edited.`;
  }

  async loadText(kind) {
    const text = await readTextFile(this.file, { on: this.on });
    if (text === null) return this.fail("This file is no longer available");
    if (text.includes("\0")) { this.kind = "binary"; return this.fail("Binary file · no preview"); }
    const misdecoded = looksMisdecoded(text);
    const readonly = misdecoded;
    this.ending = lineEnding(text);
    const raw = readonly || this.secret ? null : await fs.readFile(this.draftPath, "utf8").catch(() => null);
    const draft = parseDraft(raw);
    let decision = restoreDecision(text, draft, this.on, this.file);
    // Drafts from before drafts carried their base: treat them as based on an unknown version.
    // A half-written new draft is ignored, never offered as text.
    if (raw !== null && draft === null && !looksLikeDraft(raw) && raw !== text) decision = { state: "conflict", text: raw, base: UNKNOWN_BASE, disk: text };
    this.mode = kind;
    if (decision.state === "clean") {
      this.disk = text;
      this.makeEditor(text, readonly, kind);
      // Only this file's draft: a name collision must not delete another file's draft.
      const ours = draft ? draft.path === this.file && (draft.on ?? null) === this.on : raw !== null && !looksLikeDraft(raw);
      if (ours) this.queueDraft(() => this.dropDraft());
    } else {
      this.disk = decision.base;
      this.makeEditor(decision.text, readonly, kind);
      this.setDirty(true); this.preview = false;
      if (decision.state === "conflict") {
        this.conflict = decision.disk;
        this.note = "Your unsaved changes from last time are based on an older version of this file.";
      } else this.note = "Unsaved changes from last time were restored.";
    }
    if (misdecoded) this.note = "Read-only: this file is not UTF-8 text, and saving it here would damage it.";
  }

  makeEditor(text, readonly, kind) {
    const t = theme();
    this.readonly = readonly;
    this.state = EditorState.new({
      language: languageFor(this.file), value: text, readonly, soft_wrap: kind === "markdown",
      font_family: settings().font_family, font_size: 13,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    this.state.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.state.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.state.on("change", (_e, cx) => {
      this.setDirty(this.missing || (this.disk !== null && !sameText(this.state.value(), this.disk)));
      this.scheduleDraft(cx);
      cx.notify();
    });
  }

  setDirty(dirty) {
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    markUnsaved(this.on, this.file, dirty);
    const tab = claimTab(this.on, this.file);
    if (tab) run("tab.rename", { id: tab, name: tabLabel(this.file, dirty) });
  }

  // Draft writes and deletes run one at a time, in order, so a slow write can never
  // recreate a draft after a save dropped it.
  queueDraft(job) {
    this.draftQueue = this.draftQueue.then(job).catch(e => { this.error = `Could not keep unsaved changes: ${e?.message ?? e}`; });
    return this.draftQueue;
  }

  scheduleDraft(cx) {
    if (this.readonly || this.secret) return;
    const stamp = this.draftStamp = (this.draftStamp ?? 0) + 1;
    cx.spawn(async (cx) => {
      await cx.sleep(DRAFT_DELAY);
      if (stamp !== this.draftStamp) return;
      await this.queueDraft(async () => {
        if (stamp !== this.draftStamp) return;
        if (this.dirty) await this.writeDraft(); else await this.dropDraft();
      });
      cx.notify();
    });
  }

  async writeDraft() {
    if (this.secret || this.readonly) return this.dropDraft();
    await ensureFolder(DRAFTS);
    await fs.writeFile(this.draftPath, makeDraft(this.on, this.file, this.disk ?? "", this.state.value()));
  }

  async dropDraft() {
    if (await fs.exists(this.draftPath)) await fs.unlink(this.draftPath);
  }

  async save(cx) {
    if (!this.state || this.readonly || this.saving || (!this.dirty && !this.missing)) return;
    this.saving = true; this.gen++;
    // Written with the file's own line endings, whatever the editor shows.
    const text = toLineEnding(this.state.value(), this.ending ?? "\n");
    try {
      await writeFile(this.file, text, this.missing ? null : this.disk, this.on);
      this.disk = text; this.conflict = null; this.missing = false; this.error = null; this.note = null; this.comparing = false;
      this.setDirty(false);
      markSaved(this.on, this.file);
    } catch (e) {
      const reread = await readTextFile(this.file, { on: this.on }).catch(() => null);
      const kind = saveFailure(this.disk, reread);
      this.missing = kind === "missing";
      if (kind === "conflict") this.conflict = reread;
      else this.error = String(e?.message ?? e).replace(/^`herdr\.writeTextFile`: /, "");
    } finally { this.saving = false; }
    this.draftStamp = (this.draftStamp ?? 0) + 1;
    await this.queueDraft(() => (this.dirty ? this.writeDraft() : this.dropDraft()));
    cx.notify();
  }

  // Conflict choices: take the disk version, or write mine over it.
  async reload(cx) {
    this.gen++;
    const text = await readTextFile(this.file, { on: this.on }).catch(() => null);
    if (text === null) { this.missing = true; cx.notify(); return; }
    this.disk = text; this.conflict = null; this.note = null; this.error = null; this.comparing = false;
    this.state.set_value(text); this.setDirty(false);
    this.draftStamp = (this.draftStamp ?? 0) + 1;
    await this.queueDraft(() => this.dropDraft());
    cx.notify();
  }

  async overwrite(cx) {
    this.gen++;
    this.disk = this.conflict ?? this.disk; this.conflict = null; this.comparing = false;
    await this.save(cx);
  }

  toggleCompare(cx) {
    this.comparing = !this.comparing;
    this.compareRows = this.comparing && this.conflict !== null ? lineDiff(this.conflict, this.state.value()) : null;
    cx.notify();
  }

  openLink(url, cx) {
    // The app opens only absolute http(s) URLs with a host, without starting a program.
    if (/^https?:\/\//i.test(url)) { cx.open_url(url); return; }
    const target = url.split("#")[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return;
    // In its own task, so the open has a cx of its own after this click handler returns.
    cx.spawn(async (cx) => openFile(joinPath(dirOf(this.file), target), this.on, cx));
  }

  button(id, label, onClick, t, { primary = false, enabled = true } = {}) {
    return div().id(id).h(26).px(10).flex().items_center().rounded(6).text_size(12)
      .bg(enabled && primary ? t.solid : t.raised).text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(enabled, el => el.cursor_pointer().hover(s => s.bg(primary ? t.solid : t.hover))
        // Redraws after every click, so a handler that only changes state cannot leave the screen stale.
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); }))
      .child(label);
  }

  segment(id, label, on, pick, t) {
    return div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(12).cursor_pointer()
      .bg(on ? t.background : t.raised).text_color(on ? t.foreground : t.muted)
      .on_click((_e, cx) => { pick(cx); cx.notify(); }).child(label);
  }

  toolbar(t) {
    const parts = this.file.split("/"), name = parts.pop();
    const canSave = !this.readonly && (this.dirty || this.missing) && !this.saving;
    const external = this.on ? null : externalAction(this.kind, this.file, this.fileMode, this.realFile);
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.background)
      .child(h_flex().flex_1().min_w(0).gap(4).items_center().text_size(12)
        .child(div().min_w(0).truncate().text_color(t.dim).child(parts.join("/") + "/"))
        .child(div().flex_none().text_color(t.foreground).child(name)))
      .when(this.mode === "pdf", el => el.child(h_flex().gap(2).p(2).rounded(7).bg(t.raised)
        .child(this.segment("vsc-pdf-pages-view", "Pages", this.pdfView === "pages", cx => this.showPdfView("pages", cx), t))
        .child(this.segment("vsc-pdf-text-view", "Text", this.pdfView === "text", cx => this.showPdfView("text", cx), t))))
      .when(Boolean(this.diagram) && this.mode === "code" && !this.comparing, el => el.child(h_flex().gap(2).p(2).rounded(7).bg(t.raised)
        .child(this.segment("vsc-diagram-picture", "Diagram", this.preview, cx => { this.preview = true; this.redraw(cx, { retry: true }); }, t))
        .child(this.segment("vsc-diagram-source", "Source", !this.preview, () => { this.preview = false; }, t))))
      .when(this.mode === "markdown" && !this.comparing, el => el.child(h_flex().gap(2).p(2).rounded(7).bg(t.raised)
        .child(this.segment("vsc-md-preview", "Preview", this.preview, () => { this.preview = true; }, t))
        .child(this.segment("vsc-md-edit", "Edit", !this.preview, () => { this.preview = false; }, t))))
      .when(Boolean(external), el =>
        el.child(this.button("vsc-open-default", external === "open" ? "Open in default app" : "Reveal in Finder", cx => this.openDefault(cx), t)))
      .when(!this.readonly && (this.mode === "code" || this.mode === "markdown"), el =>
        el.child(this.button("vsc-save", this.saving ? "Saving…" : "Save", cx => this.save(cx), t, { primary: true, enabled: canSave })));
  }

  // One line under the toolbar: a conflict, a missing file, an error, or a note, in that order.
  banner(t) {
    const line = (text, color) => div().flex_1().min_w(0).text_size(12).text_color(color).child(text);
    const bar = () => h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised);
    if (this.conflict !== null && this.dirty) return bar()
      .child(line(this.note ?? "This file changed on disk while you were editing.", t.ansi1))
      .child(this.button("vsc-compare", this.comparing ? "Back to editing" : "Compare", cx => this.toggleCompare(cx), t))
      .child(this.button("vsc-reload", "Use disk version", cx => this.reload(cx), t, { enabled: !this.saving }))
      .child(this.button("vsc-overwrite", "Keep mine", cx => this.overwrite(cx), t, { enabled: !this.saving }));
    if (this.missing) return bar()
      .child(line("This file was deleted or moved on disk. Your text is still here.", t.ansi1))
      .when(!this.readonly, el => el.child(this.button("vsc-recreate", "Recreate file", cx => this.save(cx), t)));
    if (this.error) return bar().child(line(this.error, t.ansi1))
      .child(this.button("vsc-dismiss", "Dismiss", () => { this.error = null; }, t));
    const secretNote = this.secret && this.dirty ? "Unsaved changes in secret files are not kept if this tab closes." : null;
    const info = this.note ?? secretNote;
    const blocked = this.mode === "markdown" && this.preview && !this.imagesLoaded && !info ? (this.previewText(), this.previewCache?.blocked ?? 0) : 0;
    if (blocked) return bar().child(line(`${blocked} image${blocked === 1 ? " is" : "s are"} not loaded, so opening this file tells no server about it.`, t.muted))
      .child(this.button("vsc-load-images", "Load images", () => { this.imagesLoaded = true; }, t));
    return info ? bar().child(line(info, t.muted)) : null;
  }

  // Disk version against yours: "-" only on disk, "+" only in yours.
  compare(t) {
    return diffView("vsc-compare", this.compareRows ?? [], ["on disk", "yours"], t);
  }

  // Images stay text until "Load images" (lib/markdown.js); the rewrite is cached per text.
  previewText() {
    const source = this.state.value();
    if (this.imagesLoaded) return source;
    if (this.previewCache?.source !== source) this.previewCache = { source, ...holdImages(source) };
    return this.previewCache.text;
  }

  body(t) {
    if (this.mode === "loading") return div().p(14).text_color(t.dim).child(this.loadingText ?? "Loading file…");
    if (this.mode === "message") return div().p(14).text_color(t.dim).child(this.message);
    if (this.comparing && this.conflict !== null) return this.compare(t);
    if (this.mode === "image") return div().flex_1().min_h(0).p(16).flex().items_center().justify_center()
      .child(image(this.image).max_w_full().max_h_full());
    if (this.mode === "pdf") return this.pdfView === "text" ? this.pdfTextView(t) : this.pdfPages(t);
    if (this.diagram && this.mode === "code" && this.preview) {
      const pages = this.diagramPageBar(t), picture = diagramView("vsc-editor-diagram", this.picture, t);
      return pages ? v_flex().flex_1().min_h(0).child(pages).child(picture) : picture;
    }
    if (this.mode === "document")
      return div().id("vsc-doc-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(28).py(20)
        .child(TextView.html("vsc-doc", this.documentHtml).selectable(true).on_link_click((url, cx) => this.openLink(url, cx)))
        .when(Boolean(this.docPictures?.length), el => el.child(this.documentPicturesView(t)));
    if (this.mode === "markdown" && this.preview)
      return div().id("vsc-md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(28).py(20)
        .child(TextView.markdown("vsc-md", this.previewText()).selectable(true).on_link_click((url, cx) => this.openLink(url, cx)));
    return Editor.new(this.state).flex_1().min_h(0);
  }

  pdfFooter(t) {
    const left = this.pageCount - this.pages.length;
    const footer = left > 0
      ? this.button("vsc-pdf-more", this.addingPages ? "Loading pages…" : `Show ${Math.min(left, PAGE_STEP)} more of ${left} remaining pages`, cx => this.morePages(cx), t, { enabled: !this.addingPages })
      : div().text_size(12).text_color(t.dim).child(`${this.pageCount} page${this.pageCount === 1 ? "" : "s"}`);
    return h_flex().flex_none().justify_center().py(8).border_t(1).border_color(t.border).child(footer);
  }

  // A list draws only the pages on screen: a decoded 1200 px page takes about 7 MB. The footer
  // stays outside it, because a list's rows may not have click handlers.
  pdfPages(t) {
    return v_flex().flex_1().min_h(0).bg(t.raised)
      .child(v_flex().relative().flex_1().min_h(0)
        .child(list("vsc-pdf-pages", this.pages.length, i => this.pages[i], i =>
          div().w_full().px(16).pt(12).flex().justify_center().child(image(this.pages[i]).w_full().max_w(PAGE_WIDTH))).flex_1().min_h(0))
        .child(Scrollbar.vertical("vsc-pdf-pages").absolute().inset_0()))
      .child(this.pdfFooter(t));
  }

  // The loaded pages' text in one view, so a selection can run across pages.
  // Pages already read show at once; the rest follow (scanned pages take about a second each).
  pdfTextView(t) {
    const text = this.shownText(), read = text?.pages.length ?? 0;
    // Built once per text and length: a long PDF's text is hundreds of KB.
    const stale = this.pdfTextCache?.pages !== text?.pages || this.pdfTextCache?.length !== read;
    if (stale) this.pdfTextCache = text ? { pages: text.pages, length: read, html: pdfTextHtml(text.pages, 1, text.recognized) } : null;
    const waiting = text?.complete ? null
      : div().px(28).pb(16).text_color(t.dim).child(this.textWaiting ? "Waiting for the new version of the file…"
        : `Reading pages ${read + 1}–${this.pages.length}… (scanned pages take about a second each)`);
    const body = read === 0 ? div().p(14).text_color(t.dim).child(waiting ?? "No text found in these pages.")
      : text.complete && text.pages.every(page => !page) ? div().p(14).text_color(t.dim).child("No text found in these pages.")
      : div().id("vsc-pdf-text-scroll").flex_1().min_h(0).overflow_y_scrollbar().pt(20)
        .child(div().px(28).pb(12).child(TextView.html("vsc-pdf-text", this.pdfTextCache.html).selectable(true)))
        .when(Boolean(waiting), el => el.child(waiting));
    return v_flex().flex_1().min_h(0).child(body).child(this.pdfFooter(t));
  }

  render() {
    const t = theme(), banner = this.banner(t), diagrams = this.diagramBar(t);
    return v_flex().id("vsc-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .when(Boolean(this.file), el => el.child(this.toolbar(t)))
      .when(Boolean(banner), el => el.child(banner))
      .when(Boolean(diagrams), el => el.child(diagrams))
      .child(this.body(t));
  }
}
