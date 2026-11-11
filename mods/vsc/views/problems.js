// Problems: errors and warnings from the folder's own checks (tsc, ESLint, Ruff), with a link that
// opens VS Code at the line. Checks run the project's own programs and configuration (an ESLint
// config is code), so nothing runs until the folder is trusted, and the prompt names each command.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, settings, shared, setShared } from "herdr";
import { icon, iconButton, viewCard, hint, barButton } from "../lib/ui.js";
import { location, locationKey } from "../lib/location.js";
import { detect, isTrusted, setTrusted, runChecks, openInVSCode } from "../lib/checks.js";
import { folderRecord, groupByFile, PROBLEM_COUNT as COUNT } from "../lib/problems.js";
import { fileIcon } from "../lib/icons.js";
import { openFile, SAVED, fileKey } from "../lib/open.js";
import { displayName } from "../lib/scm.js";

const AFTER_SAVE_MS = 1000;
const plural = (n, word) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

export default class Problems extends View {
  init(_props, cx) {
    this.collapsed = new Set(); this.gen = 0;
    this.lastSave = shared(SAVED)?.at ?? 0;
    this.load(cx);
    // Herdr does not redraw this view when another terminal gets focus or changes folder.
    // Followed here, never in render (Herdr refuses cx.notify() while a view renders).
    cx.timer.every(1000, cx => { if (locationKey() !== this.context) this.load(cx); this.afterSave(cx); });
  }

