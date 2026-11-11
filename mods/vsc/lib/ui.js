// Shared building blocks styled per DESIGN.md.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { run, settings } from "herdr";
import { MOD } from "./open.js";

export const icon = (name) => svg(`mods/${MOD}/icons/${name}.svg`);

const stop = (_e, cx) => cx.stop_propagation();

// A 26px icon button: dim, hover background, foreground on hover.
export function iconButton(id, name, tooltip, onClick, t) {
  return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
    .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tooltip)
    // Redraws after every click, so a handler that only changes state cannot leave the screen stale.
    .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
    .child(icon(name).size(14));
}

// The panel card every view draws: flush with the rail, rounded, bordered, header on top.
export function viewCard(id, title, actions, body, t) {
  return div().size_full().child(
    v_flex().id(id).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
        .children(actions)
        .child(iconButton(`${id}-close`, "x", "Close panel", () => run("layout.hide", { id: VIEWS_ID }), t)))
      .child(body));
}

export const VIEWS_ID = "vsc-views";

// A bar button with a label (h 26); `primary` uses the solid color, a disabled one is raised and dim.
export function barButton(id, label, onClick, t, { primary = false, enabled = true } = {}) {
  return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(6).text_size(12)
    .bg(enabled && primary ? t.solid : t.raised).text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
    .on_mouse_down("left", stop)
    .when(enabled, el => el.cursor_pointer().hover(s => s.bg(primary ? t.solid : t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); }))
    .child(label);
}

export function hint(text, t) {
  return div().p(8).text_size(12).text_color(t.dim).child(text);
}

// Line diff rows from lib/diff.js, as Compare and the changes tab show them.
export function diffView(id, rows, legend, t) {
  const shown = rows.slice(0, 5000);
  const number = (n) => div().w(40).flex_none().text_right().text_color(t.dim).child(n === null ? "" : String(n));
  return v_flex().flex_1().min_h(0)
    .child(h_flex().h(28).flex_none().px(12).gap(14).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child(div().text_color(t.ansi1).child(`− ${legend[0]}`)).child(div().text_color(t.ansi2).child(`+ ${legend[1]}`)))
    .child(v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .children(shown.map((r) => h_flex().w_full().h(20).flex_none().gap(8)
        .when(r.kind === "+", el => el.bg(t.ansi2 + "18")).when(r.kind === "-", el => el.bg(t.ansi1 + "18"))
        .child(number(r.old)).child(number(r.new))
        .child(div().w(12).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind.trim()))
        .child(div().flex_1().min_w(0).truncate().child(r.text))))
      .when(rows.length > shown.length, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(`Showing the first 5,000 of ${rows.length} lines`))));
}

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Text shown as is, selectable (diagram sources and their errors).
export const plainText = (id, text) => TextView.html(id, `<pre>${escapeHtml(text ?? "")}</pre>`).selectable(true);

// A diagram's picture (lib/drawing.js DiagramPicture), with its error above it; the last good
// picture stays under an error.
export function diagramView(id, picture, t, message = null) {
  const error = picture.error ?? message;
  return v_flex().flex_1().min_h(0)
    .when(Boolean(error), el => el.child(div().flex_none().px(12).py(6).border_b(1).border_color(t.border).bg(t.raised)
      .child(plainText(`${id}-error`, error))))
    .child(picture.image
      ? div().flex_1().min_h(0).p(16).flex().items_center().justify_center().child(image(picture.image).max_w_full().max_h_full())
      : div().p(14).text_color(t.dim).child(picture.drawing || !error ? "Drawing…" : ""));
}
