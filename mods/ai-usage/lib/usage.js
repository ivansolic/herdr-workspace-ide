// Pure parts of AI usage: list prices, log parsers for each agent, and sums by day and model.
// No I/O here: scan.mjs (Node) feeds it files, main.js (Herdr) draws what it returns, tests import it.

// Token counts of one model, plus how many replies (requests) they came from.
export const ZERO = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });

export const addTokens = (a, b) => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  requests: (a.requests ?? 0) + (b.requests ?? 0),
});

export const sumTokens = (t) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0);

// API list prices per million tokens: [provider, id prefix, name, input, output, cache read, cache write].
// Anthropic: model table of 2026-10-06 (cache read 0.1x, write 1.25x input).
// Google: ai.google.dev pricing, 2026-11-12, prompts up to 200k (no cache write charge; storage not counted).
// Longest matching prefix wins.
export const PRICES = [
  ["anthropic", "claude-fable-5-1", "Fable 5.1", 10, 50, 1, 12.5],
  ["anthropic", "claude-fable-5", "Fable 5", 10, 50, 1, 12.5],
  ["anthropic", "claude-mythos-5-1", "Mythos 5.1", 10, 50, 1, 12.5],
  ["anthropic", "claude-opus-5-5", "Opus 5.5", 4, 20, 0.2, 5],
  ["anthropic", "claude-opus-5", "Opus 5", 5, 25, 0.5, 6.25],
  ["anthropic", "claude-opus-4-8", "Opus 4.8", 5, 25, 0.5, 6.25],
  ["anthropic", "claude-opus-4-7", "Opus 4.7", 5, 25, 0.5, 6.25],
  ["anthropic", "claude-opus-4-6", "Opus 4.6", 5, 25, 0.5, 6.25],
  ["anthropic", "claude-sonnet-5-5", "Sonnet 5.5", 2, 10, 0.2, 2.5],
  ["anthropic", "claude-sonnet-5", "Sonnet 5", 2, 10, 0.2, 2.5],
  ["anthropic", "claude-sonnet-4-6", "Sonnet 4.6", 3, 15, 0.3, 3.75],
  ["anthropic", "claude-haiku-5-5", "Haiku 5.5", 0.1, 0.5, 0.01, 0.125],
  ["anthropic", "claude-haiku-4-5", "Haiku 4.5", 1, 5, 0.1, 1.25],
  ["google", "gemini-4-carbon", "Gemini 4 Carbon", 2, 10, 0.1, 0],
  ["google", "gemini-4-argon", "Gemini 4 Argon", 2, 10, 0.1, 0],
  ["google", "gemini-3.8-flash", "Gemini 3.8 Flash", 0.75, 3.75, 0.075, 0],
  ["google", "gemini-3.6-flash", "Gemini 3.6 Flash", 0.75, 3.75, 0.075, 0],
  ["google", "gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", 0.3, 2.5, 0.03, 0],
  ["google", "gemini-3.1-pro", "Gemini 3.1 Pro", 2, 12, 0.2, 0],
  ["google", "gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", 0.25, 1.5, 0.025, 0],
  ["google", "gemini-3-flash", "Gemini 3 Flash", 0.5, 3, 0.05, 0],
  ["google", "gemini-2.5-pro", "Gemini 2.5 Pro", 1.25, 10, 0.125, 0],
  ["google", "gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", 0.1, 0.4, 0.01, 0],
  ["google", "gemini-2.5-flash", "Gemini 2.5 Flash", 0.3, 2.5, 0.03, 0],
];

export function priceOf(model) {
  const id = String(model ?? "").replace(/\[.*\]$/, "").replace(/^models\//, "").toLowerCase();
  let best = null;
  for (const p of PRICES) if (id.startsWith(p[1]) && (!best || p[1].length > best[1].length)) best = p;
  return best;
}

export const modelName = (model) => priceOf(model)?.[2] ?? (String(model ?? "unknown").replace(/^claude-/, "") || "unknown");

// API-price cost of `tokens` on `model`, or null when the model has no known price.
export function costOf(model, tokens) {
  const p = priceOf(model);
  if (!p || !tokens) return null;
  const [, , , input, output, cacheRead, cacheWrite] = p;
  return (tokens.input * input + tokens.output * output + tokens.cacheRead * cacheRead + tokens.cacheWrite * cacheWrite) / 1e6;
}

const pad2 = (n) => String(n).padStart(2, "0");

// Local calendar day of a timestamp (ISO string or ms), YYYY-MM-DD.
export function dayOf(time) {
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// days: { "YYYY-MM-DD": { model: tokens } }; one record is added in place.
function add(days, time, model, tokens) {
  const day = dayOf(time);
  if (!day || !model) return;
  const models = (days[day] ??= {});
  models[model] = addTokens(models[model] ?? ZERO, tokens);
}

function lines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line still being written */ }
  }
  return out;
}

