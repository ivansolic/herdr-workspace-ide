// Changes tab: a file in the repository against its committed version (HEAD), read-only.
// HEAD's text comes from `git cat-file blob`, which runs no filters or diff programs.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readTextFile, theme, props as blockProps } from "herdr";
import { git, repoInfo, failure } from "../lib/git.js";
import { lineDiff } from "../lib/diff.js";
import { diffView, iconButton } from "../lib/ui.js";
import { openFile } from "../lib/open.js";

export default class DiffTab extends View {
  init(_props, cx) {
    const p = blockProps() ?? {};
    this.root = p.root; this.path = p.path; this.on = p.on ?? null; this.status = p.status;
    this.rows = null; this.message = "Loading changes…";
    this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const { off } = await repoInfo(this.root, this.on);
        if (off) throw new Error(`Changes are not shown: ${off}`);
        // Decided on every load, not from the status the tab opened with: the file may have been
        // committed, recreated or deleted since.
        const inHead = (await git(this.root, this.on, ["cat-file", "-e", `HEAD:${this.path}`])).code === 0;
        let before = "";
        if (inHead) {
          const r = await git(this.root, this.on, ["cat-file", "blob", `HEAD:${this.path}`]);
          if (r.code !== 0) throw new Error(failure(r));
          before = r.stdout;
        }
        const read = await readTextFile(`${this.root}/${this.path}`, { on: this.on }).then(text => ({ text }), () => null);
        if (read === null) throw new Error("This file is not readable as text (binary or too large).");
        const after = read.text ?? ""; // null: the file is gone (deleted)
        if (before.includes("\0") || after.includes("\0")) throw new Error("Binary file · no text changes");
        this.rows = lineDiff(before, after); this.message = null;
      } catch (e) { this.rows = null; this.message = String(e?.message ?? e); }
      finally { cx.notify(); }
    });
  }

  render() {
    const t = theme(), parts = this.path.split("/"), name = parts.pop();
    return v_flex().id("vsc-diff").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().pl(12).pr(6).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().flex_1().min_w(0).gap(4).items_center().text_size(12)
          .child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? parts.join("/") + "/" : ""))
          .child(div().flex_none().child(name))
          .child(div().flex_none().text_color(t.dim).child("· changes since last commit")))
        .child(iconButton("vsc-diff-refresh", "refresh", "Refresh", cx => this.load(cx), t))
        .when(this.status !== "D", el => el.child(iconButton("vsc-diff-open", "file", "Open file", cx => {
          cx.spawn(async (cx) => openFile(`${this.root}/${this.path}`, this.on, cx));
        }, t))))
      .child(this.rows ? diffView("vsc-diff-rows", this.rows, ["last commit", "now"], t)
        : div().p(14).text_color(t.dim).child(this.message));
  }
}
