import { test } from "node:test";
import assert from "node:assert/strict";
import { liveClaude, liveCodex, liveGemini, geminiScreen, codexLimits, taskSummary } from "../mods/ai-usage/lib/live.js";

const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const at = "2026-11-12T10:00:00Z";
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5 };
const assistant = (id, blocks, model = "claude-opus-5-5") =>
  ({ type: "assistant", requestId: `r${id}`, timestamp: at, message: { id: `m${id}`, model, usage, content: blocks } });
const result = (tool_use_id, content) => ({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id, content }] } });

test("Claude: the current task list, subagents done by their notification, context of the last reply", () => {
  const r = liveClaude(jsonl(
    { type: "user", gitBranch: "feature/x", timestamp: at, message: { content: "go" } },
    // An earlier list, all done: the next TaskCreate starts a new one.
    assistant(1, [{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "Old" } }]),
    result("c1", "Task #1 created successfully: Old"),
    assistant(2, [{ type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }]),
    assistant(3, [{ type: "tool_use", id: "c2", name: "TaskCreate", input: { subject: "Write tests", activeForm: "Writing tests" } },
      { type: "tool_use", id: "c3", name: "TaskCreate", input: { subject: "Ship" } }]),
    result("c2", "Task #2 created successfully: Write tests"),
    result("c3", "Task #3 created successfully: Ship"),
    assistant(4, [{ type: "tool_use", id: "u2", name: "TaskUpdate", input: { taskId: "2", status: "in_progress" } },
      { type: "tool_use", id: "a1", name: "Agent", input: { description: "Map the flow", subagent_type: "Explore" } }]),
    result("a1", "Async agent launched successfully."),
    { type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<tool-use-id>a1</tool-use-id>\n<status>completed</status>" },
  ));
  assert.deepEqual(r.tasks, { items: [{ text: "Writing tests", status: "in_progress" }, { text: "Ship", status: "pending" }], done: 0, total: 2, active: "Writing tests" });
  assert.deepEqual(r.subagents, [{ description: "Map the flow", type: "Explore", status: "done" }]);
  assert.equal(r.context.tokens, 100_015);
  assert.equal(r.context.percent, 10);
  assert.equal(r.branch, "feature/x");
  assert.equal(r.tokens.requests, 4);
});

test("Codex: plan from update_plan, limits and context from token_count", () => {
  const r = liveCodex(jsonl(
    { timestamp: at, type: "session_meta", payload: { cwd: "/w/api" } },
    { timestamp: at, type: "turn_context", payload: { model: "gpt-5-codex", cwd: "/w/api" } },
    { timestamp: at, type: "response_item", payload: { type: "function_call", name: "update_plan",
      arguments: JSON.stringify({ plan: [{ step: "Read routes", status: "completed" }, { step: "Add rate limiter", status: "in_progress" }, { step: "Test", status: "pending" }] }) } },
    { timestamp: at, type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 54_400, cached_input_tokens: 50_000, output_tokens: 300 }, model_context_window: 272_000 },
      rate_limits: { primary: { used_percent: 31, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 9, window_minutes: 10080 } } } },
  ));
  assert.equal(r.cwd, "/w/api");
  assert.equal(r.tasks.done, 1);
  assert.equal(r.tasks.total, 3);
  assert.equal(r.tasks.active, "Add rate limiter");
  assert.equal(r.context.percent, 20);
  assert.deepEqual(r.limits.map((l) => [l.label, l.percent]), [["5-hour limit", 31], ["Weekly limit", 9]]);
  assert.equal(r.limits[0].resetsAt, Date.parse(at) + 3600_000);
});

test("Gemini: todos from write_todos, tokens and context", () => {
  const msg = { id: "g1", type: "gemini", timestamp: at, model: "gemini-3.1-pro-preview",
    toolCalls: [{ name: "write_todos", args: { todos: [{ description: "List files", status: "completed" }, { description: "Count lines", status: "in_progress" }, { description: "Summarise", status: "pending" }] } }],
    tokens: { input: 120_000, output: 500, cached: 100_000, thoughts: 200, tool: 0, total: 120_700 } };
  const r = liveGemini(jsonl({ sessionId: "s" }, { $set: { lastUpdated: at, messages: [{ id: "u1", type: "user" }, msg] } }));
  assert.deepEqual([r.tasks.done, r.tasks.total, r.tasks.active], [1, 3, "Count lines"]);
  assert.equal(r.context.percent, 12);
  assert.equal(r.model, "gemini-3.1-pro-preview");
  assert.ok(r.usd > 0);
});

test("Gemini /stats screen: the plan and daily limit only", () => {
  const screen = [
    "│ Auth Method      Signed in with Google (someone@example.com) │",
    "│ Tier             Google AI Pro                               │",
    "  23% used (Limit resets in 5h 12m)",
  ].join("\n");
  assert.deepEqual(geminiScreen(screen), { plan: "Google AI Pro", limit: { percent: 23, resetsIn: "5h 12m" } });
  assert.deepEqual(geminiScreen("Limit reached, resets in 2h"), { limit: { percent: 100, resetsIn: "2h" } });
  assert.deepEqual(geminiScreen("nothing here"), {});
});

test("task summaries and limit labels", () => {
  assert.deepEqual(taskSummary([{ text: "a", status: "cancelled" }, { text: "b", status: "deleted" }]), { items: [{ text: "a", status: "completed" }], done: 1, total: 1, active: null });
  assert.deepEqual(codexLimits(null), []);
});
