// Diagram tab: one Mermaid block of a Markdown file, drawn as a picture (Diagram) or shown as its
// text (Source), read-only. Follows the file: a changed block is drawn again.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { diagramView, plainText } from "../lib/ui.js";
import { readTextFile, theme, props as blockProps } from "herdr";
import { mermaidBlocks } from "../lib/diagrams.js";
import { DiagramPicture, themeOf } from "../lib/drawing.js";
import { diagramPath } from "../lib/open.js";
import { baseName } from "../lib/files.js";

const POLL_MS = 2000, REMOTE_POLL_MS = 5000; // as the editor: another machine is asked less often

export default class DiagramTab extends View {
  init(_props, cx) {
    const p = blockProps() ?? {};
    this.file = p.file; this.index = Number(p.index) || 1; this.on = p.on ?? null;
    this.picture = new DiagramPicture(this.on, diagramPath(this.file, this.index));
    this.source = null; this.message = "Drawing…"; this.showSource = false;
    this.follow(cx);
  }

  // Reads the block now and every POLL_MS, and draws it when it (or the theme) changed.
  follow(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          const text = await readTextFile(this.file, { on: this.on });
          const block = text === null ? null : mermaidBlocks(text)[this.index - 1];
          if (!block) { this.source = null; this.message = text === null ? `${baseName(this.file)} is no longer there.` : `Diagram ${this.index} is no longer in ${baseName(this.file)}.`; }
          else {
            this.source = block.source; this.message = null;
            if (await this.picture.draw("mermaid", block.source, themeOf(theme().background))) cx.notify();
          }
        } catch (e) { this.message = String(e?.message ?? e); }
        cx.notify();
        await cx.sleep(this.on ? REMOTE_POLL_MS : POLL_MS);
      }
    });
  }

  segment(id, label, on, pick, t) {
    return div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(12).cursor_pointer()
      .bg(on ? t.background : t.raised).text_color(on ? t.foreground : t.muted)
      .on_click((_e, cx) => { pick(); cx.notify(); }).child(label);
  }

  body(t) {
    if (this.message && !this.picture.image) return div().p(14).text_color(t.dim).child(this.message);
    if (this.showSource) return div().id("vsc-diagram-source").flex_1().min_h(0).overflow_y_scrollbar().px(28).py(20)
      .child(plainText("vsc-diagram-text", this.source ?? ""));
    return diagramView("vsc-diagram", this.picture, t, this.message);
  }

  render() {
    const t = theme();
    return v_flex().size_full().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${baseName(this.file)} · Diagram ${this.index}`))
        .child(h_flex().gap(2).p(2).rounded(7).bg(t.raised)
          .child(this.segment("vsc-diagram-view", "Diagram", !this.showSource, () => { this.showSource = false; }, t))
          .child(this.segment("vsc-diagram-src", "Source", this.showSource, () => { this.showSource = true; }, t))))
      .child(this.body(t));
  }
}
