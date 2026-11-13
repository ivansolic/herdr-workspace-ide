// AI usage: every coding agent on this machine in one panel. Filters for the period and the agent on top;
// subscriptions and their limits; cost at API price with a 30-day chart and what the cache saved; cost by
// project (a click opens the project: its branches, models and sessions); all models grouped by agent;
// recent sessions with their subagents folded in.
// scan.mjs reads the agents' own logs (Claude Code, Gemini CLI, Codex) under Node; Claude's live limits
// and subagent details come from the snapshots Claude Code's `progress-tracker` mod writes.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, panes, exec, hc, home, appHome, readTextFile, writeTextFile, watchFolder, theme, run, shared, setShared, notify, props, openOverlay, closeOverlay } from "herdr";
import * as fs from "fs/promises";
import {
  ranges, totals, projectMonth, modelName, priceOf, providerOf, sumTokens, costOf, mergeDays, sessionDays, dailyCost, cacheSavings, dayOf,
  subtractDays, firstDayOf, weekly, toCsv, budgetWarning, featureSummary, USD, euros, parseEcbRate,
} from "./lib/usage.js";
import { AgentHeader } from "./header.js";

const MOD = "ai-usage";
const VIEWS_ID = "vsc-views";
const KEEP_DAYS = 30;
const PLANS_KEY = "ai-usage.plans";
// Folders attached to a project as one of its features ({ folder project: parent project }).
const LINKS_KEY = "ai-usage.links";
// Subscription cards folded to one line.
const FOLDED_KEY = "ai-usage.folded";
const OTHER_WORK = "Other work";
// Plans and limits the pane header found (see header.js).
const DETECTED_KEY = "ai-usage.detected";
// Monthly budgets per project ({ project: usd }) and the warnings already shown.
const BUDGETS_KEY = "ai-usage.budgets";
const WARNED_KEY = "ai-usage.budget-warned";

// Made-up data for screenshots and previews (see loadDemo); scripts/ai-usage-demo.mjs writes one.
const DEMO_FILE = () => `${appHome()}/data/${MOD}/demo.json`;
const TOP_MODELS = 5, TOP_PROJECTS = 8, MAX_SESSIONS = 12;
const icon = (name) => svg(`mods/${MOD}/icons/${name}.svg`);
const stop = (_e, cx) => cx.stop_propagation();

const PROVIDERS = {
  anthropic: { name: "Claude", agent: "Claude Code", color: (t) => t.ansi3 },
  google: { name: "Gemini", agent: "Gemini CLI", color: (t) => t.ansi4 },
  openai: { name: "Codex", agent: "Codex", color: (t) => t.ansi2 },
};

const RANGES = [["today", "Today"], ["week", "Week"], ["month", "Month"], ["last30", "30 days"]];
const MORE_RANGES = [["last60", "60 days"], ["last180", "6 months"], ["last365", "Year"], ["all", "All time"]];
const RANGE_WORDS = {
  today: "today", week: "this week", month: "this month", last30: "in 30 days",
  last60: "in 60 days", last180: "in 6 months", last365: "in the last year", all: "so far",
};
const RANGE_ROWS = { last60: "Last 60 days", last180: "Last 6 months", last365: "Last year", all: "All time" };

// Plans you pick (Gemini and Codex keep theirs only in memory). Prices per month, list price.
const PLAN_CHOICES = {
  google: [
    { id: "ai-pro", name: "Google AI Pro", usd: 19.99 },
    { id: "ai-ultra", name: "Google AI Ultra", usd: null },
    { id: "free", name: "Free", usd: 0 },
    { id: "api", name: "API key (pay per token)", usd: null },
  ],
  openai: [
    { id: "plus", name: "ChatGPT Plus", usd: 20 },
    { id: "pro", name: "ChatGPT Pro", usd: 200 },
    { id: "api", name: "API key (pay per token)", usd: null },
  ],
};
const DEFAULT_PLANS = { google: "ai-pro", openai: "plus" };

// Claude's plan from its login; seat prices per month, billed monthly.
function claudePlan(p) {
  if (!p) return null;
  const seats = { team_standard: ["Team · Standard seat", 25], team_premium: ["Team · Premium seat", 125] };
  if (seats[p.seatTier]) return { name: seats[p.seatTier][0], usd: seats[p.seatTier][1] };
  const org = p.organizationType ?? "", tier = p.rateLimitTier ?? "";
  if (org.includes("enterprise")) return { name: "Enterprise", usd: null };
  if (tier.includes("max_20x")) return { name: "Max 20x", usd: 200 };
  if (tier.includes("max_5x") || org.includes("max")) return { name: "Max 5x", usd: 100 };
  if (org.includes("pro")) return { name: "Pro", usd: 20 };
  if (org.includes("team")) return { name: "Team", usd: null };
  return null;
}

