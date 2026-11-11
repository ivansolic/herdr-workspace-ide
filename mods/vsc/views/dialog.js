// Dialogs for Explorer's actions: a name (New File, New Folder, Rename) or a confirmation (Delete).
// The action runs from here; a failure shows in the dialog, success closes it.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props as blockProps, closeOverlay } from "herdr";
import { barButton } from "../lib/ui.js";
import { validName } from "../lib/fileops.js";
import { newFile, newFolder, rename, trash, deleteForGood } from "../lib/fileactions.js";
import { displayName } from "../lib/scm.js";

const TITLES = { "new-file": "New File", "new-folder": "New Folder", rename: "Rename" };

export default class Dialog extends View {
  init(_props, cx) {
    const p = blockProps() ?? {};
    Object.assign(this, { overlay: p.overlay, mode: p.mode, root: p.root, on: p.on ?? null, rel: p.rel ?? "", folder: Boolean(p.folder), error: null, busy: false });
    this.name = this.rel.split("/").pop();
    if (TITLES[this.mode]) {
      const initial = this.mode === "rename" ? this.name : "";
      this.input = InputState.new({ placeholder: this.mode === "new-folder" ? "Folder name" : "File name", value: initial });
      this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      this.input.on("submit", (_e, cx) => this.confirm(cx));
      // Rename selects the name without its extension, as VS Code does.
      const dot = initial.lastIndexOf(".");
      if (initial) this.input.set_selected_range({ start: 0, end: dot > 0 && !this.folder ? dot : initial.length });
      this.input.focus();
      cx.timer.after(300, () => this.input.focus());
    }
  }

  close() { closeOverlay(this.overlay); }

  confirm(cx) {
    if (this.busy) return;
    const name = this.input?.value().trim();
    if (this.input) {
      const problem = validName(name);
      if (problem) { this.error = problem; cx.notify(); return; }
      if (this.mode === "rename" && name === this.name) { this.close(); return; }
    }
    this.busy = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        if (this.mode === "new-file") await newFile(this.root, this.rel, name, this.on, cx);
        else if (this.mode === "new-folder") await newFolder(this.root, this.rel, name, this.on);
        else if (this.mode === "rename") await rename(this.root, this.rel, name, this.on, cx);
        else if (this.mode === "delete") {
          // No trash on that machine: ask a second time, now for deleting for good.
          if ((await trash(this.root, this.rel, this.on)).noTrash) { this.mode = "delete-forever"; return; }
        } else if (this.mode === "delete-forever") await deleteForGood(this.root, this.rel, this.on);
        this.close();
      } catch (e) { this.error = displayName(String(e?.message ?? e)); }
      finally { this.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  render() {
    const t = theme(), what = `${this.folder ? "folder" : "file"} "${displayName(this.name)}"${this.folder ? " and everything in it" : ""}`;
    const title = TITLES[this.mode] ?? (this.mode === "delete" ? "Delete" : "Delete for good");
    const text = this.mode === "delete" ? `Move the ${what} to the Trash? You can restore it from there.`
      : this.mode === "delete-forever" ? `This machine has no trash. Delete the ${what} for good? This cannot be undone.` : null;
    const action = this.mode === "delete" ? "Move to Trash" : this.mode === "delete-forever" ? "Delete for good" : TITLES[this.mode] === "Rename" ? "Rename" : "Create";
    return v_flex().id("vsc-dialog").size_full().p(18).gap(12).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child(title))
      .when(Boolean(text), el => el.child(div().text_size(12).child(text)))
      .when(Boolean(this.input), el => el.child(h_flex().h(32).px(10).items_center().rounded(8).border_1().border_color(t.accent)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))))
      .when(Boolean(this.error), el => el.child(div().text_size(11).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).justify_end()
        .child(barButton("vsc-dialog-cancel", "Cancel", () => this.close(), t))
        .child(barButton("vsc-dialog-ok", this.busy ? "Working…" : action, cx => this.confirm(cx), t, { primary: true, enabled: !this.busy })));
  }
}
