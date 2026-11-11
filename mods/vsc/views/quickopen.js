// Quick Open (cmd-p): type part of a file's name or path, Enter opens it. A dialog over the window,
// listing the same files as Search (the terminal's folder, without what .gitignore excludes).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props as blockProps, closeOverlay, shared } from "herdr";
import { icon } from "../lib/ui.js";
import { listFiles } from "../lib/listing.js";
import { rankFiles } from "../lib/search.js";
import { fileIcon } from "../lib/icons.js";
import { openFile, RECENT, fileKey } from "../lib/open.js";
import { displayName } from "../lib/scm.js";

const SHOWN = 12, CHUNK = 1000;

export default class QuickOpen extends View {
  init(_props, cx) {
    const p = blockProps();
    this.overlay = p?.overlay; this.cwd = p?.cwd ?? null; this.on = p?.on ?? null;
    this.files = []; this.rows = []; this.at = 0; this.filter = ""; this.loading = true; this.gen = 0;
    this.input = InputState.new({ placeholder: "Search files by name" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; this.rank(cx); });
    this.input.on("submit", (_e, cx) => this.open(this.rows[this.at], cx));
    this.input.focus();
    // The dialog may take the keyboard a moment after it opens (as Herdr's picker does).
    cx.timer.after(600, () => this.input.focus());
    if (!this.cwd) { this.loading = false; return; }
    cx.spawn(async (cx) => {
      try { const list = await listFiles(this.cwd, this.on); this.root = list.root; this.files = list.files; this.truncated = list.truncated; this.rank(cx); }
      catch (e) { this.error = displayName(String(e?.message ?? e)); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Ranks outside render, a chunk at a time with a pause between, so a slow pass never holds a frame;
  // a newer keystroke makes an older pass stop. The best of each chunk's best are the best overall.
  // Recently opened files of this folder come first when nothing is typed.
  rank(cx) {
    const gen = ++this.gen, filter = this.filter, files = this.files, prefix = fileKey(this.on, `${this.root}/`);
    const recent = (shared(RECENT) ?? []).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
    if (!filter) { this.rows = rankFiles("", files, recent, SHOWN); cx.notify(); return; }
    cx.spawn(async (cx) => {
      let best = [];
      for (let i = 0; i < files.length; i += CHUNK) {
        best = rankFiles(filter, [...best, ...rankFiles(filter, files.slice(i, i + CHUNK), [], SHOWN)], [], SHOWN);
        await cx.sleep(0);
        if (gen !== this.gen) return;
      }
      this.rows = best;
      cx.notify();
    });
  }

  // The tab opens first; the dialog closes once its id is known.
  open(rel, cx) {
    if (!rel || this.opening) return;
    this.opening = true;
    cx.spawn(async (cx) => {
      try { await openFile(`${this.root}/${rel}`, this.on, cx); }
      catch (e) { console.log(`vsc: could not open ${rel}: ${e?.message ?? e}`); }
      finally { closeOverlay(this.overlay); }
    });
  }

  render() {
    const t = theme(), rows = this.rows;
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const message = !this.cwd ? "No folder" : this.loading ? "Loading files…" : this.error ?? (rows.length ? null : "No matching files");
    return v_flex().id("vsc-quickopen").size_full().p(14).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "down" && rows.length) this.at = (this.at + 1) % rows.length;
        else if (e.key === "up" && rows.length) this.at = (this.at + rows.length - 1) % rows.length;
        else if (e.key === "escape") { closeOverlay(this.overlay); return; }
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(icon("search").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(message), el => el.child(div().px(8).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(message)))
      .child(v_flex().flex_1().min_h(0).overflow_hidden().gap(2).children(rows.map((rel, i) => {
        const slash = rel.lastIndexOf("/"), name = rel.slice(slash + 1), dir = slash > 0 ? rel.slice(0, slash) : "";
        const kind = fileIcon(name), selected = i === this.at;
        return h_flex().id(`vsc-qo-${rel}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
          .when(selected, el => el.bg(t.selected)).hover(s => s.bg(selected ? t.selected : t.hover))
          .on_click((_e, cx) => this.open(rel, cx))
          .child(icon(kind.icon).size(14).flex_none().text_color(t[kind.color] ?? t.muted))
          .child(div().flex_none().max_w(260).truncate().text_color(t.foreground).child(displayName(name)))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(displayName(dir)));
      })))
      .when(Boolean(this.truncated), el => el.child(div().flex_none().px(8).text_size(11).text_color(t.dim).child("Only the first 10,000 files are listed.")));
  }
}
