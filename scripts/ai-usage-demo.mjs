#!/usr/bin/env node
// Writes made-up usage for the ai-usage panel's demo mode (screenshots, previews): projects, features,
// models, subagents and limits that belong to nobody. The panel shows it instead of your own logs until
// the file is removed.
//
//   node scripts/ai-usage-demo.mjs                      demo on, overview, this month
//   node scripts/ai-usage-demo.mjs --project acme-shop --open feature/checkout-redesign
//   node scripts/ai-usage-demo.mjs --range 30d --currency EUR --budget-open
//   node scripts/ai-usage-demo.mjs --off                back to your own usage
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const FILE = join(process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app"), "data/ai-usage/demo.json");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);

if (flag("off")) {
  await rm(FILE, { force: true });
  console.log(`demo off: removed ${FILE}`);
  process.exit(0);
}

// A fixed seed, so every run draws the same month.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const daysAgo = (n) => dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));

// Tokens for one busy day on a model, scaled by `size`.
function day(size, cacheShare = 0.92) {
  const total = Math.round((2e6 + rand() * 6e6) * size);
  return {
    input: Math.round(total * 0.01), output: Math.round(total * 0.012), cacheRead: Math.round(total * cacheShare),
    cacheWrite: Math.round(total * 0.05), requests: Math.round(20 + rand() * 120 * size),
  };
}

const add = (into, d, model, t) => {
  const m = (into[d] ??= {});
  const p = m[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  m[model] = { input: p.input + t.input, output: p.output + t.output, cacheRead: p.cacheRead + t.cacheRead,
    cacheWrite: p.cacheWrite + t.cacheWrite, requests: p.requests + t.requests };
};

// One session: work on a project's branches on some days, part of it by subagents.
function session(id, provider, project, plan) {
  const s = { id: `${provider}:${id}`, provider, project, branch: null, days: {},
    projects: { [project]: { days: {}, branches: {}, sub: { days: {}, branches: {} } } }, subagents: { count: 0, days: {} } };
  const p = s.projects[project];
  for (const { branch, ago, model, size, subagents = 0 } of plan) {
    const d = daysAgo(ago), t = day(size);
    add(s.days, d, model, t);
    add(p.days, d, model, t);
    if (branch) { add((p.branches[branch] ??= {}), d, model, t); s.branch = branch; }
    if (subagents) {
      const st = day(size * 0.35);
      add(s.subagents.days, d, "claude-sonnet-5-5", st);
      add(p.days, d, "claude-sonnet-5-5", st);
      add(p.sub.days, d, "claude-sonnet-5-5", st);
      if (branch) { add((p.branches[branch] ??= {}), d, "claude-sonnet-5-5", st); add((p.sub.branches[branch] ??= {}), d, "claude-sonnet-5-5", st); }
      s.subagents.count += subagents;
    }
  }
  const all = Object.keys(s.days).sort();
  s.first = all[0];
  s.last = new Date(`${all[all.length - 1]}T${pad(9 + Math.floor(rand() * 9))}:${pad(Math.floor(rand() * 60))}:00`).toISOString();
  return s;
}

const opus = "claude-opus-5-5", sonnet = "claude-sonnet-5-5", haiku = "claude-haiku-5-5";
const sessions = [
  session("demo-checkout", "anthropic", "acme-shop", [
    { branch: "feature/checkout-redesign", ago: 0, model: opus, size: 1.1, subagents: 4 },
    { branch: "feature/checkout-redesign", ago: 1, model: opus, size: 1.4, subagents: 3 },
    { branch: "feature/checkout-redesign", ago: 2, model: opus, size: 0.9, subagents: 2 },
  ]),
  session("demo-search", "anthropic", "acme-shop", [
    { branch: "feature/product-search", ago: 4, model: opus, size: 1.0, subagents: 3 },
    { branch: "feature/product-search", ago: 5, model: sonnet, size: 1.2 },
    { branch: "feature/product-search", ago: 7, model: opus, size: 0.8, subagents: 1 },
  ]),
  session("demo-cart", "anthropic", "acme-shop", [
    { branch: "fix/cart-totals", ago: 9, model: sonnet, size: 0.7 },
    { branch: "fix/cart-totals", ago: 10, model: haiku, size: 1.5 },
  ]),
  session("demo-docs", "anthropic", "docs-site", [
    { branch: "main", ago: 3, model: sonnet, size: 0.6 },
    { branch: "docs/getting-started", ago: 12, model: sonnet, size: 0.9, subagents: 2 },
    { branch: "docs/getting-started", ago: 16, model: haiku, size: 1.2 },
  ]),
  session("demo-mobile", "google", "mobile-app", [
    { ago: 1, model: "gemini-3.1-pro-preview", size: 0.8 },
    { ago: 6, model: "gemini-3.8-flash", size: 1.6 },
    { ago: 14, model: "gemini-3.1-pro-preview", size: 0.7 },
  ]),
  session("demo-older", "anthropic", "acme-shop", [
    { branch: "feature/product-search", ago: 22, model: opus, size: 1.3, subagents: 2 },
    { branch: "main", ago: 27, model: opus, size: 0.9 },
  ]),
].sort((a, b) => b.last.localeCompare(a.last));

const iso = (msAhead) => new Date(now.getTime() + msAhead).toISOString();
const snapshot = {
  version: 1, sessionId: "demo-checkout", project: "acme-shop", cwd: "/work/acme-shop", startedAt: now.getTime() - 2 * 3600e3,
  updatedAt: now.getTime(), plan: { name: "Max 5x", listUsd: 100, extraUsage: false }, mode: "auto", planUsd: null,
  budget: { day: 10, month: 200 },
  usage: { usd: 18.4, contextPercent: 37, contextTokens: 370000, contextWindow: 1000000,
    limits: [{ kind: "five_hour", percentUsed: 42, resetsAt: iso(2.4 * 3600e3) }, { kind: "seven_day", percentUsed: 18, resetsAt: iso(3.2 * 86400e3) }] },
  models: {}, tasks: { done: 2, total: 5, active: "Writing checkout tests" },
  agents: [
    ["Map the checkout flow", "Explore", 3, 4], ["Review payment form", "code-reviewer", 4, 4], ["Write checkout tests", "general-purpose", 2, 5],
    ["Check accessibility", "general-purpose", 5, 5],
  ].map(([description, type, done, total], i) => ({
    id: `demo-sub-${i}`, description, type, model: sonnet, status: done === total ? "done" : "running",
    startedAt: now.getTime() - (40 - i * 9) * 60e3, endedAt: done === total ? now.getTime() - (30 - i * 9) * 60e3 : null,
    tools: 6 + i * 3, tokens: { input: 9e3, output: 21e3, cacheRead: 410e3 + i * 90e3, cacheWrite: 30e3, requests: 9 + i * 4 }, steps: { done, total },
  })),
  lists: [],
};

const project = value("project") ?? null;
const open = value("open");
const demo = {
  scan: {
    generatedAt: now.toISOString(), read: 0, keepDays: 400,
    installed: { anthropic: true, google: true, openai: false },
    claudePlan: { organizationType: "claude_max", seatTier: null, rateLimitTier: "default_claude_max_5x", extraUsage: false },
    limits: {}, sessions,
  },
  snapshots: [snapshot],
  shared: {
    "ai-usage.budgets": { "acme-shop": 250 }, "ai-usage.plans": { google: "ai-pro" }, "ai-usage.links": {}, "ai-usage.folded": [],
    "ai-usage.currency": value("currency") === "EUR" ? "EUR" : "USD",
    "ai-usage.ecb": { usdPerEur: 1.08, date: dayOf(now), fetchedAt: now.getTime() },
  },
  view: {
    range: { "30d": "last30", week: "week", today: "today" }[value("range")] ?? "month",
    project, budgetOpen: flag("budget-open"), currencyOpen: flag("currency-open"),
    openFeatures: open && project ? [`${project}:${open}`] : [],
    openSessions: flag("open-subagents") ? ["anthropic:demo-checkout"] : [],
  },
};

await mkdir(join(FILE, ".."), { recursive: true });
await writeFile(FILE, JSON.stringify(demo));
console.log(`demo on: ${FILE} (remove with --off)`);