const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
// The currency amounts show in: dollars, or euros at the ECB rate. Set from shared state on every draw.
const CURRENCY_KEY = "ai-usage.currency";
const ECB_KEY = "ai-usage.ecb";
const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
let FX = USD;
const money = (usd) => {
  if (usd === null || usd === undefined) return "–";
  const v = usd * FX.perUsd;
  return Math.abs(v) >= 100 ? `${FX.symbol}${Math.round(v)}` : `${FX.symbol}${v.toFixed(2)}`;
};
// A price per million tokens, in the shown currency.
const unitPrice = (usd) => `${FX.symbol}${+(usd * FX.perUsd).toFixed(usd * FX.perUsd < 1 ? 3 : 2)}`;
// A light tint of a theme color (#rrggbb plus alpha), for info boxes and status chips.
const tint = (color, alpha = "24") => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color);
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (ms, now) => (dayOf(ms) === dayOf(now) ? hhmm(ms) : `${WEEKDAYS[new Date(ms).getDay()]} ${new Date(ms).getDate()}.${new Date(ms).getMonth() + 1}.`);

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad2(s % 60)}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${pad2(m % 60)}m` : `${Math.floor(h / 24)}d`;
}

function resetText(at, now) {
  if (!at || Number.isNaN(at)) return "";
  const d = new Date(at);
  const time = at - now < 24 * 3600 * 1000 ? hhmm(at) : `${WEEKDAYS[d.getDay()]} ${hhmm(at)}`;
  return `resets ${time} · in ${duration(at - now)}`;
}

const CLAUDE_LIMITS = { five_hour: "5-hour limit", seven_day: "Weekly limit", spend_limit: "Spend limit" };

export default class AiUsage extends View {
  // Shared state, or what a demo file says in its place (see DEMO_FILE).
  sh(key) {
    return this.demo?.shared && key in this.demo.shared ? this.demo.shared[key] : shared(key);
  }

  init(_props, cx) {
    // The same mod draws each pane's header (props.pane) and an agent's detail window (props.view).
    if (props()?.pane || props()?.view === "agent") {
      this.agentView = new AgentHeader(cx, { PROVIDERS, PLAN_CHOICES, DEFAULT_PLANS, PLANS_KEY, claudePlan, money, kTokens, resetText, duration, tint, MOD });
      return;
    }
    this.trackerDir = `${home()}/.claude/progress-tracker`;
    this.snapshots = [];
    this.scan = null;
    this.scanError = null;
    this.scanning = false;
    this.range = "month";
    this.agent = "all";
    this.project = null;
    this.allModels = new Set();
    this.open = new Set();
    this.moreOpen = false;
    this.openFeatures = new Set();
    this.loadRate(cx);
    cx.timer.every(6 * 3600 * 1000, (cx) => this.loadRate(cx));
    // The budget field on a project's page: Enter saves, empty removes the budget.
    this.budgetInput = InputState.new({ placeholder: "Amount, e.g. 150" });
    this.budgetInput.on("submit", (_e, cx) => { this.saveBudget(); cx.notify(); });
    this.loadSnapshots(cx);
    this.runScan(cx);
    this.watchTracker(cx);
    cx.timer.every(60000, (cx) => { this.runScan(cx); this.loadSnapshots(cx); });
    cx.spawn(async () => {
      try {
        await exec("find", [`${this.trackerDir}/sessions`, "-name", "*.json", "-mtime", `+${KEEP_DAYS}`, "-delete"]);
      } catch (e) {
        console.log(`${MOD}: could not remove old snapshots: ${e?.message ?? e}`);
      }
    });
  }

  watchTracker(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(this.trackerDir); } catch { return; }
        this.loadSnapshots(cx);
      }
    });
  }

  runScan(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      if (await this.loadDemo()) { this.scanning = false; cx.notify(); return; }
      try {
        const r = await exec("node", [`${appHome()}/mods/${MOD}/scan.mjs`], { timeout: 180000 });
        if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
        this.scan = JSON.parse(r.stdout);
        this.scanError = null;
        await this.afterScan();
      } catch (e) {
        this.scanError = String(e?.message ?? e).includes("ENOENT") ? "Node.js is needed to read the agents' logs." : `Could not read the logs: ${e?.message ?? e}`;
        console.log(`${MOD}: ${e?.message ?? e}`);
      }
      this.scanning = false;
      cx.notify();
    });
  }

  // Demo mode, for screenshots: a DEMO_FILE in Herdr's data folder replaces the logs, the snapshots and
  // the shared choices with made-up ones, and nothing is warned about. Delete the file to leave it.
  async loadDemo() {
    let demo = null;
    try { demo = JSON.parse((await readTextFile(DEMO_FILE())) ?? "null"); } catch { demo = null; }
    if (!demo?.scan) { this.demo = null; return false; }
    const first = !this.demo;
    this.demo = demo;
    this.scan = demo.scan;
    this.snapshots = demo.snapshots ?? [];
    if (first && demo.view) {
      Object.assign(this, { range: demo.view.range ?? this.range, project: demo.view.project ?? null,
        budgetOpen: Boolean(demo.view.budgetOpen), currencyOpen: Boolean(demo.view.currencyOpen) });
      for (const k of demo.view.openFeatures ?? []) this.openFeatures.add(k);
      for (const k of demo.view.openSessions ?? []) this.open.add(k);
    }
    return true;
  }

  loadSnapshots(cx) {
    if (this.demo) return;
    cx.spawn(async (cx) => {
      try {
        const names = (await fs.readdir(`${this.trackerDir}/sessions`)).filter((n) => n.endsWith(".json"));
        const read = await Promise.all(names.map((n) => readTextFile(`${this.trackerDir}/sessions/${n}`)));
        // Demo mode may have started while this read: its made-up snapshots stay.
        if (this.demo) return;
        this.snapshots = read.map((text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } })
          .filter((s) => s && s.version === 1).sort((a, b) => b.updatedAt - a.updatedAt);
      } catch { if (!this.demo) this.snapshots = []; }
      cx.notify();
    });
  }

  // The ECB's euro reference rate, once a day is enough (it changes on working days).
  loadRate(cx) {
    const have = this.sh(ECB_KEY);
    if (have && Date.now() - (have.fetchedAt ?? 0) < 12 * 3600 * 1000) return;
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(ECB_URL);
        const rate = parseEcbRate(await res.text());
        if (rate) setShared(ECB_KEY, { ...rate, fetchedAt: Date.now() });
      } catch (e) {
        console.log(`${MOD}: could not load the euro rate: ${e?.message ?? e}`);
      }
      cx.notify();
    });
  }

  // Dollars, or euros when chosen and the rate is known.
  currency() {
    const ecb = this.sh(ECB_KEY);
    return this.sh(CURRENCY_KEY) === "EUR" && ecb?.usdPerEur ? euros(ecb.usdPerEur, ecb.date) : USD;
  }

  // ----- data -----

  plans() { return { ...DEFAULT_PLANS, ...(this.sh(PLANS_KEY) ?? {}) }; }

  planFor(provider) {
    if (provider === "anthropic") {
      const snap = this.snapshots[0];
      const detected = claudePlan(this.scan?.claudePlan) ?? (snap?.plan ? { name: snap.plan.name, usd: snap.plan.listUsd ?? null } : null);
      const usd = snap?.planUsd ?? detected?.usd ?? null;
      return detected ? { ...detected, usd, source: snap?.planUsd != null ? "set by you" : "detected", extraUsage: Boolean(this.scan?.claudePlan?.extraUsage) } : null;
    }
    // A plan the pane header found (Codex's login, Gemini's /stats) wins over the one picked here.
    const found = this.sh(DETECTED_KEY)?.[provider]?.plan;
    if (found) {
      const usd = provider === "google" ? (/ultra/i.test(found) ? null : /pro/i.test(found) ? 19.99 : /free|standard/i.test(found) ? 0 : null)
        : /pro/i.test(found) ? 200 : /plus/i.test(found) ? 20 : null;
      return { id: "detected", name: found, usd, source: "detected" };
    }
    const choices = PLAN_CHOICES[provider] ?? [];
    const plan = choices.find((c) => c.id === this.plans()[provider]) ?? choices[0];
    return plan ? { ...plan, source: "chosen" } : null;
  }

  cyclePlan(provider) {
    const choices = PLAN_CHOICES[provider] ?? [];
    const i = choices.findIndex((c) => c.id === this.plans()[provider]);
    setShared(PLANS_KEY, { ...(this.sh(PLANS_KEY) ?? {}), [provider]: choices[(i + 1) % choices.length].id });
  }

  // Agents to show: installed, or with sessions in the logs.
  providers() {
    const used = new Set((this.scan?.sessions ?? []).map((s) => s.provider));
    return Object.keys(PROVIDERS).filter((k) => this.scan?.installed?.[k] || used.has(k));
  }

  shownProviders() { return this.agent === "all" ? this.providers() : [this.agent]; }

  links() { return this.sh(LINKS_KEY) ?? {}; }

  // A session's work cut into { project, feature, days, sub } pieces: a project's git branches are its
  // features, work on no branch is "Other work", and an attached folder is one feature of its parent.
  units(s) {
    const links = this.links(), out = [];
    for (const [name, p] of Object.entries(s.projects ?? {})) {
      const sub = p.sub ?? { days: {}, branches: {} };
      if (links[name]) { out.push({ project: links[name], feature: `${name}/`, days: p.days, sub: sub.days }); continue; }
      let rest = p.days, restSub = sub.days;
      for (const [branch, days] of Object.entries(p.branches ?? {})) {
        out.push({ project: name, feature: branch, days, sub: sub.branches?.[branch] ?? {} });
        rest = subtractDays(rest, days);
        restSub = subtractDays(restSub, sub.branches?.[branch] ?? {});
      }
      if (Object.keys(rest).length) out.push({ project: name, feature: OTHER_WORK, days: rest, sub: restSub });
    }
    return out;
  }

  // Every session's pieces, all agents.
  allPieces() { return (this.scan?.sessions ?? []).flatMap((s) => this.units(s)); }

  budgets() { return this.sh(BUDGETS_KEY) ?? {}; }

  // After each read: a warning for each project past 80% or 100% of its monthly budget.
  async afterScan() {
    if (this.demo) return;
    const now = Date.now(), month = ranges(now).month, budgets = this.budgets();
    const summary = featureSummary(this.allPieces(), now, budgets);
    let warned = this.sh(WARNED_KEY) ?? [];
    for (const [project, budget] of Object.entries(budgets)) {
      const spent = summary[project]?.month ?? 0;
      const w = budgetWarning(spent, budget, warned, `${project}:${month[0].slice(0, 7)}`);
      if (!w) continue;
      warned = [...warned, w.id].slice(-200);
      notify({ title: `${project}: ${Math.round(w.percent)}% of its budget`, level: w.threshold >= 100 ? "error" : "warning",
        body: `${money(spent)} of ${money(budget)} this month at API price.` });
    }
    if (warned !== (this.sh(WARNED_KEY) ?? [])) setShared(WARNED_KEY, warned);
  }

  // Saves pieces as CSV in Downloads for the chosen period and shows the file in Finder.
  exportCsv(pieces, label, cx) {
    const range = ranges(Date.now())[this.range];
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const path = `${home()}/Downloads/ai-usage-${slug}-${this.range}-${range[1]}.csv`;
    cx.spawn(async (cx) => {
      try {
        const before = await readTextFile(path);
        await writeTextFile(path, toCsv(pieces, range, this.currency()), before);
        await exec("open", ["-R", path]);
        notify({ title: "CSV saved", body: path.replace(home(), "~"), level: "success" });
      } catch (e) {
        notify({ title: "Could not save the CSV", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  // Sessions of the chosen agent (and project, on a project's page).
  sessions() {
    return (this.scan?.sessions ?? []).filter((s) => (this.agent === "all" || s.provider === this.agent)
      && (!this.project || this.units(s).some((u) => u.project === this.project)));
  }

  // Days of { model: tokens } for the chosen agent, or for one project (or one session of it).
  days(sessions = this.sessions()) {
    if (!this.project) return sessionDays(sessions);
    const days = {};
    for (const s of sessions) for (const u of this.units(s)) if (u.project === this.project) mergeDays(days, u.days);
    return days;
  }

  // ----- layout -----

  render() {
    if (this.agentView) return this.agentView.render();
    const t = theme(), now = Date.now();
    FX = this.currency();
    const wantsEuro = this.sh(CURRENCY_KEY) === "EUR";
    const header = h_flex().h(42).flex_none().pl(14).pr(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_semibold().child("AI usage"))
      .when(this.scanning, (el) => el.child(div().text_size(11).text_color(t.muted).child("reading logs…")))
      .child(div().id("au-currency").px(8).h(24).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(12).font_semibold()
        .bg(t.raised).text_color(t.foreground).hover((st) => st.bg(t.hover))
        .tooltip("Currency")
        .on_click((_e, cx) => { this.currencyOpen = !this.currencyOpen; cx.notify(); })
        .child(`${wantsEuro ? "€ EUR" : "$ USD"} ${this.currencyOpen ? "▴" : "▾"}`))
      .child(this.iconButton("au-refresh", "refresh", "Read the logs again", (cx) => { this.runScan(cx); this.loadSnapshots(cx); }, t))
      .child(this.iconButton("au-close", "x", "Close panel", () => run("layout.hide", { id: VIEWS_ID }), t));

    let body;
    if (!this.scan) {
      body = div().p(14).text_size(12).text_color(this.scanError ? t.ansi1 : t.muted).child(this.scanError ?? "Reading the agents' logs…");
    } else {
      const content = this.project
        ? [this.projectPage(now, t)]
        : [this.subscriptions(now, t), this.costs(now, t), this.byProject(now, t), this.models(now, t), this.sessionList(now, t)];
      body = v_flex().flex_1().min_h(0)
        .when(Boolean(this.currencyOpen), (el) => el.child(this.currencyMenu(wantsEuro, t)))
        .child(this.filters(t))
        .child(v_flex().id("au-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).pb(14)
          .children(content)
          .child(this.info(`From each agent's own logs on this machine; costs at API list price` +
            `${FX.note ? `, in euros at the ECB reference rate (${FX.note.replace(" (ECB reference rate, ", ", ").replace(/\)$/, "")})` : ""}. ` +
            "Usage figures only, nothing leaves this computer.", t, 14))
          .when(this.sh(CURRENCY_KEY) === "EUR" && FX === USD, (el) => el.child(this.info("Euros show once the ECB rate has loaded; until then amounts are in dollars.", t))));
    }

    return div().size_full().child(
      v_flex().id("ai-usage").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
        .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
        .child(header).child(body));
  }

  // The currency choice, opened from the header's "$ USD ▾".
  currencyMenu(wantsEuro, t) {
    const option = (code, label) => {
      const on = (code === "EUR") === wantsEuro;
      return h_flex().id(`au-currency-${code}`).px(10).h(28).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(on ? t.selected : t.background).hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { setShared(CURRENCY_KEY, code); this.currencyOpen = false; this.loadRate(cx); cx.notify(); })
        .child(div().w(14).text_color(t.foreground).child(on ? "✓" : ""))
        .child(div().flex_1().text_size(12).text_color(t.foreground).child(label));
    };
    return v_flex().flex_none().px(14).py(6).gap(2).border_b(1).border_color(t.border)
      .child(option("USD", "$ US dollar"))
      .child(option("EUR", "€ Euro (ECB reference rate)"));
  }

  // Period and agent, for everything below.
  filters(t) {
    const chip = (id, label, on, onClick, dot) => div().id(id).px(7).h(22).flex().flex_none().items_center().gap(4).rounded(5).cursor_pointer().text_size(11)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .when(Boolean(dot), (el) => el.child(div().size(6).rounded(3).bg(dot)))
      .child(label);
    const providers = this.providers();
    const more = MORE_RANGES.find(([id]) => id === this.range);
    return v_flex().flex_none().px(14).py(8).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(2).children(RANGES.map(([id, label]) => chip(`au-range-${id}`, label, this.range === id, () => { this.range = id; this.moreOpen = false; })))
        .child(chip("au-range-more", `${more ? more[1] : "More"} ${this.moreOpen ? "▴" : "▾"}`, Boolean(more), () => { this.moreOpen = !this.moreOpen; })))
      .when(this.moreOpen, (el) => el.child(h_flex().gap(2).pl(4).children(MORE_RANGES.map(([id, label]) =>
        chip(`au-range-${id}`, label, this.range === id, () => { this.range = id; this.moreOpen = false; })))))
      .when(providers.length > 1, (el) => el.child(h_flex().gap(2)
        .child(chip("au-agent-all", "All agents", this.agent === "all", () => { this.agent = "all"; }))
        .children(providers.map((p) => chip(`au-agent-${p}`, PROVIDERS[p].name, this.agent === p, () => { this.agent = p; }, PROVIDERS[p].color(t))))));
  }

  iconButton(id, name, tooltip, onClick, t) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tooltip)
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(icon(name).size(14));
  }

  // An explanation: a light-blue box with an "i" icon, the same everywhere in the panel. The tint keeps the
  // text at the theme's full foreground color, so it reads in light and dark themes alike.
  info(text, t, top = 6) {
    return h_flex().mt(top).px(8).py(6).gap(8).items_start().rounded(6).bg(tint(t.accent))
      .child(div().size(16).flex_none().rounded(8).bg(t.accent).text_color(t.background).text_size(10).font_bold()
        .flex().items_center().justify_center().child("i"))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground).child(text));
  }

  // Section headings in the theme's foreground, bold: they keep full contrast in light and dark themes.
  section(title, detail, t) {
    return h_flex().pt(16).pb(6).items_center().justify_between()
      .child(div().text_size(11).font_bold().text_color(t.foreground).child(title.toUpperCase()))
      .when(Boolean(detail), (el) => el.child(div().text_size(11).text_color(t.muted).child(detail)));
  }

  // A thin rounded bar; by default the fill turns to the warning, then the error color as it fills up.
  bar(percent, t, color) {
    const p = Math.max(0, Math.min(100, percent));
    const fill = color ?? (p >= 90 ? t.ansi1 : p >= 70 ? t.blocked : t.accent);
    return div().w_full().h(6).rounded(3).bg(t.raised).child(div().h_full().rounded(3).bg(fill).w(`${p}%`));
  }

  meter(label, percent, detail, t) {
    return v_flex().gap(4).pt(6)
      .child(h_flex().justify_between()
        .child(div().text_size(12).child(label))
        .child(div().text_size(12).font_semibold().text_color(percent >= 90 ? t.ansi1 : percent >= 70 ? t.blocked : t.foreground).child(`${Math.round(percent)}%`)))
      .child(this.bar(percent, t))
      .when(Boolean(detail), (el) => el.child(div().text_size(11).text_color(t.muted).child(detail)));
  }

  badge(provider, t) {
    return div().px(6).h(18).flex().flex_none().items_center().rounded(4).text_size(11).font_semibold()
      .bg(PROVIDERS[provider].color(t)).text_color(t.background).child(PROVIDERS[provider].name);
  }

  // ----- subscriptions -----

  limitsFor(provider, now, t) {
    if (provider === "anthropic") {
      const snap = this.snapshots.find((s) => s.usage?.limits?.length);
      if (!snap) return [this.info("Limits show once Claude Code runs with the progress-tracker mod.", t)];
      return snap.usage.limits.map((l) => this.meter(CLAUDE_LIMITS[l.kind] ?? l.kind, l.percentUsed, resetText(Date.parse(l.resetsAt), now), t));
    }
    if (provider === "openai") {
      const l = this.scan.limits?.openai;
      if (!l) return [this.info("Limits show after Codex's next reply.", t)];
      const at = Date.parse(l.at);
      const name = (w) => (w?.window_minutes >= 7 * 24 * 60 ? "Weekly limit" : w?.window_minutes ? `${Math.round(w.window_minutes / 60)}-hour limit` : "Limit");
      const reset = (w) => (w?.resets_at ? w.resets_at * 1000 : w?.resets_in_seconds ? at + w.resets_in_seconds * 1000 : null);
      return [l.primary, l.secondary].filter(Boolean).map((w) => this.meter(name(w), w.used_percent ?? 0, resetText(reset(w), now), t));
    }
    // Gemini: what /stats shows per model, from its chats; its daily limit as /stats last showed it.
    const range = ranges(now)[this.range];
    const g = this.sh(DETECTED_KEY)?.google, seen = g?.at ?? 0;
    const dailyLimit = g?.limit && now - seen < 24 * 3600e3 ? g.limit : null;
    const { byModel } = totals(this.days(this.sessions().filter((s) => s.provider === "google")), range);
    const rows = Object.entries(byModel).sort((a, b) => b[1].tokens.requests - a[1].tokens.requests);
    const most = Math.max(1, ...rows.map(([, v]) => v.tokens.requests));
    return [
      ...rows.map(([model, v]) => {
        const input = v.tokens.input + v.tokens.cacheRead;
        return v_flex().gap(3).pt(6)
          .child(h_flex().justify_between().child(div().text_size(12).child(modelName(model)))
            .child(div().text_size(12).font_semibold().child(`${v.tokens.requests} requests`)))
          .child(this.bar((v.tokens.requests / most) * 100, t, PROVIDERS.google.color(t)))
          .child(div().text_size(11).text_color(t.muted).child(
            `${kTokens(sumTokens(v.tokens))} tokens · ${input ? Math.round((v.tokens.cacheRead / input) * 100) : 0}% from cache`));
      }),
      ...(rows.length ? [] : [div().pt(4).text_size(11).text_color(t.muted).child(`No Gemini replies ${RANGE_WORDS[this.range]}.`)]),
      ...(dailyLimit ? [this.meter("Daily limit", dailyLimit.percent,
        `${dailyLimit.resetsIn ? `resets in ${dailyLimit.resetsIn} · ` : ""}as /stats showed it ${duration(now - seen)} ago`, t)] : []),
      this.info(dailyLimit ? "Gemini keeps its quota only while it runs; this is what /stats last showed in a Gemini pane."
        : "Gemini keeps its quota only while it runs. Run /stats in Gemini inside Herdr and the plan and daily limit show here.", t),
    ];
  }

  // A folded card's one line: the plan and its limits, or Gemini's requests in the period.
  cardSummary(provider, plan, now) {
    const parts = [plan?.name ?? "Plan not detected"];
    if (provider === "anthropic") {
      const snap = this.snapshots.find((s) => s.usage?.limits?.length);
      for (const l of snap?.usage?.limits ?? []) parts.push(`${l.kind === "five_hour" ? "5h" : l.kind === "seven_day" ? "week" : l.kind} ${Math.round(l.percentUsed)}%`);
    } else if (provider === "openai") {
      const l = this.scan.limits?.openai;
      for (const w of [l?.primary, l?.secondary].filter(Boolean)) parts.push(`${w.window_minutes >= 10080 ? "week" : `${Math.round(w.window_minutes / 60)}h`} ${Math.round(w.used_percent ?? 0)}%`);
    } else {
      const { byModel } = totals(this.days(this.sessions().filter((s) => s.provider === "google")), ranges(now)[this.range]);
      parts.push(`${Object.values(byModel).reduce((n, v) => n + v.tokens.requests, 0)} requests ${RANGE_WORDS[this.range]}`);
    }
    return parts.join(" · ");
  }

  subscriptions(now, t) {
    const month = ranges(now).month;
    return v_flex().child(this.section("Subscriptions", null, t)).children(this.shownProviders().map((provider) => {
      const plan = this.planFor(provider);
      const days = sessionDays((this.scan.sessions ?? []).filter((s) => s.provider === provider));
      const projected = projectMonth(totals(days, month).usd, now);
      const chosen = provider !== "anthropic" && plan?.source === "chosen";
      const verdict = !plan || plan.usd === null ? null
        : projected === 0 ? { text: `No ${PROVIDERS[provider].agent} use this month yet`, color: t.dim }
          : projected > plan.usd ? { text: `Subscription saves ~${money(projected - plan.usd)} this month`, color: t.accent }
            : { text: `API price ~${money(projected)} this month, under the ${money(plan.usd)} plan`, color: t.blocked };
      const folded = (this.sh(FOLDED_KEY) ?? []).includes(provider);
      const toggle = () => {
        const list = this.sh(FOLDED_KEY) ?? [];
        setShared(FOLDED_KEY, folded ? list.filter((p) => p !== provider) : [...list, provider]);
      };
      if (folded) {
        return h_flex().id(`au-card-${provider}`).mb(8).px(10).py(8).gap(8).items_center().rounded(8).border_1().border_color(t.border).cursor_pointer()
          .hover((st) => st.bg(t.hover)).tooltip("Show details").on_click((_e, cx) => { toggle(); cx.notify(); })
          .child(this.badge(provider, t))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(this.cardSummary(provider, plan, now)))
          .child(div().text_color(t.muted).child("▸"));
      }
      return v_flex().mb(8).p(10).gap(4).rounded(8).border_1().border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().id(`au-fold-${provider}`).text_color(t.muted).cursor_pointer().tooltip("Fold to one line")
            .on_click((_e, cx) => { toggle(); cx.notify(); }).child("▾"))
          .child(this.badge(provider, t))
          .child(div().id(`au-plan-${provider}`).flex_1().min_w(0).truncate().font_semibold()
            .when(chosen, (el) => el.cursor_pointer().tooltip("Click to change the plan").hover((s) => s.text_color(t.accent))
              .on_click((_e, cx) => { this.cyclePlan(provider); cx.notify(); }))
            .child(plan ? `${plan.name}${chosen ? " ▾" : ""}` : "Plan not detected"))
          .child(div().text_size(11).text_color(t.muted).child(plan?.usd != null ? `${money(plan.usd)}/mo · ${plan.source}` : plan?.source ?? "")))
        .when(Boolean(plan?.extraUsage), (el) => el.child(this.info("Extra usage is on: past your limits, work goes on and is billed at API price.", t, 2)))
        .children(this.limitsFor(provider, now, t))
        .when(Boolean(verdict), (el) => el.child(h_flex().pt(6).gap(6).items_center()
          .child(div().size(7).rounded(4).flex_none().bg(verdict.color)).child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(verdict.text))));
    }));
  }

  // ----- cost -----

  // Today / Week / Month / Projected / 30 days, a 30-day chart by agent, and the cache's savings.
  costSummary(days, now, t) {
    const r = ranges(now);
    const per = (range) => {
      const parts = {};
      for (const [model, v] of Object.entries(totals(days, range).byModel)) {
        const p = providerOf(model);
        parts[p] = (parts[p] ?? 0) + (v.usd ?? 0);
      }
      return parts;
    };
    const month = per(r.month);
    const projected = Object.fromEntries(Object.entries(month).map(([p, usd]) => [p, projectMonth(usd, now)]));
    const rows = [["Today", per(r.today), "today"], ["This week", per(r.week), "week"], ["This month", month, "month"],
      ["Month projected", projected, null], ["Last 30 days", per(r.last30), "last30"]];
    if (RANGE_ROWS[this.range]) rows.push([RANGE_ROWS[this.range], per(r[this.range]), this.range]);
    const multi = this.shownProviders().length > 1;
    return v_flex()
      .children(rows.map(([label, parts, id]) => {
        const total = Object.values(parts).reduce((s, v) => s + v, 0);
        const on = id === this.range, used = Object.entries(parts).filter(([, v]) => v > 0);
        return v_flex().py(3).gap(2)
          .child(h_flex().justify_between()
            .child(div().text_color(on || !id ? t.foreground : t.muted).when(on || !id, (el) => el.font_semibold()).child(label))
            .child(div().font_semibold().child(money(total))))
          .when(multi && used.length > 0, (el) => el.child(h_flex().gap(10).children(used.map(([p, v]) =>
            h_flex().gap(4).items_center().child(div().size(6).rounded(3).bg(PROVIDERS[p]?.color(t) ?? t.dim))
              .child(div().text_size(11).text_color(t.muted).child(`${PROVIDERS[p]?.name ?? p} ${money(v)}`))))));
      }))
      .child(this.chart(days, now, t))
      .child(h_flex().pt(6).gap(6).items_center()
        .child(div().size(7).rounded(4).flex_none().bg(t.accent))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(
          `Prompt cache saved ~${money(cacheSavings(days, r[this.range]))} ${RANGE_WORDS[this.range]}`)));
  }

  // Cost over the chosen period (at least 30 days), stacked by agent: a column a day, or a week when longer.
  chart(days, now, t) {
    const r = ranges(now), long = Boolean(RANGE_ROWS[this.range]);
    const span = !long ? r.last30 : this.range === "all" ? [firstDayOf(days) ?? r.last30[0], r.all[1]] : r[this.range];
    const daily = dailyCost(days, span);
    const series = daily.length > 62 ? weekly(daily) : daily;
    const max = Math.max(0.01, ...series.map((d) => Object.values(d.byProvider).reduce((s, v) => s + v, 0)));
    const HEIGHT = 56;
    const peak = series.reduce((best, d) => {
      const total = Object.values(d.byProvider).reduce((s, v) => s + v, 0);
      return total > best.total ? { day: d.day, total } : best;
    }, { day: null, total: 0 });
    return v_flex().pt(10).gap(4)
      .child(h_flex().h(HEIGHT).items_end().gap(2).children(series.map((d) => {
        const stack = Object.entries(d.byProvider).sort();
        const total = stack.reduce((s, [, v]) => s + v, 0);
        return v_flex().id(`au-day-${d.day}`).flex_1().h_full().justify_end().tooltip(`${d.day}: ${money(total)}`)
          .when(total === 0, (el) => el.child(div().h(2).rounded(1).bg(t.raised)))
          .children(stack.map(([p, v]) => div().w_full().h(Math.max(1, (v / max) * HEIGHT)).bg(PROVIDERS[p]?.color(t) ?? t.dim)));
      })))
      .child(h_flex().justify_between().text_size(10).text_color(t.muted)
        .child(div().child(long ? `${span[0].slice(5).replace("-", ".")}${series !== daily ? " · by week" : ""}` : "30 days ago"))
        .when(peak.total > 0, (el) => el.child(div().child(`peak ${money(peak.total)} on ${peak.day.slice(5).replace("-", ".")}`)))
        .child(div().child("today")));
  }

  costs(now, t) {
    return v_flex().child(this.section("Cost", "at API price", t)).child(this.costSummary(this.days(), now, t));
  }

  // ----- projects -----

  projectTotals(range) {
    const out = {};
    for (const s of this.sessions()) {
      const seen = new Set();
      for (const u of this.units(s)) {
        const usd = totals(u.days, range).usd;
        if (usd <= 0) continue;
        const prev = out[u.project] ?? { usd: 0, sessions: 0, providers: new Set(), features: new Set() };
        prev.usd += usd;
        if (!seen.has(u.project)) { prev.sessions++; seen.add(u.project); }
        prev.providers.add(s.provider);
        if (u.feature !== OTHER_WORK) prev.features.add(u.feature);
        out[u.project] = prev;
      }
    }
    return Object.entries(out).sort((a, b) => b[1].usd - a[1].usd);
  }

  byProject(now, t) {
    const list = this.projectTotals(ranges(now)[this.range]);
    const total = list.reduce((s, [, v]) => s + v.usd, 0) || 1;
    return v_flex()
      .child(this.section("By project", RANGE_WORDS[this.range], t))
      .when(list.length === 0, (el) => el.child(div().text_size(12).text_color(t.muted).child(`No project work ${RANGE_WORDS[this.range]}.`)))
      .children(list.slice(0, TOP_PROJECTS).map(([name, v]) => v_flex().id(`au-project-${name}`).px(8).py(5).gap(3).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip("Open this project").on_click((_e, cx) => { this.project = name; cx.notify(); })
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(name))
          .child(div().text_size(11).text_color(t.muted).child(`${Math.round((v.usd / total) * 100)}%`))
          .child(div().w(56).text_right().child(money(v.usd)))
          .when(Boolean(this.budgets()[name]), (el) => el.child(this.budgetDot(name, t)))
          .child(div().text_color(t.muted).child("›")))
        .child(this.bar((v.usd / total) * 100, t, t.accent))
        .child(div().text_size(11).text_color(t.muted).child(
          [`${v.sessions} session${v.sessions === 1 ? "" : "s"}`, v.features.size ? `${v.features.size} feature${v.features.size === 1 ? "" : "s"}` : null,
            [...v.providers].map((p) => PROVIDERS[p]?.name ?? p).join(", ")].filter(Boolean).join(" · ")))))
      .when(list.length > TOP_PROJECTS, (el) => el.child(div().pt(2).text_size(11).text_color(t.muted)
        .child(`and ${list.length - TOP_PROJECTS} more, ${money(list.slice(TOP_PROJECTS).reduce((s, [, v]) => s + v.usd, 0))}`)));
  }

  // A model's line, the same everywhere: "Opus 5.5 · 97 requests · 5.8M tokens" and the cost on the right.
  modelLine(model, tokens, usd, t, indent = 0) {
    return h_flex().pl(indent).gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
        .child(`${modelName(model)} · ${tokens.requests ?? 0} requests · ${kTokens(sumTokens(tokens))} tokens`))
      .child(div().text_size(11).child(usd === null ? "no price" : `~${money(usd)}`));
  }

  // A dot by a project with a budget: green under 80% of it this month, then the warning and error colors.
  budgetDot(name, t) {
    const budget = this.budgets()[name], p = (this.projectMonth(name) / budget) * 100;
    return div().size(7).rounded(4).flex_none().tooltip(`${Math.round(p)}% of the ${money(budget)} budget this month`)
      .bg(p >= 100 ? t.ansi1 : p >= 80 ? t.blocked : t.accent);
  }

  // A project's cost this month, all agents.
  projectMonth(name) {
    return this.allPieces().filter((u) => u.project === name).reduce((s, u) => s + totals(u.days, ranges(Date.now()).month).usd, 0);
  }

  // The whole project's total as a chip: brown with no budget, else green, yellow or red by how much of
  // this month's budget is spent. The words say the status too, so it never rests on color alone, and the
  // text keeps the theme's foreground for contrast; the color tints the box, its border and the dot.
  projectChip(name, periodUsd, soFar, now, t) {
    const budget = this.budgets()[name] ?? null;
    const month = this.projectMonth(name), p = budget ? (month / budget) * 100 : null;
    const [color, status] = p === null ? [t.ansi3, "no budget set"]
      : p >= 100 ? [t.ansi1, `over budget · ${Math.round(p)}% of ${money(budget)}`]
        : p >= 70 ? [t.blocked, `near budget · ${Math.round(p)}% of ${money(budget)}`]
          : [t.ansi2, `on budget · ${Math.round(p)}% of ${money(budget)}`];
    return v_flex().mb(6).px(10).py(8).gap(2).rounded(8).bg(tint(color)).border_1().border_color(tint(color, "88"))
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded(4).flex_none().bg(color))
        .child(div().flex_1().font_bold().child("Whole project"))
        .child(div().font_bold().child(money(periodUsd))))
      .child(div().pl(16).text_size(11).text_color(t.foreground).child(
        `${RANGE_WORDS[this.range]} · ${money(soFar)} so far · ${money(month)} this month · ${status}`));
  }

  // One project: total so far, cost over time, its features (branches and attached folders) down to agents,
  // models and subagents, then its models and sessions.
  projectPage(now, t) {
    const name = this.project, r = ranges(now), range = r[this.range];
    const sessions = this.sessions(), days = this.days(sessions), links = this.links();
    const features = {};
    for (const s of sessions) for (const u of this.units(s)) {
      if (u.project !== name) continue;
      const f = (features[u.feature] ??= { days: {}, sub: {}, sessions: new Set() });
      mergeDays(f.days, u.days);
      mergeDays(f.sub, u.sub);
      f.sessions.add(s.id);
    }
    const rows = Object.entries(features).map(([feature, f]) => ({ feature, ...f, now: totals(f.days, range), all: totals(f.days, r.all) }))
      .filter((f) => f.all.usd > 0).sort((a, b) => b.now.usd - a.now.usd || b.all.usd - a.all.usd);
    const max = Math.max(0.01, ...rows.map((f) => f.now.usd));
    const soFar = totals(days, r.all).usd, since = firstDayOf(days);
    const others = this.projectTotals(r.all).map(([n]) => n).filter((n) => n !== name && !links[n]);

    const page = v_flex()
      .child(h_flex().id("au-back").pt(12).gap(6).items_center().cursor_pointer().text_size(12).text_color(t.muted)
        .hover((st) => st.text_color(t.foreground)).on_click((_e, cx) => { this.project = null; this.attachOpen = false; cx.notify(); })
        .child("‹ All projects"))
      .child(h_flex().pt(6).items_end().justify_between()
        .child(div().text_size(16).font_semibold().child(name))
        .child(v_flex().items_end()
          .child(div().text_size(16).font_semibold().child(money(soFar)))
          .child(div().text_size(11).text_color(t.muted).child(since ? `total since ${since.slice(8)}.${since.slice(5, 7)}.` : "total so far"))))
      .child(div().text_size(11).text_color(t.muted).child(
        `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${rows.length} feature${rows.length === 1 ? "" : "s"}`))
      .child(div().id("au-attach").pt(4).text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.attachOpen = !this.attachOpen; cx.notify(); })
        .child(`Move into another project ${this.attachOpen ? "▴" : "▾"}`))
      .when(Boolean(this.attachOpen), (el) => el.child(this.info(
        `Projects are found by folder. If ${name} is really part of another project (its code lives elsewhere), move it ` +
        `there: it then shows as one feature of that project, and "Move out" on that feature undoes it.`, t)))
      .when(Boolean(this.attachOpen), (el) => el.child(h_flex().flex_wrap().gap(4).pt(4).children(others.slice(0, 12).map((n) =>
        div().id(`au-attach-${n}`).px(7).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(11).bg(t.raised).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => {
            setShared(LINKS_KEY, { ...this.links(), [name]: n });
            this.project = n;
            this.attachOpen = false;
            this.openFeatures.add(`${n}:${name}/`);
            notify({ title: `${name} moved into ${n}`, body: `It is now a feature of ${n}. "Move out" on it undoes this.`, level: "info" });
            cx.notify();
          })
          .child(n)))))
      .child(this.budgetBlock(name, days, now, t))
      .child(h_flex().pt(8).gap(6)
        .child(this.textButton("au-export-project", `Export CSV (${RANGE_WORDS[this.range]})`, (cx) =>
          this.exportCsv(sessions.flatMap((s) => this.units(s)).filter((u) => u.project === name), name, cx), t)))
      .child(this.section("Cost", "at API price", t))
      .child(this.costSummary(days, now, t))
      .child(this.section("Features", RANGE_WORDS[this.range], t))
      .child(this.projectChip(name, totals(days, range).usd, soFar, now, t));
    if (!rows.length) page.child(div().text_size(12).text_color(t.muted).child("No work recorded for this project."));
    for (const f of rows) {
      const key = `${name}:${f.feature}`, isOpen = this.openFeatures.has(key);
      const linked = f.feature.endsWith("/") ? f.feature.slice(0, -1) : null;
      const label = linked ? `${linked} (folder)` : f.feature;
      page.child(v_flex().id(`au-feature-${key}`).px(8).py(5).gap(3).rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { isOpen ? this.openFeatures.delete(key) : this.openFeatures.add(key); cx.notify(); })
        .child(h_flex().gap(6).items_center()
          .child(div().text_color(t.muted).child(isOpen ? "▾" : "▸"))
          .child(div().flex_1().min_w(0).truncate().font_semibold().when(f.feature === OTHER_WORK, (el) => el.text_color(t.muted)).child(label))
          .child(div().text_size(11).text_color(t.muted).child(`${Math.round((f.now.usd / (totals(days, range).usd || 1)) * 100)}%`))
          .child(div().w(60).text_right().child(money(f.now.usd))))
        .child(this.bar((f.now.usd / max) * 100, t, t.accent))
        .child(div().text_size(11).text_color(t.muted).child(
          `${f.sessions.size} session${f.sessions.size === 1 ? "" : "s"} · total ${money(f.all.usd)}`)));
      if (isOpen) page.child(this.featureLayers(f, range, t, linked, name, sessions));
    }
    return page
      .child(this.models(now, t, days))
      .child(this.sessionList(now, t, sessions));
  }

  textButton(id, label, onClick, t) {
    return div().id(id).px(8).h(24).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(11)
      .bg(t.raised).hover((st) => st.bg(t.hover)).on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
  }

  // Saves what the budget field holds for the open project: a positive amount, or nothing to remove it.
  saveBudget() {
    // Budgets are kept in dollars; the field takes the shown currency.
    const fx = this.currency(), text = String(this.budgetInput.value()).replace(/[$€,\s]/g, "");
    const amount = Number(text), b = { ...this.budgets() };
    if (!text) delete b[this.project];
    else if (Number.isFinite(amount) && amount > 0) b[this.project] = Math.round((amount / fx.perUsd) * 100) / 100;
    else { this.budgetError = `Type an amount in ${fx.code === "EUR" ? "euros" : "dollars"}, e.g. 150`; return; }
    setShared(BUDGETS_KEY, b);
    this.budgetError = null;
    this.budgetOpen = false;
  }

  // The project's monthly budget: spent this month against it, and a field to type it.
  budgetBlock(name, days, now, t) {
    const budget = this.budgets()[name] ?? null, spent = totals(days, ranges(now).month).usd;
    const box = v_flex().pt(10).gap(4);
    if (budget) box.child(this.meter("Monthly budget", (spent / budget) * 100, `${money(spent)} of ${money(budget)} this month`, t));
    box.child(div().id("au-budget").text_size(11).text_color(t.accent).cursor_pointer()
      .on_click((_e, cx) => {
        this.budgetOpen = !this.budgetOpen;
        this.budgetError = null;
        if (this.budgetOpen) this.budgetInput.set_value(budget ? String(Math.round(budget * FX.perUsd * 100) / 100) : "");
        cx.notify();
      })
      .child(`${budget ? "Change the monthly budget" : "Set a monthly budget"} ${this.budgetOpen ? "▴" : "▾"}`));
    if (!this.budgetOpen) return box;
    return box
      .child(h_flex().gap(6).items_center()
        .child(div().text_color(t.muted).child(FX.symbol))
        .child(div().id("au-budget-field").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.border)
          .cursor_text().on_mouse_down("left", stop).child(Input.new(this.budgetInput).h_full().text_size(12).text_color(t.foreground)))
        .child(this.textButton("au-budget-save", "Save", () => this.saveBudget(), t)))
      .child(this.budgetError
        ? div().text_size(11).font_semibold().text_color(t.ansi1).child(this.budgetError)
        : this.info(`Per month, at API price, in ${FX.code === "EUR" ? "euros" : "dollars"}. Enter saves; leave it empty and save to ` +
          "remove the budget. You get a notice at 80% and at 100%.", t));
  }

  // Inside a feature: each agent with its models, then the subagents' share.
  featureLayers(f, range, t, linked, project, sessions) {
    const box = v_flex().pl(22).pb(8).gap(3);
    const { byModel } = f.now, groups = {};
    for (const [model, v] of Object.entries(byModel)) (groups[providerOf(model)] ??= []).push([model, v]);
    for (const [provider, list] of Object.entries(groups)) {
      box.child(h_flex().pt(4).gap(6).items_center()
        .child(div().size(6).rounded(3).bg(PROVIDERS[provider]?.color(t) ?? t.dim))
        .child(div().flex_1().text_size(11).font_semibold().child(PROVIDERS[provider]?.agent ?? provider))
        .child(div().text_size(11).child(money(list.reduce((s, [, v]) => s + (v.usd ?? 0), 0)))));
      box.children(list.sort((a, b) => (b[1].usd ?? 0) - (a[1].usd ?? 0)).map(([model, v]) => this.modelLine(model, v.tokens, v.usd, t, 12)));
    }
    const sub = totals(f.sub, range);
    if (sub.usd > 0) {
      box.child(h_flex().pt(4).gap(6).items_center()
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("of which subagents"))
        .child(div().text_size(11).child(money(sub.usd))));
      box.children(Object.entries(sub.byModel).map(([model, v]) => this.modelLine(model, v.tokens, v.usd, t, 12)));
    }
    if (!Object.keys(groups).length) box.child(div().text_size(11).text_color(t.muted).child(`No work ${RANGE_WORDS[this.range]}.`));
    box.child(div().pt(4).child(this.textButton(`au-export-${project}-${f.feature}`, "Export this feature as CSV", (cx) =>
      this.exportCsv(sessions.flatMap((s) => this.units(s)).filter((u) => u.project === project && u.feature === f.feature),
        `${project}-${linked ?? f.feature}`, cx), t)));
    if (linked) box.child(div().id(`au-detach-${linked}`).pt(4).text_size(11).text_color(t.accent).cursor_pointer()
      .on_click((_e, cx) => { const l = { ...this.links() }; delete l[linked]; setShared(LINKS_KEY, l); cx.notify(); })
      .child(`Move ${linked} out of ${project} (back to its own project)`));
    return box;
  }

  // ----- models -----

  // All models of the shown agents, grouped by agent: the first five of each, the rest behind "Show all".
  models(now, t, days = this.days()) {
    const range = ranges(now)[this.range];
    const { byModel, usd } = totals(days, range);
    const groups = {};
    for (const [model, v] of Object.entries(byModel)) (groups[providerOf(model)] ??= []).push({ model, ...v });
    const total = usd || 1;
    const box = v_flex().child(this.section("Models", RANGE_WORDS[this.range], t));
    if (!Object.keys(groups).length) return box.child(div().text_size(12).text_color(t.muted).child(`No model use ${RANGE_WORDS[this.range]}.`));
    const multi = Object.keys(groups).length > 1;
    for (const provider of Object.keys(PROVIDERS).concat("other").filter((p) => groups[p])) {
      const rows = groups[provider].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || sumTokens(b.tokens) - sumTokens(a.tokens));
      const all = this.allModels.has(provider), shown = all ? rows : rows.slice(0, TOP_MODELS);
      if (multi) box.child(h_flex().pt(4).pb(2).gap(6).items_center()
        .child(div().size(6).rounded(3).bg(PROVIDERS[provider]?.color(t) ?? t.dim))
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(PROVIDERS[provider]?.name ?? "Other"))
        .child(div().text_size(11).text_color(t.muted).child(money(rows.reduce((s, r) => s + (r.usd ?? 0), 0)))));
      box.children(shown.map((row) => {
        const p = priceOf(row.model), share = row.usd === null ? 0 : (row.usd / total) * 100;
        return v_flex().gap(4).pb(10)
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).truncate().font_semibold().child(modelName(row.model)))
            .child(div().text_size(11).text_color(t.muted).child(row.usd === null ? "" : `${Math.round(share)}%`))
            .child(div().w(60).text_right().child(row.usd === null ? "no price" : money(row.usd))))
          .child(this.bar(share, t, PROVIDERS[provider]?.color(t)))
          .child(div().text_size(11).text_color(t.muted).child(
            `${row.tokens.requests} requests · ${kTokens(sumTokens(row.tokens))} tokens · ${kTokens(row.tokens.output)} out` +
            (p ? ` · ${unitPrice(p[3])}/${unitPrice(p[4])} per 1M` : "")));
      }));
      if (rows.length > TOP_MODELS) box.child(div().id(`au-models-${provider}`).pb(8).text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { all ? this.allModels.delete(provider) : this.allModels.add(provider); cx.notify(); })
        .child(all ? "Show fewer" : `Show all ${rows.length}`));
    }
    return box;
  }

  // ----- sessions -----

  // The herdr agent running a Claude session: a Claude Code terminal in the session's folder.
  agentFor(cwd) {
    if (!cwd) return null;
    const cwdOf = new Map(panes().map((p) => [p.pane, p.cwd]));
    return agents().find((a) => a.app === "claude-code" && cwdOf.get(a.pane) === cwd) ?? null;
  }

  sessionList(now, t, sessions = this.sessions()) {
    const [from] = ranges(now)[this.range];
    const recent = sessions.filter((s) => dayOf(Date.parse(s.last)) >= from).slice(0, MAX_SESSIONS);
    const statusColor = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle, unknown: t.unknown };
    return v_flex()
      .child(this.section("Sessions", RANGE_WORDS[this.range], t))
      .when(recent.length === 0, (el) => el.child(div().text_size(12).text_color(t.muted).child(`No session ${RANGE_WORDS[this.range]}.`)))
      .children(recent.map((s) => {
        const snap = s.provider === "anthropic" ? this.snapshots.find((x) => `anthropic:${x.sessionId}` === s.id) : null;
        const agent = this.agentFor(snap?.cwd);
        const days = this.project ? this.units(s).filter((u) => u.project === this.project).reduce((d, u) => mergeDays(d, u.days), {}) : s.days;
        const own = totals(days, ranges(now)[this.range]);
        const sub = s.subagents?.count ? totals(s.subagents.days, ranges(now)[this.range]) : null;
        const models = Object.keys(own.byModel).map(modelName).join(", ");
        const facts = [PROVIDERS[s.provider]?.agent, models, `~${money(own.usd)}`,
          snap?.usage?.contextPercent !== undefined ? `memory ${snap.usage.contextPercent}%` : null,
          snap?.tasks?.total ? `tasks ${snap.tasks.done}/${snap.tasks.total}` : null].filter(Boolean).join(" · ");
        const isOpen = this.open.has(s.id);
        return v_flex().px(8).py(5).gap(2).rounded(6)
          .child(h_flex().id(`au-session-${s.id}`).gap(8).items_center()
            .when(Boolean(agent), (el) => el.cursor_pointer().tooltip("Go to this agent").on_click(() => run("agent.focus", { terminal: agent.address })))
            .child(div().size(8).rounded(4).flex_none().bg(agent ? statusColor[agent.status] ?? t.dim : PROVIDERS[s.provider]?.color(t) ?? t.dim))
            .child(div().flex_1().min_w(0).truncate().font_semibold().child(s.project ?? PROVIDERS[s.provider]?.agent ?? s.provider))
            .child(div().text_size(11).text_color(t.muted).child(agent ? agent.status : when(Date.parse(s.last), now))))
          .child(div().pl(16).text_size(11).text_color(t.muted).truncate().child(facts))
          .when(Boolean(s.branch), (el) => el.child(div().pl(16).text_size(11).text_color(t.muted).truncate().child(`⎇ ${s.branch}`)))
          .when(Boolean(sub && sub.usd > 0), (el) => el
            .child(div().id(`au-subs-${s.id}`).pl(16).text_size(11).text_color(t.accent).cursor_pointer()
              .on_click((_e, cx) => { isOpen ? this.open.delete(s.id) : this.open.add(s.id); cx.notify(); })
              .child(`${isOpen ? "▾" : "▸"} ${s.subagents.count} subagent${s.subagents.count === 1 ? "" : "s"} · ` +
                `${kTokens(Object.values(sub.byModel).reduce((n, v) => n + sumTokens(v.tokens), 0))} tokens · ~${money(sub.usd)}`))
            .when(isOpen, (el) => el.children(this.subagentRows(snap, sub, now, t))));
      }));
  }

  // A session's subagents, each with its cost on the right: named rows from the progress tracker when it
  // saw them, else one line per model in the same form as everywhere else.
  subagentRows(snap, sub, now, t) {
    const named = (snap?.agents ?? []).slice().sort((a, b) => b.startedAt - a.startedAt);
    if (!named.length) return Object.entries(sub.byModel).map(([model, v]) => this.modelLine(model, v.tokens, v.usd, t, 28));
    return named.map((a) => {
      const mark = a.status === "running" ? "◌" : a.status === "done" ? "✓" : "✗";
      const color = a.status === "running" ? t.working : a.status === "done" ? t.accent : t.ansi1;
      const usd = costOf(a.model, a.tokens);
      return v_flex().pl(28).py(2)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(11).text_color(color).child(mark))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(a.description))
          .child(div().text_size(11).child(usd === null ? "" : `~${money(usd)}`)))
        .child(div().pl(14).text_size(11).text_color(t.muted).truncate().child(
          [modelName(a.model), `${kTokens(sumTokens(a.tokens))} tokens`, `${a.tools} tool calls`, duration((a.endedAt ?? now) - a.startedAt),
            a.steps ? `${a.steps.done}/${a.steps.total} steps` : null, a.type].filter(Boolean).join(" · ")));
    });
  }
}
