// Search: text across the focused terminal's folder (without what .gitignore excludes in a
// repository), and replace with a preview of every change before anything is written.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { readTextFile, theme, settings, nextCommand, shared, setShared } from "herdr";
import { writeFile } from "../lib/remote.js";
import { icon, iconButton, viewCard, hint, barButton } from "../lib/ui.js";
import { location, locationKey } from "../lib/location.js";
import { listFiles, filesContaining, splitBySize } from "../lib/listing.js";
import { buildMatcher, findMatches, replaceText, replacerFor, grepCanNarrow, planEntry, SEARCH_SCOPE } from "../lib/search.js";
import { looksMisdecoded } from "../lib/editing.js";
import { fileIcon } from "../lib/icons.js";
import { openFile, unsavedFiles, fileKey } from "../lib/open.js";
import { displayName } from "../lib/scm.js";

const MATCH_LIMIT = 2000, DELAY = 300, READERS = 8, PREVIEW_ROWS = 40;
const plural = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
const stop = (_e, cx) => cx.stop_propagation();

export default class Search extends View {
  init(_props, cx) {
    this.options = { matchCase: false, wholeWord: false, regex: false };
    this.includeIgnored = false; this.showReplace = false; this.collapsed = new Set();
    this.results = []; this.gen = 0;
    this.query = InputState.new({ placeholder: "Search" });
    this.query.on("change", (_e, cx) => this.schedule(cx));
    this.query.on("submit", (_e, cx) => this.schedule(cx, 0));
    this.query.on("focus", (_e, cx) => { this.typing = "query"; cx.notify(); });
    this.query.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.replacement = InputState.new({ placeholder: "Replace" });
    this.replacement.on("change", (_e, cx) => { this.plan = null; cx.notify(); });
    this.replacement.on("submit", (_e, cx) => this.preparePlan(cx));
    this.replacement.on("focus", (_e, cx) => { this.typing = "replace"; cx.notify(); });
    this.replacement.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.context = locationKey(); this.scopeKey = JSON.stringify(shared(SEARCH_SCOPE) ?? null);
    // Herdr does not redraw this view when another terminal gets focus or changes folder.
    // Followed here, never in render (Herdr refuses cx.notify() while a view renders).
    cx.timer.every(1000, cx => this.followLocation(cx));
    // cmd-shift-f shows this view (the rail handles that) and puts the keyboard in the search field.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand()).split(".").pop();
        // "Find in Folder…" also sends this, after setting the folder: search again with it.
        if (command === "search") { this.query.focus(); if (this.query.value()) this.schedule(cx, 0); else cx.notify(); }
      }
    });
  }

  // The subfolder "Find in Folder…" chose, when it belongs to the folder shown now.
  scope() {
    const s = shared(SEARCH_SCOPE), { cwd, on } = location();
    return s?.rel && s.root === cwd && (s.on ?? null) === (on ?? null) ? s.rel : null;
  }

  // Another folder: results and any preview belong to the old one. An undo stays offered.
  // Also a new "Find in Folder…" folder: Herdr does not redraw this view when shared state changes.
  followLocation(cx) {
    const scope = JSON.stringify(shared(SEARCH_SCOPE) ?? null);
    if (scope !== this.scopeKey) {
      this.scopeKey = scope;
      if (this.query.value()) this.schedule(cx, 0); else cx.notify();
    }
    if (locationKey() === this.context) return;
    this.context = locationKey(); this.collapsed = new Set();
    if (this.query.value()) this.schedule(cx, 0); else { this.results = []; this.plan = null; cx.notify(); }
  }

  // Waits for typing to pause, then searches; a newer search makes older ones stop.
  schedule(cx, delay = DELAY) {
    const gen = ++this.gen;
    this.plan = null;
    cx.spawn(async (cx) => {
      if (delay) await cx.sleep(delay);
      if (gen === this.gen) await this.run(gen, cx);
    });
    cx.notify();
  }

  async run(gen, cx) {
    const query = this.query.value(), options = { ...this.options }, matcher = buildMatcher(query, options);
    const { cwd: top, on } = location(), scope = this.scope(), cwd = scope ? `${top}/${scope}` : top;
    if (!matcher || matcher.error || !cwd) {
      Object.assign(this, { results: [], total: 0, truncated: false, large: 0, listTruncated: false, note: null });
      this.error = matcher?.error ?? null; this.searching = false; cx.notify(); return;
    }
    // The previous results stay on screen until these are ready.
    this.searching = true; this.error = null; cx.notify();
    try {
      const list = await listFiles(cwd, on, { includeIgnored: this.includeIgnored });
      if (gen !== this.gen) return;
      const candidates = grepCanNarrow(query, options) ? await filesContaining(list.root, list.files, query, options.matchCase, on) : list.files;
      if (gen !== this.gen) return;
      const { small, large } = await splitBySize(list.root, candidates, on);
      const results = [];
      let total = 0, truncated = false;
      for (let i = 0; i < small.length && !truncated; i += READERS) {
        const batch = await Promise.all(small.slice(i, i + READERS).map(async (rel) =>
          ({ rel, text: await readTextFile(`${list.root}/${rel}`, { on }).catch(() => null) })));
        if (gen !== this.gen) return;
        for (const { rel, text } of batch) {
          // Text that is not UTF-8 (binary files in regex mode) is not searched.
          if (text === null || looksMisdecoded(text)) continue;
          const found = findMatches(text, matcher, MATCH_LIMIT - total);
          if (found.matches.length) { results.push({ rel, matches: found.matches }); total += found.matches.length; }
          if (found.truncated) { truncated = true; break; }
        }
      }
      Object.assign(this, { root: list.root, on: on ?? null, results, total, truncated, large: large.length, listTruncated: list.truncated, note: list.note });
    } catch (e) {
      if (gen === this.gen) this.error = displayName(String(e?.message ?? e));
    } finally {
      if (gen === this.gen) { this.searching = false; cx.notify(); }
    }
  }

  toggleOption(name, cx) {
    this.options[name] = !this.options[name];
    this.schedule(cx, 0);
  }

  // Reads every result file again and works out its new text; nothing is written until Replace.
  preparePlan(cx) {
    const matcher = buildMatcher(this.query.value(), this.options);
    if (!matcher?.re || !this.results.length || this.busy) return;
    const root = this.root, on = this.on, files = this.results.map(r => r.rel), replacement = this.replacement.value(), regex = this.options.regex;
    const gen = this.gen;
    this.busy = "Preparing the preview…"; this.done = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { small } = await splitBySize(root, files, on), readable = new Set(small), unsaved = unsavedFiles();
        const entries = [], skipped = [];
        for (const rel of files) {
          const full = `${root}/${rel}`;
          if (!readable.has(rel)) { skipped.push(`${rel} (over 1 MiB or not a regular file)`); continue; }
          if (unsaved.has(fileKey(on, full))) { skipped.push(`${rel} (unsaved changes in its tab)`); continue; }
          const old = await readTextFile(full, { on }).catch(() => null);
          if (old === null || looksMisdecoded(old)) { skipped.push(`${rel} (cannot be read as text)`); continue; }
          const { text: next, count } = replaceText(old, matcher, replacement, regex);
          if (count && next !== old) entries.push(planEntry({ rel, full, on, old, next, count }));
        }
        if (gen === this.gen) this.plan = { entries, skipped, partial: this.truncated };
      } catch (e) { this.error = displayName(String(e?.message ?? e)); }
      finally { this.busy = null; cx.notify(); }
    });
  }

  // Writes only files that still hold exactly the text the preview was made from.
  applyPlan(cx) {
    const chosen = this.plan.entries.filter(e => e.chosen);
    this.plan = null; this.busy = "Replacing…"; cx.notify();
    cx.spawn(async (cx) => {
      const written = [], skipped = [];
      for (const e of chosen) {
        if (unsavedFiles().has(fileKey(e.on, e.full))) { skipped.push(`${e.rel} (unsaved changes in its tab)`); continue; }
        try { await writeFile(e.full, e.next, e.old, e.on); written.push(e); }
        catch { skipped.push(`${e.rel} (changed since the preview)`); }
      }
      const count = written.reduce((n, e) => n + e.count, 0);
      this.undo = written.length ? written.map(e => ({ rel: e.rel, full: e.full, on: e.on, old: e.old, next: e.next })) : null;
      this.done = `Replaced ${plural(count, "match")} in ${plural(written.length, "file")}.${skipped.length ? ` Not changed: ${skipped.join(", ")}.` : ""}`;
      this.busy = null;
      this.schedule(cx, 0);
    });
  }

  // Puts back the text of each replaced file that nobody changed since.
  undoReplace(cx) {
    const undo = this.undo;
    this.undo = null; this.busy = "Undoing…"; cx.notify();
    cx.spawn(async (cx) => {
      const skipped = [];
      let restored = 0;
      for (const u of undo) {
        if (unsavedFiles().has(fileKey(u.on, u.full))) { skipped.push(`${u.rel} (unsaved changes in its tab)`); continue; }
        try { await writeFile(u.full, u.old, u.next, u.on); restored++; }
        catch { skipped.push(`${u.rel} (changed since the replace)`); }
      }
      this.done = `Restored ${plural(restored, "file")}.${skipped.length ? ` Not restored: ${skipped.join(", ")}.` : ""}`;
      this.busy = null;
      this.schedule(cx, 0);
    });
  }

  toggleFile(rel, cx) {
    if (this.collapsed.has(rel)) this.collapsed.delete(rel); else this.collapsed.add(rel);
    cx.notify();
  }

  field(id, state, focused, t, extra = []) {
    return h_flex().id(id).flex_1().min_w(0).h(32).pl(10).pr(4).gap(2).items_center().rounded(8).border_1()
      .border_color(focused ? t.accent : t.border).cursor_text()
      .on_mouse_down("left", stop)
      .child(Input.new(state).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
      .children(extra);
  }

  // Aa, ab and .* as in VS Code: text toggles, solid when on.
  toggle(id, label, tooltip, on, onClick, t) {
    return div().id(id).h(22).px(5).flex().flex_none().items_center().rounded(5).cursor_pointer().text_size(11)
      .font_family(settings().font_family ?? "JetBrains Mono").tooltip(tooltip)
      .text_color(on ? t.foreground : t.dim).when(on, el => el.bg(t.selected).border_1().border_color(t.accent))
      .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  form(t) {
    const o = this.options;
    const toggles = [
      this.toggle("vsc-search-case", "Aa", "Match case", o.matchCase, cx => this.toggleOption("matchCase", cx), t),
      this.toggle("vsc-search-word", "ab", "Match whole word", o.wholeWord, cx => this.toggleOption("wholeWord", cx), t),
      this.toggle("vsc-search-regex", ".*", "Use regular expression (JavaScript)", o.regex, cx => this.toggleOption("regex", cx), t),
    ];
    const canReplace = Boolean(this.results.length) && !this.busy && !this.searching;
    return v_flex().flex_none().p(10).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(4).items_center()
        .child(iconButton("vsc-search-replace-toggle", this.showReplace ? "chevron-down" : "chevron-right", "Toggle Replace",
          cx => { this.showReplace = !this.showReplace; this.plan = null; cx.notify(); }, t))
        .child(this.field("vsc-search-query", this.query, this.typing === "query", t, toggles)))
      .when(this.showReplace, el => el.child(h_flex().gap(4).items_center().pl(30)
        .child(this.field("vsc-search-replacement", this.replacement, this.typing === "replace", t))
        .child(div().when(!canReplace, d => d.opacity(0.4)).child(iconButton("vsc-search-replace-all", "replace", "Replace all (shows a preview first)",
          cx => { if (canReplace) this.preparePlan(cx); }, t)))))
      .when(Boolean(this.scope()), el => el.child(h_flex().pl(30).gap(4).items_center().text_size(11).text_color(t.dim)
        .child(div().min_w(0).truncate().child(`in folder: ${displayName(this.scope() ?? "")}`))
        .child(iconButton("vsc-search-scope-clear", "x", "Search the whole folder", cx => { setShared(SEARCH_SCOPE, null); this.schedule(cx, 0); }, t))))
      .child(h_flex().pl(30).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().id("vsc-search-ignored").flex().gap(5).items_center().cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_mouse_down("left", stop).on_click((_e, cx) => { this.includeIgnored = !this.includeIgnored; this.schedule(cx, 0); })
          .child(icon(this.includeIgnored ? "square-check" : "square").size(12))
          .child("Include ignored files")));
  }

  status(t) {
    const line = (text, color = t.dim) => div().px(12).py(6).text_size(11).text_color(color).child(text);
    const out = [];
    if (this.busy) out.push(line(this.busy));
    if (this.error) out.push(line(this.error, t.ansi1));
    if (this.done) out.push(h_flex().px(12).py(6).gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(this.done))
      .when(Boolean(this.undo) && !this.busy, el => el.child(barButton("vsc-search-undo", "Undo replace", cx => this.undoReplace(cx), t))));
    const { cwd } = location();
    if (!cwd) out.push(line("No folder"));
    else if (this.searching) out.push(line("Searching…"));
    else if (this.query.value() && !this.error) {
      out.push(line(this.total ? `${plural(this.total, "result")} in ${plural(this.results.length, "file")}` : "No results"));
      if (this.truncated) out.push(line(`Showing the first ${MATCH_LIMIT.toLocaleString("en")} results; refine the search to see the rest.`));
      if (this.listTruncated) out.push(line("Only the first 10,000 files were searched."));
      if (this.large) out.push(line(`${plural(this.large, "file")} over 1 MiB not searched.`));
      if (this.note) out.push(line(this.note));
    }
    return out;
  }

  // What each match becomes while Replace is open (null otherwise): built once per query, replacement
  // and options, not once per row and frame.
  replacer() {
    const key = JSON.stringify([this.showReplace, this.query.value(), this.replacement.value(), this.options]);
    if (key !== this.replacerKey) {
      const matcher = this.showReplace ? buildMatcher(this.query.value(), this.options) : null;
      this.replacerKey = key;
      this.replacerFn = matcher?.re ? replacerFor(matcher, this.replacement.value(), this.options.regex) : null;
    }
    return this.replacerFn;
  }

  // With `replacer` (Replace open) the match is struck through and its replacement follows. File text
  // is shown without control and direction characters, so a line cannot read differently from what
  // Replace changes.
  matchRow(file, m, i, replacer, t) {
    const replacing = Boolean(replacer), shown = (text) => displayName(text.replace(/\t/g, "  "));
    const becomes = replacing ? shown(replacer(m.preview.match)) : "";
    const full = `${this.root}/${file.rel}`;
    return h_flex().id(`vsc-search-m-${file.rel}-${i}`).h(22).flex_none().pl(20).pr(8).gap(6).items_center().rounded(6)
      .cursor_pointer().hover(s => s.bg(t.hover)).tooltip(`Line ${m.line}, column ${m.col}`)
      .on_click((_e, cx) => cx.spawn(async (cx) => openFile(full, this.on, cx)))
      .child(div().w(44).flex_none().whitespace_nowrap().text_right().text_size(11).text_color(t.dim).child(String(m.line)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_size(12).text_color(t.muted)
        .child(div().flex_none().child(shown(m.preview.before)))
        .child(div().flex_none().rounded(3).px(1).text_color(t.foreground)
          .bg(replacing ? t.ansi1 + "30" : t.accent + "40").when(replacing, el => el.line_through()).child(shown(m.preview.match)))
        .when(replacing && becomes !== "", el => el.child(div().flex_none().rounded(3).px(1).bg(t.ansi2 + "30").text_color(t.foreground).child(becomes)))
        .child(div().flex_1().min_w(0).truncate().child(shown(m.preview.after))));
  }

  fileRows(t) {
    const rows = [], replacer = this.replacer();
    for (const file of this.results) {
      const open = !this.collapsed.has(file.rel), kind = fileIcon(file.rel.split("/").pop());
      const slash = file.rel.lastIndexOf("/"), name = file.rel.slice(slash + 1), dir = slash > 0 ? file.rel.slice(0, slash) : "";
      rows.push(h_flex().id(`vsc-search-f-${file.rel}`).h(26).flex_none().px(6).gap(6).items_center().rounded(7).cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.toggleFile(file.rel, cx))
        .child(icon(`chevron-${open ? "down" : "right"}`).size(12).flex_none().text_color(t.dim))
        .child(icon(kind.icon).size(14).flex_none().text_color(t[kind.color] ?? t.muted))
        .child(div().flex_none().max_w(200).truncate().text_color(t.foreground).child(displayName(name)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(displayName(dir)))
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(String(file.matches.length))));
      if (open) file.matches.forEach((m, i) => rows.push(this.matchRow(file, m, i, replacer, t)));
    }
    return rows;
  }

  planView(t) {
    const plan = this.plan, chosen = plan.entries.filter(e => e.chosen);
    const count = chosen.reduce((n, e) => n + e.count, 0);
    const mono = settings().font_family ?? "JetBrains Mono";
    const body = v_flex().id("vsc-search-plan").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2);
    if (!plan.entries.length) body.child(hint("Nothing to replace.", t));
    for (const e of plan.entries) {
      const shown = e.rows.slice(0, PREVIEW_ROWS);
      body.child(h_flex().id(`vsc-search-p-${e.rel}`).h(26).flex_none().px(6).gap(6).items_center().rounded(7).cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click((_ev, cx) => { e.chosen = !e.chosen; cx.notify(); })
        .child(icon(e.chosen ? "square-check" : "square").size(14).flex_none().text_color(e.chosen ? t.foreground : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(e.chosen ? t.foreground : t.dim).child(displayName(e.rel)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(plural(e.count, "match"))));
      if (e.chosen) body.child(v_flex().flex_none().ml(26).mb(4).rounded(6).border_1().border_color(t.border).overflow_hidden()
        .font_family(mono).text_size(11)
        .children(shown.map(r => h_flex().h(20).flex_none().px(6).gap(6).items_center()
          .bg(r.kind === "+" ? t.ansi2 + "18" : t.ansi1 + "18")
          .child(div().w(30).flex_none().text_right().text_color(t.dim).child(String(r.kind === "+" ? r.new : r.old)))
          .child(div().w(10).flex_none().text_color(r.kind === "+" ? t.ansi2 : t.ansi1).child(r.kind))
          .child(div().flex_1().min_w(0).truncate().child(displayName(r.text.replace(/\t/g, "  "))))))
        .when(e.rows.length > shown.length, el => el.child(div().px(6).py(2).text_color(t.dim).child(`${e.rows.length - shown.length} more changed lines`))));
    }
    const notes = [
      ...(plan.skipped.length ? [`Not changed: ${plan.skipped.join(", ")}.`] : []),
      ...(plan.partial ? [`Only the files in the first ${MATCH_LIMIT.toLocaleString("en")} results are included.`] : []),
    ];
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(12).font_semibold().child(`Replace ${plural(count, "match")} in ${plural(chosen.length, "file")}?`))
        .child(barButton("vsc-search-plan-cancel", "Cancel", cx => { this.plan = null; cx.notify(); }, t))
        .child(barButton("vsc-search-plan-apply", "Replace", cx => this.applyPlan(cx), t, { primary: true, enabled: chosen.length > 0 })))
      .children(notes.map(n => div().px(12).pt(6).text_size(11).text_color(t.dim).child(n)))
      .child(body);
  }

  render(cx) {
    const t = theme();
    const actions = [
      iconButton("vsc-search-refresh", "refresh", "Search again", cx => this.schedule(cx, 0), t),
      iconButton("vsc-search-collapse", "collapse", "Collapse all", cx => { this.collapsed = new Set(this.results.map(r => r.rel)); cx.notify(); }, t),
    ];
    const body = this.plan ? this.planView(t)
      : v_flex().id("vsc-search-results").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.fileRows(t));
    return viewCard("vsc-search", "Search", actions, v_flex().flex_1().min_h(0)
      .child(this.form(t)).children(this.status(t)).child(body), t);
  }
}
