// The live agent tracker, drawn in each pane's header (props { pane, terminal } from Herdr) and in an
// agent's detail window (props { view: "agent", pane }). It turns on by itself for any agent Herdr
// recognizes in a pane: Claude Code, Codex and Gemini CLI get their tasks, context, cost, plan and limits
// from their own session logs (scan.mjs --live); other agents show what Herdr knows about them.
// Panes without an agent get Herdr's usual header: icon, name, folder, status, split / zoom / close.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { panes, focused, layout, exec, hc, home, appHome, theme, run, shared, setShared, props, openOverlay, closeOverlay } from "herdr";
import { geminiScreen } from "./lib/live.js";
import { modelName } from "./lib/usage.js";
import { CHAR, LIMIT_NAMES, HEIGHTS, heightFor, usageRows } from "./lib/fit.js";

// Plans the logs or screens report, for the AI usage panel too: { openai: { plan, at }, google: { plan, limit, at } }.
export const DETECTED_KEY = "ai-usage.detected";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CODEX_PLANS = { plus: "ChatGPT Plus", pro: "ChatGPT Pro", team: "ChatGPT Business", business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu", free: "ChatGPT Free" };
const stop = (_e, cx) => cx.stop_propagation();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// The header's four forms: usage and tasks on one row; the usage row in full words over the tasks row; in
// full words over two rows with the tasks moved up beside the title; or in short labels over two rows, the
// tasks beside the title too. Which one fits is measured from the row's text (about CHAR px a character at
// the header's size) and its bars, against the pane's width.
const BAR = 60, PART = 16, PAD = 24;
// Folded, every header shows its title row alone. Herdr gives all pane headers of a layout one height, so
// folding is for all panes, and each header says in NEED_KEY the height its form needs.
export const FOLD_KEY = "ai-usage.header.folded";
const NEED_KEY = "ai-usage.header.need";
let asked = { px: 0, at: 0 };
const hhmm = (d) => d.toTimeString().slice(0, 5);
const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// Which agent runs in a pane, by what Herdr knows of its program: claude, codex, gemini, another agent, or null.
export function agentKind(p) {
  const id = `${p?.app ?? ""} ${p?.program?.key ?? ""} ${p?.program?.name ?? ""}`.toLowerCase();
  if (/claude/.test(id)) return "claude";
  if (/codex/.test(id)) return "codex";
  if (/gemini/.test(id)) return "gemini";
  return p?.program?.agent || p?.app ? "other" : null;
}

const folder = (cwd) => {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
};

export class AgentHeader {
  constructor(cx, helpers) {
    this.h = helpers;
    this.live = null;
    this.fetching = false;
    this.ticks = 0;
    this.hovered = false;
    this.tick(cx);
    cx.timer.every(3000, (cx) => this.tick(cx));
  }

  me() {
    const pane = props()?.pane;
    return panes().find((p) => p.pane === pane) ?? null;
  }

  // Every 3 s while the agent works, every 15 s otherwise; Gemini's screen every 12 s for its plan and limit.
  tick(cx) {
    this.ticks++;
    const p = this.me(), kind = agentKind(p);
    if (!p || !kind || kind === "other") return;
    const busy = p.status === "working" || props()?.view === "agent";
    if (!this.fetching && (busy || !this.live || this.ticks % 5 === 0) && p.cwd) {
      this.fetching = true;
      cx.spawn(async (cx) => {
        try {
          const r = await exec("node", [`${appHome()}/mods/${this.h.MOD}/scan.mjs`, "--live", kind, p.cwd], { timeout: 15000 });
          if (r.code === 0 && r.stdout) {
            this.live = JSON.parse(r.stdout);
            if (kind === "codex" && this.live?.plan) this.remember("openai", { plan: CODEX_PLANS[this.live.plan] ?? this.live.plan });
          }
        } catch (e) {
          console.log(`${this.h.MOD}: live ${kind}: ${e?.message ?? e}`);
        }
        this.fetching = false;
        cx.notify();
      });
    }
    if (kind === "gemini" && p.terminal && this.ticks % 4 === 1) {
      cx.spawn(async (cx) => {
        try {
          // Only the Tier line and the "% used" line of /stats are kept, never the rest of the screen.
          const r = await hc(["read", p.terminal, "--lines", "120"]);
          const found = geminiScreen(r.stdout ?? "");
          if (found.plan || found.limit) this.remember("google", found);
        } catch { /* the pane went away */ }
        cx.notify();
      });
    }
  }

  remember(provider, found) {
    const all = shared(DETECTED_KEY) ?? {}, prev = all[provider] ?? {};
    const next = { ...prev, ...found, at: Date.now() };
    if (JSON.stringify({ ...prev, at: 0 }) !== JSON.stringify({ ...next, at: 0 })) setShared(DETECTED_KEY, { ...all, [provider]: next });
  }

  // The plan, limits, context and cost to show, from the live session, the tracker snapshot and what was detected.
  facts(kind) {
    const live = this.live ?? {}, snap = live.snapshot, detected = shared(DETECTED_KEY) ?? {};
    const chosen = (provider) => {
      const id = { ...this.h.DEFAULT_PLANS, ...(shared(this.h.PLANS_KEY) ?? {}) }[provider];
      return this.h.PLAN_CHOICES[provider]?.find((c) => c.id === id)?.name ?? null;
    };
    let plan = null, limits = [], cost = null, exact = false;
    if (kind === "claude") {
      plan = snap?.plan?.name ?? this.h.claudePlan(live.planFields)?.name ?? null;
      limits = (snap?.usage?.limits ?? []).map((l) => ({ label: l.kind === "five_hour" ? "5h" : l.kind === "seven_day" ? "Week" : l.kind,
        percent: l.percentUsed, resetsAt: Date.parse(l.resetsAt) }));
      if (snap?.usage?.usd !== undefined) { cost = snap.usage.usd; exact = true; } else cost = live.usd ?? null;
    } else if (kind === "codex") {
      plan = detected.openai?.plan ?? (live.plan ? CODEX_PLANS[live.plan] ?? live.plan : chosen("openai"));
      limits = (live.limits ?? []).map((l) => ({ ...l, label: l.label.replace("-hour limit", "h").replace("Weekly limit", "Week") }));
      cost = live.usd ?? null;
    } else if (kind === "gemini") {
      plan = detected.google?.plan ?? chosen("google");
      const lim = detected.google?.limit;
      if (lim && Date.now() - (detected.google.at ?? 0) < 24 * 3600e3) limits = [{ label: "Day", percent: lim.percent, resetsIn: lim.resetsIn }];
      cost = live.usd ?? null;
    }
    const context = snap?.usage?.contextPercent !== undefined
      ? { percent: snap.usage.contextPercent, tokens: snap.usage.contextTokens, window: snap.usage.contextWindow } : live.context ?? null;
    const tasks = snap?.tasks?.total ? { ...live.tasks, done: snap.tasks.done, total: snap.tasks.total, active: snap.tasks.active ?? live.tasks?.active } : live.tasks;
    const subagents = snap?.agents?.length
      ? snap.agents.map((a) => ({ description: a.description, type: a.type, model: a.model, status: a.status, steps: a.steps, tools: a.tools, tokens: a.tokens, startedAt: a.startedAt, endedAt: a.endedAt }))
      : live.subagents ?? [];
    return { plan, limits, cost, exact, context, tasks, subagents, model: live.model, project: live.project, branch: live.branch };
  }

  render() {
    return props()?.view === "agent" ? this.detail() : this.header();
  }

  button(t, id, icon, onClick, tooltip) {
    return div().id(id).p(3).rounded(4).text_color(t.dim).cursor_pointer().tooltip(tooltip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); onClick(); cx.notify(); })
      .child(icon);
  }

  // A thin bar. Limits and memory warn as they fill (yellow, then red); progress passes `color`, as more is better.
  bar(percent, t, width = 40, color) {
    const p = Math.max(0, Math.min(100, percent ?? 0));
    color ??= p >= 90 ? t.ansi1 : p >= 70 ? t.blocked : t.accent;
    return div().w(width).h(5).flex_none().rounded(3).bg(t.raised).child(div().h_full().rounded(3).bg(color).w(`${p}%`));
  }

  // Row 0, like Herdr's own pane header: icon, name, where, status, and the buttons on hover.
  // The header's form for this pane's width: "wide", "medium" or "narrow".
  form(f) {
    const w = this.width ?? 4000;
    if (!f) return "wide";
    const text = this.usageWords(f, true).join(" ");
    const need = text.length * CHAR + (f.limits.length + 1) * BAR + (f.limits.length + 3) * PART + PAD;
    // One row is measured from the words as shown, and kept until the pane is 40 px narrower, so a changing
    // number never flips the header back and forth.
    const shown = this.usageWords(f, false).join(" ").length * CHAR + (f.limits.length + 1) * BAR + (f.limits.length + 3) * PART + PAD;
    const tasks = (f.tasks?.total ? `Tasks ${f.tasks.done}/${f.tasks.total} ` : "") + (f.subagents.length ? `· ${f.subagents.length} subagents done ` : "");
    const inline = shown + PART + (tasks ? (tasks.length + 2) * CHAR + BAR + 2 * PART : 34 * CHAR);
    this.inline = w >= inline - (this.inline ? 40 : 0);
    if (this.inline) return "inline";
    if (w >= need) return "wide";
    return this.rows(f, true) <= 2 ? "medium" : "narrow";
  }

  // How many rows the usage row wraps onto in this pane, in full words (`wide`) or short labels.
  rows(f, wide) {
    return usageRows(f, this.width ?? 4000, wide);
  }


  // The usage row's words in full, for measuring: at their widest, or (`widest` false) as they read now.
  usageWords(f, widest = true) {
    const words = [`Plan ${f.plan ?? "–"}`];
    for (const l of f.limits) words.push(`${LIMIT_NAMES[l.label] ?? l.label} ${widest ? 100 : Math.round(l.percent)}% · resets ${widest || l.resetsAt - Date.now() >= 24 * 3600e3 ? "Tue 03:00" : "03:00"}`);
    if (f.context) words.push(`Memory ${widest ? 100 : f.context.percent}% · 827k of 1.0M tokens`);
    words.push(widest ? "Cost $000.00 at API price" : `Cost ${f.cost === null ? "–" : this.h.money(f.cost)} at API price`);
    return words;
  }

  titleRow(p, t, kind, extra = null) {
    const prog = p.program;
    const pic = prog?.icon ? (prog.tint ? svg(prog.icon).size(14).flex_none().text_color(t.dim) : image(prog.icon).w(14).h(14).flex_none()) : null;
    const name = ((prog?.agent || prog?.shell) && prog.name) || p.title || prog?.name || "shell";
    const f = kind && kind !== "other" ? this.facts(kind) : null;
    const where = f?.project ? `${f.project}${f.branch || p.branch ? ` · ${f.branch ?? p.branch}` : ""}` : `${folder(p.cwd)}${p.branch ? ` · ${p.branch}` : ""}`;
    const pane = p.pane;
    return h_flex().h(18).gap(8).items_center()
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(220).font_semibold().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(where))
      .when(Boolean(extra), (el) => el.child(extra))
      .when(p.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(p.status === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(this.h.tint(t.blocked, "26"))
        .text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(p.status === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ah-f-${pane}`, svg(`mods/${this.h.MOD}/icons/${shared(FOLD_KEY) ? "unfold" : "fold"}.svg`).size(14),
          () => setShared(FOLD_KEY, !shared(FOLD_KEY)), shared(FOLD_KEY) ? "Show usage and tasks in every pane" : "Fold every pane's header to one row"))
        .child(this.button(t, `ah-r-${pane}`, svg("mods/pane/split-right.svg").size(14), () => run("pane.split", { direction: "right", pane }), "Split right"))
        .child(this.button(t, `ah-d-${pane}`, svg("mods/pane/split-down.svg").size(14), () => run("pane.split", { direction: "down", pane }), "Split down"))
        .child(this.button(t, `ah-z-${pane}`, svg(`mods/pane/${p.zoomed ? "unzoom" : "zoom"}.svg`).size(14), () => run("pane.zoom", { pane }), "Zoom"))
        .child(this.button(t, `ah-x-${pane}`, svg("mods/pane/close.svg").size(14), () => run("pane.close", { pane }), "Close")));
  }

  // Row 1: plan, limits with their reset, memory and cost, the labels in the theme's brown (ansi3). In the
  // same words as Claude Code's band when the pane is wide enough, else short.
  usageRow(f, t, wide = this.form(f) !== "narrow", wrap = this.form(f) !== "wide") {
    const label = (text) => div().flex_none().font_semibold().text_color(t.ansi3).child(text);
    const dim = (text) => div().flex_none().text_color(t.muted).child(text);
    const sep = () => div().flex_none().text_color(t.border).child("│");
    const parts = [h_flex().gap(4).items_center().child(label("Plan")).child(div().truncate().text_color(t.accent).child(f.plan ?? "–"))];
    const now = Date.now();
    for (const l of f.limits) {
      const at = l.resetsAt ? new Date(l.resetsAt) : null;
      const reset = at ? (l.resetsAt - now < 24 * 3600e3 ? hhmm(at) : `${WEEKDAYS[at.getDay()]} ${hhmm(at)}`) : l.resetsIn ? `in ${l.resetsIn}` : "";
      parts.push(h_flex().gap(4).items_center().child(label(wide ? LIMIT_NAMES[l.label] ?? l.label : l.label)).child(this.bar(l.percent, t, wide ? 56 : 40))
        .child(div().flex_none().text_color(t.foreground).child(`${Math.round(l.percent)}%`))
        .when(Boolean(reset), (el) => el.child(dim(wide ? `· resets ${reset}` : `↻${reset}`))));
    }
    if (f.context?.percent !== undefined && f.context?.percent !== null) {
      const of = f.context.tokens && f.context.window ? `· ${kTok(f.context.tokens)} of ${kTok(f.context.window)} tokens` : "";
      parts.push(h_flex().gap(4).items_center().child(label(wide ? "Memory" : "Mem")).child(this.bar(f.context.percent, t, wide ? 56 : 40))
        .child(div().flex_none().text_color(t.foreground).child(`${f.context.percent}%`))
        .when(wide && Boolean(of), (el) => el.child(dim(of))));
    }
    // What the work would cost per token at API list price; on a subscription it is a comparison, not a bill.
    parts.push(h_flex().gap(4).items_center().child(label("Cost"))
      .child(div().flex_none().text_color(t.foreground).child(f.cost === null ? "–" : `${f.exact ? "" : "~"}${this.h.money(f.cost)}`))
      .when(wide && f.cost !== null, (el) => el.child(dim("at API price"))));
    // Wrapped onto as many rows as the pane needs; a separator never starts a row, so each part carries its own.
    const rows = wrap ? this.rows(f, wide) : 1;
    const row = wrap ? h_flex().flex_wrap().h(rows * 17 + (rows - 1)).gap_x(8).gap_y(1).items_center().overflow_hidden()
      : h_flex().h(17).gap(8).items_center().overflow_hidden();
    parts.forEach((part, i) => row.child(i ? h_flex().gap(8).items_center().child(sep()).child(part) : part));
    return row;
  }

  // Opens the window with every task and subagent of this pane's agent.
  openDetail() {
    const pane = props()?.pane;
    openOverlay({ mod: this.h.MOD, kind: "window", key: `agent-${pane}`, width: 560, height: 520, props: { view: "agent", pane } });
  }

  // A small button that says what it opens, so its purpose is plain: "All tasks ›" and the like.
  pill(t, id, children, tooltip) {
    return h_flex().id(id).flex_none().h(17).px(6).gap(4).items_center().rounded(5).cursor_pointer().bg(t.raised)
      .hover((s) => s.bg(t.hover)).tooltip(tooltip)
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.openDetail(); cx.notify(); })
      .children(children);
  }

  // The task list's bar and count alone, for the title row when the usage row takes two: a button that
  // opens every task and subagent.
  tasksBadge(f, t) {
    const tasks = f.tasks ?? { done: 0, total: 0 };
    const label = tasks.total ? [
      div().font_semibold().text_color(t.ansi3).child("Tasks"),
      this.bar((tasks.done / tasks.total) * 100, t, 40, tasks.done === tasks.total ? t.done : t.accent),
      div().text_color(t.foreground).child(`${tasks.done}/${tasks.total}`),
    ] : f.subagents.length ? [div().font_semibold().text_color(t.ansi3).child(`${f.subagents.length} subagents`)] : null;
    if (!label) return null;
    return this.pill(t, `ah-tasks-${props()?.pane}`, [...label, div().text_color(t.muted).child("›")], "Show every task and subagent");
  }

  // Row 2: the task list with its bar and what runs now, and the subagents.
  tasksRow(f, p, t) {
    const tasks = f.tasks ?? { done: 0, total: 0 };
    const running = f.subagents.filter((a) => a.status === "running").length, done = f.subagents.length - running;
    const busy = p.status === "working";
    const mark = busy ? SPINNER[0] : tasks.total && tasks.done === tasks.total ? "✓" : null;
    const row = h_flex().h(17).gap(6).items_center().overflow_hidden()
      .when(Boolean(mark), (el) => el.child(div().w(12).flex_none().text_color(busy ? t.working : t.accent).when(busy, (el) => el.frames(SPINNER, 90)).child(mark)));
    if (tasks.total) {
      row.child(div().flex_none().font_semibold().text_color(t.ansi3).child("Tasks"))
        .child(this.bar((tasks.done / tasks.total) * 100, t, 56, tasks.done === tasks.total ? t.done : t.accent))
        .child(div().flex_none().text_color(t.foreground).child(`${tasks.done}/${tasks.total}`))
        .when(Boolean(tasks.active), (el) => el.child(div().min_w(0).truncate().text_color(t.muted).child(`· now: ${tasks.active}`)));
    } else {
      row.child(div().text_color(t.muted).child(f.model ? `${modelName(f.model)} · no task list yet` : "Waiting for the agent's first reply"));
    }
    if (f.subagents.length) row.child(div().flex_none().text_color(t.muted).child(`· ${running ? `${running} subagent${running === 1 ? "" : "s"} running` : `${done} subagent${done === 1 ? "" : "s"} done`}`));
    if (tasks.total || f.subagents.length) {
      row.child(this.pill(t, `ah-all-${p.pane}`,
        [div().text_color(t.foreground).child(tasks.total ? "All tasks" : "Subagents"), div().text_color(t.muted).child("›")], "Show every task and subagent"));
    }
    return row;
  }

  header() {
    const t = theme(), p = this.me();
    if (!p) return div();
    const kind = agentKind(p);
    // 64 px for an 18 px title row and two 17 px rows, with 3 px around and 1 px between; 44 px for one row, 26 folded.
    const root = v_flex().id(`agent-head-${p.pane}`).size_full().px(10).py(3).gap(1).justify_center().bg(t.background).border_b(1).border_color(t.border)
      .text_size(12).on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) > 16) { this.width = size.width; cx.notify(); } })
      .on_click(() => run("pane.focus", { pane: p.pane }));
    const f = kind && kind !== "other" ? this.facts(kind) : null, form = this.form(f), folded = Boolean(shared(FOLD_KEY));
    this.fit(p, folded ? HEIGHTS.folded : !f || form === "inline" ? HEIGHTS.one : form === "wide" ? HEIGHTS.two : heightFor(this.rows(f, form === "medium")));
    root.child(this.titleRow(p, t, kind, f && (folded || form === "medium" || form === "narrow") ? this.tasksBadge(f, t) : null));
    if (folded) return root;
    if (!kind) return root.child(div().h(18).text_size(11).text_color(t.muted).truncate().child(p.cwd ? folder(p.cwd) : ""));
    if (kind === "other") return root.child(div().h(18).text_size(11).text_color(t.muted).child("Agent · its usage isn't read yet (Claude Code, Codex and Gemini CLI are)"));
    if (form === "inline") {
      return root.child(h_flex().h(17).gap(8).items_center().overflow_hidden()
        .child(this.usageRow(f, t, true, false).flex_none())
        .child(div().flex_none().text_color(t.border).child("│"))
        .child(this.tasksRow(f, p, t).flex_1().min_w(0)));
    }
    if (form !== "wide") return root.child(this.usageRow(f, t));
    return root.child(this.usageRow(f, t)).child(this.tasksRow(f, p, t));
  }

  // Says what height (px) this pane's header needs; the first pane of the shown tab sets the layout's header
  // height to the tallest need of its tab (or the folded height), so no header clips and none is empty.
  fit(p, px) {
    const all = panes(), need = {};
    for (const [id, h] of Object.entries(shared(NEED_KEY) ?? {})) if (all.some((q) => q.pane === id)) need[id] = h;
    if (shared(NEED_KEY)?.[p.pane] !== px || Object.keys(need).length !== Object.keys(shared(NEED_KEY) ?? {}).length) {
      need[p.pane] = px;
      setShared(NEED_KEY, need);
    }
    need[p.pane] = px;
    const tab = focused()?.tab ?? p.tab, shown = all.filter((q) => q.tab === tab);
    if (shown[0]?.pane !== p.pane) return;
    const height = shared(FOLD_KEY) ? HEIGHTS.folded : Math.max(...shown.map((q) => need[q.pane] ?? HEIGHTS.two));
    if (asked.px === height && Date.now() - asked.at < 3000) return;
    const l = layout();
    if (!l || typeof l !== "object") return;
    const tree = JSON.parse(JSON.stringify(l));
    let changed = false;
    const visit = (n) => {
      if (!n || typeof n !== "object") return;
      const header = n.content?.pane?.header;
      if (header?.content?.mod === this.h.MOD && header.height !== height) { header.height = height; changed = true; }
      for (const c of n.children ?? []) visit(c);
    };
    visit(tree);
    if (!changed) return;
    asked = { px: height, at: Date.now() };
    run("layout.set", { layout: tree });
  }

  // The detail window: every task, every subagent, limits, context and cost of this pane's agent.
  detail() {
    const t = theme(), p = this.me(), kind = agentKind(p);
    const close = () => closeOverlay(props()?.overlay);
    const head = h_flex().h(40).px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().font_semibold().child(p ? `${p.program?.name ?? "Agent"} · ${this.facts(kind).project ?? folder(p.cwd)}` : "Agent"))
      .child(this.button(t, "ad-close", div().child("✕"), close, "Close"));
    const box = v_flex().size_full().bg(t.background).text_color(t.foreground).text_size(13).child(head);
    if (!p || !kind || kind === "other") return box.child(div().p(14).text_color(t.muted).child("This pane has no agent whose usage is read."));
    const f = this.facts(kind), now = Date.now();
    const section = (title) => div().pt(12).pb(4).text_size(11).font_bold().text_color(t.foreground).child(title.toUpperCase());
    const body = v_flex().id("ad-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).pb(14)
      .child(section("Usage"))
      .child(this.usageRow(f, t, true))
      .child(div().pt(4).text_size(11).text_color(t.muted).child(
        [f.model ? `Model ${modelName(f.model)}` : null, f.context?.tokens ? `${Math.round(f.context.tokens / 1000)}k of ${Math.round((f.context.window ?? 0) / 1000)}k tokens in memory` : null,
          f.exact ? "cost exact for this session" : "cost estimated at API list price"].filter(Boolean).join(" · ")))
      .child(section(f.tasks?.total ? `Tasks · ${f.tasks.done} of ${f.tasks.total} done` : "Tasks"));
    if (!f.tasks?.items?.length && !f.tasks?.total) body.child(div().text_size(12).text_color(t.muted).child("No task list in this session yet."));
    // As Claude Code lists them: open tasks first, done ones struck through and folded behind "+N completed".
    const items = f.tasks?.items ?? [];
    const open = items.filter((i) => i.status !== "completed"), done = items.filter((i) => i.status === "completed");
    const row = (item) => {
      const isDone = item.status === "completed", now = item.status === "in_progress";
      return h_flex().py(2).gap(8).items_center()
        .child(div().w(14).flex_none().text_color(isDone ? t.accent : now ? t.working : t.muted).child(isDone ? "✓" : now ? "◌" : "☐"))
        .child(div().flex_1().min_w(0).truncate().text_color(isDone ? t.muted : t.foreground).when(isDone, (el) => el.line_through())
          .when(now, (el) => el.font_semibold()).child(item.text));
    };
    for (const item of open) body.child(row(item));
    if (done.length) {
      const shown = this.showDone ? done : done.slice(0, 3);
      for (const item of shown) body.child(row(item));
      if (done.length > 3) body.child(div().id("ad-done").pl(22).py(2).text_size(12).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.showDone = !this.showDone; cx.notify(); })
        .child(this.showDone ? "Show fewer" : `… +${done.length - 3} completed`));
    }
    body.child(section(f.subagents.length ? `Subagents · ${f.subagents.length}` : "Subagents"));
    if (!f.subagents.length) body.child(div().text_size(12).text_color(t.muted).child(kind === "claude" ? "No subagents in this session." : "This agent has no subagents."));
    for (const a of f.subagents.slice().reverse()) {
      const mark = a.status === "running" ? "◌" : a.status === "done" ? "✓" : "✗";
      body.child(v_flex().py(3)
        .child(h_flex().gap(8).items_center()
          .child(div().w(14).text_color(a.status === "running" ? t.working : a.status === "done" ? t.accent : t.ansi1).child(mark))
          .child(div().flex_1().min_w(0).truncate().child(a.description))
          .when(Boolean(a.steps), (el) => el.child(this.bar((a.steps.done / a.steps.total) * 100, t, 48, t.accent)).child(div().text_size(11).child(`${a.steps.done}/${a.steps.total}`))))
        .child(div().pl(22).text_size(11).text_color(t.muted).truncate().child(
          [a.type, a.model ? modelName(a.model) : null, a.tools ? `${a.tools} tool calls` : null,
            a.startedAt ? this.h.duration((a.endedAt ?? now) - a.startedAt) : null].filter(Boolean).join(" · "))));
    }
    return box.child(body);
  }
}
