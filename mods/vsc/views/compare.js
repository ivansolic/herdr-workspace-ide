// Compare tab: two files of one machine side by side as a line diff ("Compare with Selected"), read-only.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readTextFile, theme, props as blockProps } from "herdr";
import { lineDiff } from "../lib/diff.js";
import { diffView, iconButton } from "../lib/ui.js";
import { baseName } from "../lib/files.js";
import { displayName } from "../lib/scm.js";

export default class CompareTab extends View {
  init(_props, cx) {
    const p = blockProps() ?? {};
    this.left = p.left; this.right = p.right; this.on = p.on ?? null;
    this.rows = null; this.message = "Loading…";
    this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const [a, b] = await Promise.all([this.left, this.right].map(path => readTextFile(path, { on: this.on })));
        if (a === null || b === null) throw new Error(`${baseName(a === null ? this.left : this.right)} is no longer there.`);
        if (a.includes("\0") || b.includes("\0")) throw new Error("Binary file · no text to compare");
        this.rows = lineDiff(a, b); this.message = null;
      } catch (e) { this.rows = null; this.message = displayName(String(e?.message ?? e)); }
      finally { cx.notify(); }
    });
  }

  render() {
    const t = theme();
    return v_flex().size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${displayName(this.left)} ↔ ${displayName(this.right)}`))
        .child(iconButton("vsc-compare-refresh", "refresh", "Compare again", cx => this.load(cx), t)))
      .child(this.rows ? diffView("vsc-compare-rows", this.rows, [baseName(this.left), baseName(this.right)], t)
        : div().p(12).text_size(12).text_color(t.dim).child(this.message ?? ""));
  }
}
