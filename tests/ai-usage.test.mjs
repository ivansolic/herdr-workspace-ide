import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaude, parseGemini, parseCodex, costOf, modelName, ranges, totals, projectMonth, dayOf, projectOf, dailyCost, cacheSavings, subtractDays, weekly, firstDayOf, toCsv, csvMoney, euros, parseEcbRate, budgetWarning, featureSummary } from "../mods/ai-usage/lib/usage.js";

const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const at = "2026-11-12T10:00:00";

test("Claude: one count per message, fast mode doubles, synthetic skipped", () => {
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 };
  const text = jsonl(
    { type: "user", cwd: "/w/app", sessionId: "s1", timestamp: at, gitBranch: "main" },
    // Written once per content block, same message id and request: counted once.
    { type: "assistant", requestId: "r1", timestamp: at, message: { id: "m1", model: "claude-opus-5-5", usage } },
    { type: "assistant", requestId: "r1", timestamp: at, message: { id: "m1", model: "claude-opus-5-5", usage } },
    // Claude moved to another folder: the reply counts there, the session stays /w/app's.
    { type: "assistant", requestId: "r2", cwd: "/w/lib", gitBranch: "feat/x", timestamp: at, message: { id: "m2", model: "claude-opus-5-5", usage: { ...usage, speed: "fast" } } },
    { type: "assistant", requestId: "r3", timestamp: at, message: { id: "m3", model: "<synthetic>", usage } },
  ) + "{\"type\":\"assist"; // a line still being written
  const r = parseClaude(text);
  assert.equal(r.cwd, "/w/app");
  assert.deepEqual(r.days[dayOf(at)]["claude-opus-5-5"], { input: 30, output: 60, cacheRead: 300, cacheWrite: 15, requests: 2 });
  assert.equal(Object.keys(r.days[dayOf(at)]).length, 1);
  assert.equal(r.places["/w/app"].days[dayOf(at)]["claude-opus-5-5"].requests, 1);
  assert.equal(r.places["/w/lib"].days[dayOf(at)]["claude-opus-5-5"].input, 20);
  assert.equal(r.places["/w/lib"].branches["feat/x"][dayOf(at)]["claude-opus-5-5"].requests, 1);
  assert.equal(r.branch, "feat/x");
});

test("Gemini: cached part leaves input, thoughts count as output, $set updates replace messages", () => {
  const msg = { id: "g1", type: "gemini", timestamp: at, model: "gemini-3.1-pro-preview", tokens: { input: 1000, output: 50, cached: 400, thoughts: 30, tool: 10, total: 1090 } };
  const text = jsonl(
    { sessionId: "s", projectHash: "h", startTime: at, lastUpdated: at, kind: "main" },
    { $set: { lastUpdated: at, messages: [{ id: "u1", type: "user", timestamp: at, content: [] }, { ...msg, tokens: null }] } },
    { $set: { lastUpdated: at, messages: [{ id: "u1", type: "user", timestamp: at, content: [] }, msg] } },
  );
  const r = parseGemini(text);
  assert.deepEqual(r.days[dayOf(at)]["gemini-3.1-pro-preview"], { input: 610, output: 80, cacheRead: 400, cacheWrite: 0, requests: 1 });
});

test("Codex: tokens per turn under the turn's model, the latest rate limits kept", () => {
  const text = jsonl(
    { timestamp: at, type: "turn_context", payload: { model: "gpt-5-codex", cwd: "/w/api" } },
    { timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 40 } },
      rate_limits: { primary: { used_percent: 12, window_minutes: 300 }, secondary: { used_percent: 3, window_minutes: 10080 } } } },
  );
  const r = parseCodex(text);
  assert.deepEqual(r.days[dayOf(at)]["gpt-5-codex"], { input: 300, output: 40, cacheRead: 200, cacheWrite: 0, requests: 1 });
  assert.equal(r.limits.primary.used_percent, 12);
  assert.equal(r.cwd, "/w/api");
});