// Claude Code transcript (~/.claude/projects/**/*.jsonl). An assistant message is written once per content
// block with the same usage, so it is counted once per message id and request id. Fast mode bills 2x.
export function parseClaude(text) {
  const days = {}, places = {}, seen = new Set();
  let cwd = null, here = null, session = null, last = null, branch = null;
  for (const o of lines(text)) {
    // The session belongs to the folder it started in; each reply counts where Claude was working then.
    cwd = cwd ?? o.cwd ?? null;
    here = o.cwd ?? here;
    session = o.sessionId ?? session;
    if (o.gitBranch && o.gitBranch !== "HEAD") branch = o.gitBranch;
    if (o.type !== "assistant") continue;
    const m = o.message, u = m?.usage;
    if (!u || !m.model || m.model === "<synthetic>") continue;
    const key = `${m.id}:${o.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const speed = u.speed === "fast" ? 2 : 1;
    const tokens = {
      input: (u.input_tokens ?? 0) * speed,
      output: (u.output_tokens ?? 0) * speed,
      cacheRead: (u.cache_read_input_tokens ?? 0) * speed,
      cacheWrite: (u.cache_creation_input_tokens ?? 0) * speed,
      requests: 1,
    };
    add(days, o.timestamp, m.model, tokens);
    const place = (places[here ?? ""] ??= { days: {}, branches: {} });
    add(place.days, o.timestamp, m.model, tokens);
    if (o.gitBranch && o.gitBranch !== "HEAD") add((place.branches[o.gitBranch] ??= {}), o.timestamp, m.model, tokens);
    last = o.timestamp ?? last;
  }
  return { days, places, cwd, session, last, branch };
}

// Gemini CLI chat (~/.gemini/tmp/*/chats/*.jsonl): a header line, then messages, whole or in `$set` updates.
// promptTokenCount includes the cached part; thoughts are billed as output.
export function parseGemini(text) {
  const messages = new Map();
  let session = null, last = null;
  for (const o of lines(text)) {
    session = o.sessionId ?? session;
    const batch = o.$set?.messages ?? (o.type && o.id ? [o] : []);
    for (const m of batch) if (m?.id) messages.set(m.id, m);
    last = o.$set?.lastUpdated ?? o.lastUpdated ?? last;
  }
  const days = {};
  for (const m of messages.values()) {
    if (m.type !== "gemini" || !m.tokens) continue;
    const t = m.tokens, cached = t.cached ?? 0;
    add(days, m.timestamp, m.model ?? "gemini", {
      input: Math.max(0, (t.input ?? 0) - cached) + (t.tool ?? 0),
      output: (t.output ?? 0) + (t.thoughts ?? 0),
      cacheRead: cached,
      cacheWrite: 0,
      requests: 1,
    });
  }
  return { days, session, last };
}

// Codex CLI rollout (~/.codex/sessions/**/rollout-*.jsonl): token_count events after each turn, the model
// from turn_context, and the plan's rate limits. input_tokens includes the cached part.
export function parseCodex(text) {
  const days = {};
  let model = null, limits = null, last = null, cwd = null;
  for (const o of lines(text)) {
    const p = o.payload ?? {};
    if (o.type === "turn_context" || p.type === "turn_context") { model = p.model ?? model; cwd = p.cwd ?? cwd; }
    if (p.type !== "token_count") continue;
    const u = p.info?.last_token_usage;
    if (u) {
      const cached = u.cached_input_tokens ?? 0;
      add(days, o.timestamp, model ?? "codex", {
        input: Math.max(0, (u.input_tokens ?? 0) - cached), output: u.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0, requests: 1,
      });
    }
    if (p.rate_limits) limits = { at: o.timestamp, ...p.rate_limits };
    last = o.timestamp ?? last;
  }
  return { days, limits, cwd, last };
}

export function mergeDays(target, days) {
  for (const [day, models] of Object.entries(days)) {
    const into = (target[day] ??= {});
    for (const [model, tokens] of Object.entries(models)) into[model] = addTokens(into[model] ?? ZERO, tokens);
  }
  return target;
}

// The ranges the panel shows, as [first day, last day] (inclusive, YYYY-MM-DD). Weeks start on Monday.
export function ranges(now) {
  const d = new Date(now);
  const day = (offset) => dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime());
  const monday = -((d.getDay() + 6) % 7);
  return {
    today: [day(0), day(0)],
    week: [day(monday), day(0)],
    month: [dayOf(new Date(d.getFullYear(), d.getMonth(), 1).getTime()), day(0)],
    last30: [day(-29), day(0)],
    last60: [day(-59), day(0)],
    last180: [day(-182), day(0)],
    last365: [day(-364), day(0)],
    all: ["0000-00-00", day(0)],
  };
}

// `a` minus `b`, per day and model; what is left at or below zero is dropped.
export function subtractDays(a, b) {
  const out = {};
  for (const [day, models] of Object.entries(a)) {
    for (const [model, t] of Object.entries(models)) {
      const o = b[day]?.[model] ?? ZERO;
      const left = { input: t.input - o.input, output: t.output - o.output, cacheRead: t.cacheRead - o.cacheRead,
        cacheWrite: t.cacheWrite - o.cacheWrite, requests: (t.requests ?? 0) - (o.requests ?? 0) };
      if (left.input > 0 || left.output > 0 || left.cacheRead > 0 || left.cacheWrite > 0) (out[day] ??= {})[model] = left;
    }
  }
  return out;
}

// The first day with any usage, or null.
export const firstDayOf = (days) => Object.keys(days).sort()[0] ?? null;

// Cost and tokens per model within [from, to], from days of { model: tokens }.
export function totals(days, [from, to]) {
  const byModel = {};
  for (const [day, models] of Object.entries(days)) {
    if (day < from || day > to) continue;
    for (const [model, tokens] of Object.entries(models)) {
      const prev = byModel[model] ?? { tokens: ZERO, activeDays: 0 };
      byModel[model] = { tokens: addTokens(prev.tokens, tokens), activeDays: prev.activeDays + 1 };
    }
  }
  let usd = 0, priced = true;
  for (const [model, v] of Object.entries(byModel)) {
    v.usd = costOf(model, v.tokens);
    if (v.usd === null) priced = false;
    else usd += v.usd;
  }
  return { byModel, usd, priced };
}

// This month's cost carried to the month's end at the pace so far.
export function projectMonth(monthUsd, now) {
  const d = new Date(now);
  const daysIn = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return (monthUsd / d.getDate()) * daysIn;
}

// Which provider a model belongs to.
export function providerOf(model) {
  const p = priceOf(model);
  if (p) return p[0];
  const id = String(model ?? "");
  return id.startsWith("claude") ? "anthropic" : id.startsWith("gemini") ? "google" : /^(gpt|o\d|codex)/.test(id) ? "openai" : "other";
}

// A project's name from a working folder: a git worktree counts as its repository
// (Claude Code's .claude/worktrees/<name>, Herdr's ~/.herdr/worktrees/<repo>/<branch>).
export function projectOf(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split("/").filter(Boolean);
  const wt = parts.indexOf("worktrees");
  if (wt > 0 && parts[wt - 1] === ".claude" && wt >= 2) return parts[wt - 2];
  if (wt > 0 && parts[wt - 1] === ".herdr" && parts[wt + 1]) return parts[wt + 1];
  return parts.pop() ?? null;
}

// Days of { model: tokens } summed over sessions (each with `days`, and `subagents.days` when it has some).
export function sessionDays(sessions) {
  const days = {};
  for (const s of sessions) {
    mergeDays(days, s.days ?? {});
    if (s.subagents?.days) mergeDays(days, s.subagents.days);
  }
  return days;
}

// One entry per day from `from` to `to`: { day, byProvider: { provider: usd } }, for the cost chart.
export function dailyCost(days, [from, to]) {
  const out = [];
  const end = new Date(`${to}T12:00:00`);
  for (let d = new Date(`${from}T12:00:00`); d <= end; d.setDate(d.getDate() + 1)) {
    const day = dayOf(d.getTime()), byProvider = {};
    for (const [model, tokens] of Object.entries(days[day] ?? {})) {
      const usd = costOf(model, tokens);
      if (usd !== null) byProvider[providerOf(model)] = (byProvider[providerOf(model)] ?? 0) + usd;
    }
    out.push({ day, byProvider });
  }
  return out;
}

// dailyCost's entries summed into weeks (Monday to Sunday), for spans too long for one column a day.
export function weekly(series) {
  const out = [];
  for (const d of series) {
    const date = new Date(`${d.day}T12:00:00`);
    if (!out.length || date.getDay() === 1) out.push({ day: d.day, byProvider: {} });
    const into = out[out.length - 1].byProvider;
    for (const [p, usd] of Object.entries(d.byProvider)) into[p] = (into[p] ?? 0) + usd;
  }
  return out;
}

// What cache reads saved against paying full input price for the same tokens, within a range.
export function cacheSavings(days, [from, to]) {
  let usd = 0;
  for (const [day, models] of Object.entries(days)) {
    if (day < from || day > to) continue;
    for (const [model, t] of Object.entries(models)) {
      const p = priceOf(model);
      if (p) usd += (t.cacheRead * (p[3] - p[5])) / 1e6;
    }
  }
  return usd;
}

// ----- export, budgets and the per-feature summary -----

const csvCell = (v) => {
  const text = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const AGENT_NAMES = { anthropic: "Claude Code", google: "Gemini CLI", openai: "Codex", other: "Other" };

// An amount as a spreadsheet reads it: "$4.20" or "€4.20", four decimals below a cent ("$0.0021").
export const csvMoney = (amount, symbol = "$") =>
  (amount === null || amount === undefined ? "" : `${symbol}${amount !== 0 && Math.abs(amount) < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`);

// Dollars or euros: what an amount in dollars shows as. `perUsd` is how many of the currency one dollar buys.
export const USD = Object.freeze({ code: "USD", symbol: "$", perUsd: 1, note: null });

export function euros(usdPerEur, date) {
  return { code: "EUR", symbol: "€", perUsd: 1 / usdPerEur, note: `1 USD = ${(1 / usdPerEur).toFixed(4)} EUR (ECB reference rate, ${date})` };
}

// The euro reference rate from the ECB's daily file: how many dollars one euro buys, and its date.
export function parseEcbRate(xml) {
  const rate = /currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(xml)?.[1];
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  return rate && date ? { usdPerEur: Number(rate), date } : null;
}

// CSV of { project, feature, days, sub } pieces within [from, to]: one row per day, feature and model,
// then a total row. Dates are YYYY-MM-DD, counts plain integers and costs amounts in `fx`'s currency, so
// a spreadsheet reads each column as a date, a number and currency. Costs are at API list price (set in
// dollars; euros at the ECB rate, said on the last line); "Subagent cost" is the part of "Cost" subagents spent.
export function toCsv(pieces, [from, to], fx = USD) {
  const cash = (usd) => csvMoney(usd === null ? null : usd * fx.perUsd, fx.symbol);
  const head = ["Date", "Project", "Feature", "Agent", "Model", "Requests", "Input tokens", "Output tokens",
    "Cache read tokens", "Cache write tokens", `Cost (${fx.code})`, `Subagent cost (${fx.code})`];
  const rows = [], sum = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, sub: 0 };
  for (const p of pieces) {
    for (const [day, models] of Object.entries(p.days)) {
      if (day < from || day > to) continue;
      for (const [model, t] of Object.entries(models)) {
        const usd = costOf(model, t), subTokens = p.sub?.[day]?.[model], sub = subTokens ? costOf(model, subTokens) : null;
        rows.push([day, p.project, p.feature, AGENT_NAMES[providerOf(model)], modelName(model), t.requests ?? 0, t.input, t.output,
          t.cacheRead, t.cacheWrite, cash(usd), cash(sub)]);
        sum.requests += t.requests ?? 0; sum.input += t.input; sum.output += t.output;
        sum.cacheRead += t.cacheRead; sum.cacheWrite += t.cacheWrite; sum.usd += usd ?? 0; sum.sub += sub ?? 0;
      }
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]) || a[4].localeCompare(b[4]));
  const total = ["Total", "", "", "", "", sum.requests, sum.input, sum.output, sum.cacheRead, sum.cacheWrite, cash(sum.usd), cash(sum.sub)];
  const lines = [head, ...rows, total];
  if (fx.note) lines.push([`Exchange rate: ${fx.note}`]);
  return lines.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

// The warning a budget needs now, if any: the highest threshold crossed that was not yet warned about.
export function budgetWarning(spent, budget, warned, key) {
  if (!budget) return null;
  const percent = (spent / budget) * 100;
  const crossed = [100, 80].find((t) => percent >= t);
  if (crossed === undefined || warned.includes(`${key}:${crossed}`)) return null;
  return { threshold: crossed, percent, id: `${key}:${crossed}` };
}

// { project: { total, month, today, budget, features: { feature: { total, month, today } } } } from
// { project, feature, days } pieces, for Claude Code's progress tracker to show while you work.
export function featureSummary(pieces, now, budgets = {}) {
  const r = ranges(now), out = {};
  for (const p of pieces) {
    const proj = (out[p.project] ??= { total: 0, month: 0, today: 0, budget: budgets[p.project] ?? null, features: {} });
    const f = (proj.features[p.feature] ??= { total: 0, month: 0, today: 0 });
    for (const [key, range] of [["total", r.all], ["month", r.month], ["today", r.today]]) {
      const usd = totals(p.days, range).usd;
      proj[key] += usd;
      f[key] += usd;
    }
  }
  return out;
}
