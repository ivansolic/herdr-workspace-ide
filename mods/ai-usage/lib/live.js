// Pure parts of the live agent tracker: what one running session of an agent is doing now, read from its
// log. Tasks, subagents, context, tokens and cost for Claude Code, Codex and Gemini CLI; the plan and
// daily limit Gemini prints in /stats. No I/O: scan.mjs --live reads the files, the pane header draws.
import { ZERO, addTokens, costOf, sumTokens } from "./usage.js";

function lines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line still being written */ }
  }
  return out;
}

const STATUS = { pending: "pending", in_progress: "in_progress", completed: "completed", cancelled: "completed", done: "completed" };

// { items, done, total, active } from [{ text, status }].
export function taskSummary(items) {
  const list = items.filter((t) => t.status !== "deleted").map((t) => ({ text: t.text, status: STATUS[t.status] ?? "pending" }));
  const active = list.find((t) => t.status === "in_progress");
  return { items: list, done: list.filter((t) => t.status === "completed").length, total: list.length, active: active?.text ?? null };
}

// Context windows when the log does not say: tokens.
const WINDOWS = [["claude-haiku-4-5", 200000], ["claude-", 1000000], ["gemini-", 1000000]];
const windowOf = (model) => WINDOWS.find(([p]) => String(model ?? "").startsWith(p))?.[1] ?? null;

// Claude Code transcript: the session's task list (TaskCreate/TaskUpdate, or TodoWrite), its subagents
// (Agent calls, done once their result is in), the context of the last reply, and tokens and cost.
export function liveClaude(text) {
  const tasks = new Map(), pendingCreates = new Map(), agents = new Map();
  let todos = null, model = null, context = null, tokens = ZERO, usd = 0, last = null, branch = null;
  const seen = new Set();
  for (const o of lines(text)) {
    last = o.timestamp ?? last;
    if (o.gitBranch && o.gitBranch !== "HEAD") branch = o.gitBranch;
    const content = Array.isArray(o.message?.content) ? o.message.content : [];
    if (o.type === "assistant") {
      const m = o.message, u = m?.usage;
      if (u && m.model && m.model !== "<synthetic>" && !seen.has(`${m.id}:${o.requestId}`)) {
        seen.add(`${m.id}:${o.requestId}`);
        const t = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0, requests: 1 };
        tokens = addTokens(tokens, t);
        usd += costOf(m.model, t) ?? 0;
        model = m.model;
        context = t.input + t.cacheRead + t.cacheWrite;
      }
      for (const b of content) {
        if (b.type !== "tool_use") continue;
        if (b.name === "TodoWrite") todos = (b.input?.todos ?? []).map((t) => ({ text: t.activeForm && t.status === "in_progress" ? t.activeForm : t.content, status: t.status }));
        if (b.name === "TaskCreate") {
          // A new list starts once every task of the last one is done, as Claude Code's own band shows it.
          if (tasks.size && [...tasks.values()].every((t) => t.status === "completed" || t.status === "deleted")) tasks.clear();
          pendingCreates.set(b.id, { text: b.input?.subject ?? "Task", status: "pending", activeForm: b.input?.activeForm });
        }
        if (b.name === "TaskUpdate" && b.input?.taskId) {
          const t = tasks.get(String(b.input.taskId));
          if (t) Object.assign(t, b.input.status ? { status: b.input.status } : {}, b.input.subject ? { text: b.input.subject } : {});
        }
        if (b.name === "Agent" || b.name === "Task") agents.set(b.id, { description: b.input?.description ?? "Subagent", type: b.input?.subagent_type ?? "general-purpose", status: "running" });
      }
    }
    // A background subagent reports back later in a task notification naming its tool call: queued as
    // its own entry (`queue-operation`, text in `content`) or inside a user message.
    const note = [typeof o.content === "string" ? o.content : "", typeof o.message?.content === "string" ? o.message.content : "",
      ...content.map((b) => (typeof b.text === "string" ? b.text : ""))].join("\n");
    if (note.includes("<tool-use-id>")) {
      for (const m of note.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([a-z]+)<\/status>/g)) {
        const agent = agents.get(m[1]);
        if (agent) agent.status = m[2] === "completed" ? "done" : m[2] === "failed" || m[2] === "killed" ? "failed" : agent.status;
      }
    }
    if (o.type === "user") {
      for (const b of content) {
        if (b.type !== "tool_result") continue;
        const create = pendingCreates.get(b.tool_use_id);
        if (create) {
          const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join(" ");
          const id = /#(\d+)/.exec(text)?.[1] ?? o.toolUseResult?.task?.id;
          if (id) tasks.set(String(id), create);
          pendingCreates.delete(b.tool_use_id);
        }
        const agent = agents.get(b.tool_use_id);
        // A background agent answers at once that it started; it is done when its own result comes.
        if (agent && !/launched|started|running in the background/i.test(JSON.stringify(b.content ?? "").slice(0, 300))) agent.status = b.is_error ? "failed" : "done";
      }
    }
  }
  const items = todos ?? [...tasks.values()].map((t) => ({ text: t.status === "in_progress" && t.activeForm ? t.activeForm : t.text, status: t.status }));
  const window = windowOf(model);
  return {
    agent: "claude", model, branch, last, tokens, usd,
    context: context !== null ? { tokens: context, window, percent: window ? Math.round((context / window) * 100) : null } : null,
    tasks: taskSummary(items),
    subagents: [...agents.values()],
  };
}

