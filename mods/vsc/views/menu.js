// The Explorer's right-click menu: a popup at the pointer. Actions that need a name or a
// confirmation open a dialog (views/dialog.js); the rest run here and report failures as toasts.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, props as blockProps, closeOverlay, openOverlay, shared, setShared, run, notify } from "herdr";
import { menuItems } from "../lib/menu-items.js";
import { CLIP, COMPARE, paste, reveal } from "../lib/fileactions.js";
import { openCompare, openToSide, MOD } from "../lib/open.js";
import { SEARCH_SCOPE } from "../lib/search.js";
import { displayName } from "../lib/scm.js";

export function openDialog(dialog) {
  openOverlay({ mod: MOD, kind: "dialog", width: 440, height: dialog.mode.startsWith("delete") ? 190 : 200, props: { view: "dialog", ...dialog } });
}

export default class Menu extends View {
  init() {
    const p = blockProps() ?? {};
    this.overlay = p.overlay; this.target = p.target;
  }

  close() { closeOverlay(this.overlay); }

  // What runs for each item. The menu closes after the action: closing it ends work it started.
  act(id, cx) {
    const { kind, rel, root, on, path } = this.target, folderRel = kind === "file" ? rel.split("/").slice(0, -1).join("/") : rel;
    const later = (job) => cx.spawn(async (cx) => {
      try { await job(cx); }
      catch (e) { notify({ title: "Explorer", body: displayName(String(e?.message ?? e)), level: "error" }); }
      finally { this.close(); }
    });
    switch (id) {
      case "reveal": return later(() => reveal(path));
      case "compare": return later((cx) => openCompare(shared(COMPARE).path, path, on, cx));
      case "paste": return later((cx) => paste(root, folderRel, on, cx));
      case "side": return later((cx) => openToSide(path, on, cx));
      case "terminal": run("terminal.open", { folder: kind === "file" ? path.slice(0, path.lastIndexOf("/")) : path, place: "tab" }); break;
      case "find": setShared(SEARCH_SCOPE, { root, on, rel: folderRel }); run(`${MOD}.search`); break;
      case "pick-compare": setShared(COMPARE, { on, path }); break;
      case "cut": case "copy": setShared(CLIP, { mode: id, root, on, rel }); break;
      case "copy-path": cx.write_to_clipboard(path); break;
      case "copy-relative": cx.write_to_clipboard(rel); break;
      case "new-file": case "new-folder": openDialog({ mode: id, root, on, rel: folderRel }); break;
      case "rename": openDialog({ mode: "rename", root, on, rel, folder: kind === "folder" }); break;
      case "delete": openDialog({ mode: "delete", root, on, rel, folder: kind === "folder" }); break;
    }
    this.close();
  }

  render() {
    const t = theme(), items = menuItems(this.target, { clip: shared(CLIP), pick: shared(COMPARE) });
    return v_flex().id("vsc-menu").size_full().p(6).bg(t.popover).text_size(13)
      .children(items.map((it, i) => it === "-"
        ? div().h(9).flex_none().flex().items_center().child(div().h(1).w_full().bg(t.border))
        : div().id(`vsc-menu-${it.id}`).h(28).flex_none().px(10).flex().items_center().rounded(6).cursor_pointer()
          .text_color(it.id === "delete" ? t.ansi1 : t.foreground).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.act(it.id, cx)).child(it.label)));
  }
}