  // A new folder: find its checks; results of the previous folder are dropped.
  load(cx) {
    const { cwd, on } = location(), context = locationKey(), gen = ++this.gen;
    Object.assign(this, { context, root: cwd ?? null, on: on ?? null, tools: null, folder: null, skipped: [], result: null, error: null, running: false, again: false });
    setShared(COUNT, null);
    if (!cwd || on) { cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const found = await detect(cwd, null);
        if (gen !== this.gen) return;
        this.tools = found.tools; this.folder = folderRecord(found); this.skipped = found.skipped;
      } catch (e) { if (gen === this.gen) this.error = displayName(String(e?.message ?? e)); }
      finally { if (gen === this.gen) cx.notify(); }
    });
    cx.notify();
  }

  trusted() {
    return Boolean(this.folder) && isTrusted(this.on, this.folder);
  }

  // One run at a time; a request during a run starts one more after it. The folder is looked at
  // again first: if it now leads elsewhere, or its checks changed, nothing runs and the panel starts
  // over (asking for trust again when needed).
  run(cx) {
    if (!this.tools?.length || !this.trusted()) return;
    if (this.running) { this.again = true; return; }
    const gen = this.gen, root = this.root, { realRoot, id } = this.folder, tools = this.tools;
    this.running = true; this.again = false; this.error = null; this.runGen = (this.runGen ?? 0) + 1;
    const runGen = this.runGen;
    cx.spawn(async (cx) => {
      try {
        const now = await detect(root, null);
        if (gen !== this.gen) return;
        if (now.realRoot !== realRoot || now.id !== id || JSON.stringify(now.tools) !== JSON.stringify(tools)) {
          this.running = false; this.load(cx); return;
        }
        const outcome = await runChecks(root, realRoot, tools, cx, () => gen === this.gen && runGen === this.runGen);
        if (!outcome || gen !== this.gen) return;
        this.result = { ...groupByFile(outcome.problems), failures: outcome.errors.map(e => displayName(e)) };
        setShared(COUNT, { errors: this.result.errors, warnings: this.result.warnings });
      } catch (e) { if (gen === this.gen) this.error = displayName(String(e?.message ?? e)); }
      finally {
        if (gen === this.gen && runGen === this.runGen) {
          this.running = false;
          if (this.again) this.run(cx);
        }
        cx.notify();
      }
    });
    cx.notify();
  }

  stopRun(cx) {
    this.runGen = (this.runGen ?? 0) + 1; // the running checks see it and stop
    this.running = false; this.again = false;
    cx.notify();
  }

  // A save in this folder checks again (only once the folder is trusted).
  afterSave(cx) {
    const saved = shared(SAVED);
    if (!saved || saved.at === this.lastSave) return;
    this.lastSave = saved.at;
    if (!this.root || !this.trusted() || !this.result) return;
    if (!saved.key.startsWith(fileKey(this.on, `${this.root}/`))) return;
    const at = saved.at;
    cx.spawn(async (cx) => {
      await cx.sleep(AFTER_SAVE_MS);
      if (shared(SAVED)?.at === at) this.run(cx);
    });
  }

  vscode(path, line, col, cx) {
    cx.spawn(async (cx) => {
      try { await openInVSCode(path, line, col); this.openError = null; }
      catch (e) { this.openError = displayName(String(e?.message ?? e)); }
      finally { cx.notify(); }
    });
  }

  trustCard(t) {
    const commands = this.tools.map(tool => tool.argv.join(" "));
    return v_flex().p(12).gap(8).text_size(12)
      .child(div().text_color(t.foreground).child("Checks run this folder's own programs:"))
      .child(v_flex().gap(2).p(8).rounded(6).border_1().border_color(t.border).font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .children(commands.map(c => div().text_color(t.foreground).child(displayName(c)))))
      .when(this.skipped.length > 0, el => el.child(div().text_size(11).text_color(t.dim)
        .child(`Not checked: tsconfig references outside this folder (${this.skipped.map(displayName).join(", ")}).`)))
      .child(div().text_size(11).text_color(t.dim).child("They can run any code the project contains (an ESLint config is a program). Only trust folders you know."))
      // Trust is tied to the folder's identity on disk; without it, trusting could never take effect.
      .when(!this.folder.id, el => el.child(div().text_size(11).text_color(t.ansi1)
        .child("This folder's identity on disk could not be read (stat failed), so it cannot be trusted and checks cannot run.")))
      .when(Boolean(this.folder.id), el => el.child(h_flex().gap(8).child(barButton("vsc-problems-trust", "Trust and run checks", cx => { setTrusted(this.on, this.folder, true); this.run(cx); }, t, { primary: true }))));
  }

  problemRow(p, i, t) {
    const error = p.severity === "error";
    const where = `${p.source}${p.code ? `(${p.code})` : ""} [${p.line}, ${p.col}]`;
    return h_flex().id(`vsc-problem-${p.file}-${i}`).h(26).flex_none().pl(26).pr(4).gap(6).items_center().rounded(6)
      .cursor_pointer().hover(s => s.bg(t.hover)).tooltip(`${displayName(p.message)}\n${where}`)
      .on_click((_e, cx) => cx.spawn(async (cx) => openFile(p.file, null, cx)))
      .child(icon(error ? "circle-x" : "triangle-alert").size(13).flex_none().text_color(error ? t.ansi1 : t.blocked))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(displayName(p.message)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(where))
      .child(iconButton(`vsc-problem-vscode-${p.file}-${i}`, "external-link", "Open in VS Code at this line", cx => this.vscode(p.file, p.line, p.col, cx), t));
  }

  rows(t) {
    const rows = [];
    for (const group of this.result.files) {
      const open = !this.collapsed.has(group.file), name = group.file.split("/").pop();
      const dir = group.file.startsWith(`${this.root}/`) ? group.file.slice(this.root.length + 1, -name.length - 1) : group.file.slice(0, -name.length - 1);
      const kind = fileIcon(name);
      rows.push(h_flex().id(`vsc-problems-f-${group.file}`).h(26).flex_none().px(6).gap(6).items_center().rounded(7).cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => { if (open) this.collapsed.add(group.file); else this.collapsed.delete(group.file); cx.notify(); })
        .child(icon(`chevron-${open ? "down" : "right"}`).size(12).flex_none().text_color(t.dim))
        .child(icon(kind.icon).size(14).flex_none().text_color(t[kind.color] ?? t.muted))
        .child(div().flex_none().max_w(200).truncate().text_color(t.foreground).child(displayName(name)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(displayName(dir)))
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(group.problems.length))));
      if (open) group.problems.forEach((p, i) => rows.push(this.problemRow(p, i, t)));
    }
    return rows;
  }

  body(t) {
    const line = (text, color = t.dim) => div().px(12).py(6).text_size(11).text_color(color).child(text);
    // Checks run a project's own programs; trusting them on another machine is not offered.
    if (this.on) return hint("Problems runs checks on this computer only, not on other machines.", t);
    if (!this.root) return hint("No folder", t);
    if (this.error) return line(this.error, t.ansi1);
    if (!this.tools) return hint("Looking for checks…", t);
    if (!this.tools.length && this.skipped.length) return hint(`No checks run: tsconfig.json only refers to configs outside this folder (${this.skipped.map(displayName).join(", ")}), which are not checked.`, t);
    if (!this.tools.length) return hint("No checks found: needs tsconfig.json with TypeScript in node_modules, an ESLint config with ESLint in node_modules, or a Ruff config.", t);
    if (!this.trusted()) return this.trustCard(t);
    const out = v_flex().flex_1().min_h(0);
    if (this.openError) out.child(line(this.openError, t.ansi1));
    if (this.running) out.child(line(`Running ${this.tools.map(tool => tool.source).join(", ")}…`));
    if (!this.result && !this.running) out.child(h_flex().p(12).gap(8).items_center()
      .child(div().flex_1().text_size(12).text_color(t.dim).child("Checks have not run in this folder yet."))
      .child(barButton("vsc-problems-run-first", "Run checks", cx => this.run(cx), t, { primary: true })));
    if (this.result) {
      const r = this.result;
      for (const failure of r.failures) out.child(line(failure, t.ansi1));
      if (this.skipped.length) out.child(line(`Not checked: tsconfig references outside this folder (${this.skipped.map(displayName).join(", ")}).`));
      // "No problems" only when every check ran: a failed check says nothing about its files.
      if (r.errors + r.warnings || !r.failures.length) out.child(line(r.errors + r.warnings ? `${plural(r.errors, "error")}, ${plural(r.warnings, "warning")}` : "No problems"));
      if (r.truncated) out.child(line("Showing the first 1,000 problems."));
      out.child(v_flex().id("vsc-problems-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows(t)));
    }
    out.child(div().id("vsc-problems-untrust").flex_none().px(12).py(8).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .cursor_pointer().hover(s => s.text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.stopRun(cx); setTrusted(this.on, this.folder, false); this.result = null; setShared(COUNT, null); cx.notify(); })
      .child("Stop trusting this folder"));
    return out;
  }

  render(cx) {
    const t = theme();
    const ready = Boolean(this.tools?.length) && this.trusted();
    const actions = [
      ...(this.running ? [iconButton("vsc-problems-stop", "square-stop", "Stop checks", cx => this.stopRun(cx), t)]
        : ready ? [iconButton("vsc-problems-run", "play", "Run checks", cx => this.run(cx), t)] : []),
      ...(this.root && !this.on ? [iconButton("vsc-problems-vscode", "external-link", "Open folder in VS Code", cx => this.vscode(this.root, null, null, cx), t)] : []),
    ];
    return viewCard("vsc-problems", "Problems", actions, v_flex().flex_1().min_h(0).child(this.body(t)), t);
  }
}