test("prices: longest prefix wins, unknown models have none", () => {
  assert.equal(modelName("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelName("claude-sonnet-5"), "Sonnet 5");
  assert.equal(modelName("gemini-3.1-flash-lite"), "Gemini 3.1 Flash-Lite");
  assert.equal(modelName("gemini-3.1-pro-preview"), "Gemini 3.1 Pro");
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write per 1M.
  assert.equal(costOf("claude-opus-5-5", { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }), 29.2);
  assert.equal(costOf("gpt-5-codex", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

test("ranges, totals and the month projection", () => {
  const now = new Date(2026, 10, 12, 15).getTime(); // Thursday 12 November
  const r = ranges(now);
  assert.deepEqual(r.today, ["2026-11-12", "2026-11-12"]);
  assert.deepEqual(r.week, ["2026-11-09", "2026-11-12"]);
  assert.deepEqual(r.month, ["2026-11-01", "2026-11-12"]);
  assert.deepEqual(r.last30, ["2026-10-14", "2026-11-12"]);
  const mtok = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 };
  const days = { "2026-11-12": { "claude-opus-5-5": mtok }, "2026-11-01": { "claude-opus-5-5": mtok }, "2026-10-31": { "claude-opus-5-5": mtok } };
  const month = totals(days, r.month);
  assert.equal(month.usd, 8);
  assert.equal(month.byModel["claude-opus-5-5"].activeDays, 2);
  assert.equal(totals(days, r.week).usd, 4);
  assert.equal(projectMonth(12, now), 30);
});

test("projects: worktrees count as their repository", () => {
  assert.equal(projectOf("/Users/a/code/shop/.claude/worktrees/checkout-redesign"), "shop");
  assert.equal(projectOf("/Users/a/.herdr/worktrees/api/feat-x"), "api");
  assert.equal(projectOf("/Users/a/code/herdr-vscode-like"), "herdr-vscode-like");
  assert.equal(projectOf(null), null);
});

test("chart days and cache savings", () => {
  const days = { "2026-11-11": { "claude-opus-5-5": { input: 1e6, output: 0, cacheRead: 1e6, cacheWrite: 0, requests: 1 } } };
  const series = dailyCost(days, ["2026-11-10", "2026-11-12"]);
  assert.deepEqual(series.map((d) => d.day), ["2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.equal(series[1].byProvider.anthropic, 4.2);
  // A cache read costs $0.20 instead of $4 per 1M on Opus 5.5.
  assert.equal(cacheSavings(days, ["2026-11-01", "2026-11-30"]), 3.8);
});

test("long ranges, subtraction and weekly chart columns", () => {
  const now = new Date(2026, 10, 12, 15).getTime();
  const r = ranges(now);
  assert.deepEqual(r.last60, ["2026-09-14", "2026-11-12"]);
  assert.equal(r.all[0], "0000-00-00");
  const t = (n) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, requests: n });
  const left = subtractDays({ "2026-11-11": { m: t(5), n: t(2) } }, { "2026-11-11": { m: t(3), n: t(2) } });
  assert.deepEqual(left, { "2026-11-11": { m: t(2) } });
  assert.equal(firstDayOf({ "2026-11-11": {}, "2026-09-02": {} }), "2026-09-02");
  // 1 Nov is a Sunday: its own week, then Monday 2 and Monday 9 start the next ones.
  const weeks = weekly(dailyCost({}, ["2026-11-01", "2026-11-12"]));
  assert.deepEqual(weeks.map((w) => w.day), ["2026-11-01", "2026-11-02", "2026-11-09"]);
});

test("CSV: a row per day, feature and model, quoted where needed", () => {
  const t = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, requests: 3 };
  const half = { input: 5e5, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 };
  const csv = toCsv([{ project: "app", feature: "feat, x", days: { "2026-11-12": { "claude-opus-5-5": t }, "2026-10-01": { "claude-opus-5-5": t } },
    sub: { "2026-11-12": { "claude-opus-5-5": half } } }], ["2026-11-01", "2026-11-30"]);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Date,Project,Feature,Agent,Model,Requests,Input tokens,Output tokens,Cache read tokens,Cache write tokens,Cost (USD),Subagent cost (USD)");
  assert.equal(lines[1], '2026-11-12,app,"feat, x",Claude Code,Opus 5.5,3,1000000,0,0,0,$4.00,$2.00');
  assert.equal(lines[2], "Total,,,,,3,1000000,0,0,0,$4.00,$2.00");
});

test("amounts keep sub-cent costs visible, in dollars or euros", () => {
  assert.equal(csvMoney(4.2), "$4.20");
  assert.equal(csvMoney(0.0021), "$0.0021");
  assert.equal(csvMoney(0), "$0.00");
  assert.equal(csvMoney(null), "");
  assert.equal(csvMoney(3.5, "€"), "€3.50");
});

test("euros: the ECB rate, and a CSV in euros says its rate", () => {
  const xml = "<Cube time='2026-11-12'><Cube currency='USD' rate='1.0800'/><Cube currency='JPY' rate='160'/></Cube>";
  assert.deepEqual(parseEcbRate(xml), { usdPerEur: 1.08, date: "2026-11-12" });
  assert.equal(parseEcbRate("<nothing/>"), null);
  const fx = euros(1.08, "2026-11-12");
  const t = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 };
  const lines = toCsv([{ project: "app", feature: "x", days: { "2026-11-12": { "claude-opus-5-5": t } } }], ["2026-11-01", "2026-11-30"], fx).trim().split("\n");
  assert.ok(lines[0].endsWith("Cost (EUR),Subagent cost (EUR)"));
  assert.ok(lines[1].endsWith(",€3.70,"));
  assert.equal(lines[3], '"Exchange rate: 1 USD = 0.9259 EUR (ECB reference rate, 2026-11-12)"');
});

test("budget warnings: once at 80%, once at 100%", () => {
  assert.equal(budgetWarning(70, 100, [], "app:2026-11"), null);
  assert.equal(budgetWarning(85, 100, [], "app:2026-11").id, "app:2026-11:80");
  assert.equal(budgetWarning(85, 100, ["app:2026-11:80"], "app:2026-11"), null);
  assert.equal(budgetWarning(120, 100, ["app:2026-11:80"], "app:2026-11").threshold, 100);
  assert.equal(budgetWarning(120, null, [], "app:2026-11"), null);
});

test("feature summary for the Claude band", () => {
  const now = new Date(2026, 10, 12, 15).getTime();
  const t = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 };
  const s = featureSummary([
    { project: "app", feature: "feat/x", days: { "2026-11-12": { "claude-opus-5-5": t }, "2026-10-01": { "claude-opus-5-5": t } } },
    { project: "app", feature: "Other work", days: { "2026-11-02": { "claude-opus-5-5": t } } },
  ], now, { app: 300 });
  assert.deepEqual(s.app.features["feat/x"], { total: 8, month: 4, today: 4 });
  assert.equal(s.app.month, 8);
  assert.equal(s.app.total, 12);
  assert.equal(s.app.budget, 300);
});
