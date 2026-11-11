// Explorer: lazy file tree of the focused pane's folder, with file-type icons and git marks.
// Listing, limits and per-location state are adapted from Herdr's shipped `files` mod (Apache-2.0).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, watchFolder, theme, shared, openOverlay } from "herdr";
import { icon, iconButton, viewCard, hint } from "../lib/ui.js";
import { fileIcon, folderIcon } from "../lib/icons.js";
import { openFile, unsavedFiles, fileKey, MOD } from "../lib/open.js";
import { menuItems, menuHeight } from "../lib/menu-items.js";
import { CLIP, COMPARE, CHANGED } from "../lib/fileactions.js";
import { folderMarks, unsavedFolders } from "../lib/tree.js";
import { gitLetter } from "../lib/editing.js";
import { repoInfo, git } from "../lib/git.js";
import { locationKey, location } from "../lib/location.js";

const PER_FOLDER = 500, TOTAL = 5000;

const key = locationKey;

async function directory(path, on) {
  // The folder is passed as $1, never spliced into the script.
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "vsc", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// { marks, off }: `off` explains why git was not asked (a repository that names its own programs).
async function gitMarks(cwd, on) {
  const { top, off } = await repoInfo(cwd, on);
  if (!top) return { marks: {}, off: null };
  if (off) return { marks: {}, off: `Git marks are off: ${off}` };
  // Writes nothing under .git, so the folder watch does not fire again. Submodules are skipped:
  // their settings are not checked.
  const status = await git(top, on, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=all"]).catch(() => null);
  const marks = {};
  if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL))
    marks[`${top}/${entry.slice(3)}`] = gitLetter(entry.slice(0, 2));
  return { marks, off: null };
}

const markColor = (mark, t) => mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked;

export default class Explorer extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // A file action (new, rename, delete…) lists again at once, also on another machine (no watch there).
    this.lastChange = shared(CHANGED);
    cx.timer.every(500, cx => { if (shared(CHANGED) !== this.lastChange) { this.lastChange = shared(CHANGED); this.refresh(cx); } });
  }

  // The right-click menu at the pointer, for an entry or (rel "") the empty area.
  menu(kind, rel) {
    const target = { kind, rel, root: this.root, on: this.on ?? null, path: rel ? `${this.root}/${rel}` : this.root };
    const items = menuItems(target, { clip: shared(CLIP), pick: shared(COMPARE) });
    openOverlay({ mod: MOD, kind: "popup", width: 240, height: menuHeight(items), props: { view: "menu", target } });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  async loadFolder(path, context) {
    const entries = await directory(path ? `${context.cwd}/${path}` : context.cwd, context.on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, selected: this.selected });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on;
      this.entries = new Map(); this.folders = new Set(saved?.folders); this.selected = saved?.selected ?? null;
      this.pending = new Set(); this.marks = {}; this.marksOff = null; this.folderMarks = new Map(); this.watched = null; this.error = null; this.limited = false; this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true; this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const { marks, off } = await gitMarks(cwd, on);
        if (!this.current(context)) return;
        this.marks = marks; this.marksOff = off; this.folderMarks = folderMarks(marks, cwd); this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder); this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  collapseAll(cx) {
    for (const folder of this.folders) this.entries.delete(folder);
    this.folders = new Set();
    cx.notify();
  }

  select(path, cx) {
    this.selected = path;
    cx.notify();
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      const full = `${this.root}/${path}`;
      const mark = entry.dir ? this.folderMarks.get(full) : this.marks[full], kind = entry.dir ? folderIcon(entry.name, open) : fileIcon(entry.name);
      const selected = this.selected === path;
      const unsaved = entry.dir ? this.unsavedDirs.has(full) : this.unsaved.has(fileKey(this.on, full));
      const nameColor = unsaved ? t.ansi4 : mark ? markColor(mark, t) : t.foreground;
      out.push(h_flex().id(`vsc-file-${path}`).h(26).flex_none().pl(6 + depth * 14).pr(8).gap(6).items_center().rounded(7).cursor_pointer()
        .when(selected, el => el.bg(t.selected)).hover(s => s.bg(selected ? t.selected : t.hover))
        .on_click((_e, cx) => { this.select(path, cx); if (entry.dir) this.toggle(path, cx); else cx.spawn(async (cx) => openFile(full, this.on, cx)); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.select(path, cx); this.menu(entry.dir ? "folder" : "file", path); })
        .child(entry.dir ? icon(`chevron-${open ? "down" : "right"}`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(icon(kind.icon).size(14).flex_none().text_color(t[kind.color] ?? t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(nameColor).child(entry.name))
        // Files show their git letter; folders show a dot in the color of what is inside, as in VS Code.
        .when(unsaved, el => el.child(div().size(7).flex_none().rounded(4).bg(t.ansi4).tooltip(entry.dir ? "Contains unsaved changes" : "Unsaved changes")))
        .when(!unsaved && entry.dir && Boolean(mark), el => el.child(div().size(7).flex_none().rounded(4).bg(markColor(mark, t))))
        .when(!entry.dir && Boolean(mark), el => el.child(div().text_size(11).text_color(markColor(mark, t)).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), name = this.root?.split("/").pop() || this.root || "";
    // Editors publish unsaved files through shared state, which redraws this view; derive folders only when it changed.
    this.unsaved = unsavedFiles();
    const unsavedKey = `${this.on ?? ""}\n${[...this.unsaved].sort().join("\n")}`;
    if (unsavedKey !== this.unsavedKey) { this.unsavedKey = unsavedKey; this.unsavedDirs = unsavedFolders(this.on, this.unsaved); }
    const actions = [
      iconButton("vsc-explorer-refresh", "refresh", "Refresh", cx => this.refresh(cx), t),
      iconButton("vsc-explorer-collapse", "collapse", "Collapse folders", cx => this.collapseAll(cx), t),
    ];
    const title = h_flex().gap(8).items_center().min_w(0).child("Explorer")
      .child(div().min_w(0).truncate().font_normal().text_size(12).text_color(t.dim).child(name));
    const body = v_flex().id("vsc-explorer-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (this.root) this.menu("root", ""); })
      .when(Boolean(this.marksOff), el => el.child(div().px(8).pb(6).text_size(11).text_color(t.dim).child(this.marksOff)))
      .children(this.rows("", 0, [], t))
      .when(Boolean(this.error), el => el.child(div().p(8).text_size(11).text_color(t.ansi1).child(this.error)))
      .when(!this.error && !this.entries.get("")?.length, el => el.child(hint(this.loading ? "Loading files…" : this.root ? "No files" : "No folder", t)))
      .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
    return viewCard("vsc-explorer", title, actions, body, t);
  }
}