// Codex rollout: its plan (update_plan), the model, tokens and context of the last turn, the rate limits.
export function liveCodex(text) {
  let plan = [], model = null, tokens = ZERO, context = null, window = null, limits = null, last = null, cwd = null;
  for (const o of lines(text)) {
    last = o.timestamp ?? last;
    const p = o.payload ?? {};
    if (o.type === "session_meta") cwd = p.cwd ?? cwd;
    if (o.type === "turn_context" || p.type === "turn_context") { model = p.model ?? model; cwd = p.cwd ?? cwd; }
    if ((p.type === "function_call" || p.type === "custom_tool_call") && p.name === "update_plan") {
      try {
        const args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments ?? JSON.parse(p.input ?? "{}");
        plan = (args.plan ?? []).map((s) => ({ text: s.step, status: s.status }));
      } catch { /* a malformed plan keeps the last one */ }
    }
    if (p.type === "token_count") {
      const u = p.info?.last_token_usage;
      if (u) {
        const cached = u.cached_input_tokens ?? 0;
        tokens = addTokens(tokens, { input: Math.max(0, (u.input_tokens ?? 0) - cached), output: u.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0, requests: 1 });
        context = u.input_tokens ?? context;
      }
      window = p.info?.model_context_window ?? window;
      if (p.rate_limits) limits = { at: o.timestamp, ...p.rate_limits };
    }
  }
  const usd = costOf(model, tokens);
  return {
    agent: "codex", model, cwd, last, tokens, usd,
    context: context !== null ? { tokens: context, window, percent: window ? Math.round((context / window) * 100) : null } : null,
    tasks: taskSummary(plan),
    subagents: [],
    limits: codexLimits(limits),
  };
}

// Codex's rate limit windows as the header shows them: label, percent, reset time (ms).
export function codexLimits(l) {
  if (!l) return [];
  const at = Date.parse(l.at ?? "") || Date.now();
  return [l.primary, l.secondary].filter(Boolean).map((w) => ({
    label: w.window_minutes >= 7 * 24 * 60 ? "Weekly limit" : w.window_minutes ? `${Math.round(w.window_minutes / 60)}-hour limit` : "Limit",
    percent: w.used_percent ?? 0,
    resetsAt: w.resets_at ? w.resets_at * 1000 : w.resets_in_seconds ? at + w.resets_in_seconds * 1000 : null,
  }));
}

// Gemini CLI chat: its todo list (write_todos), model, tokens and the context of the last request.
export function liveGemini(text) {
  const messages = new Map();
  let last = null;
  for (const o of lines(text)) {
    const batch = o.$set?.messages ?? (o.type && o.id ? [o] : []);
    for (const m of batch) if (m?.id) messages.set(m.id, m);
    last = o.$set?.lastUpdated ?? o.lastUpdated ?? last;
  }
  let todos = [], model = null, tokens = ZERO, usd = 0, context = null;
  for (const m of messages.values()) {
    if (m.type !== "gemini") continue;
    model = m.model ?? model;
    for (const c of m.toolCalls ?? []) {
      if (c.name === "write_todos") todos = (c.args?.todos ?? []).map((t) => ({ text: t.description, status: t.status }));
    }
    if (m.tokens) {
      const k = m.tokens, cached = k.cached ?? 0;
      const t = { input: Math.max(0, (k.input ?? 0) - cached) + (k.tool ?? 0), output: (k.output ?? 0) + (k.thoughts ?? 0), cacheRead: cached, cacheWrite: 0, requests: 1 };
      tokens = addTokens(tokens, t);
      usd += costOf(m.model, t) ?? 0;
      context = k.input ?? context;
    }
  }
  const window = windowOf(model);
  return {
    agent: "gemini", model, last, tokens, usd,
    context: context !== null ? { tokens: context, window, percent: window ? Math.round((context / window) * 100) : null } : null,
    tasks: taskSummary(todos),
    subagents: [],
  };
}

// What Gemini prints in /stats (or /about): the plan ("Tier  Google AI Pro") and the daily limit
// ("23% used (Limit resets in 5h 12m)"). Only these two lines are read; the email on the screen is not.
export function geminiScreen(screen) {
  const out = {};
  const tier = /^[\s│|]*Tier\s{2,}(.+?)[\s│|]*$/m.exec(screen ?? "");
  if (tier) out.plan = tier[1].trim();
  const used = /(\d{1,3})% used(?:\s*\(Limit resets in ([^)]+)\))?/.exec(screen ?? "");
  if (used) out.limit = { percent: Number(used[1]), resetsIn: used[2]?.trim() ?? null };
  if (/Limit reached/.test(screen ?? "")) out.limit = { percent: 100, resetsIn: /resets in ([^\n.]+)/.exec(screen)?.[1]?.trim() ?? null };
  return out;
}

export const tokensOf = (live) => sumTokens(live?.tokens);
