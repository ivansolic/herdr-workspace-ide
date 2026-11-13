import { test } from "node:test";
import assert from "node:assert/strict";
import { usageRows, heightFor, HEIGHTS } from "../mods/ai-usage/lib/fit.js";

const now = Date.parse("2026-11-13T08:00:00Z");
const facts = {
  plan: "Team · Standard seat",
  limits: [{ label: "5h", percent: 6, resetsAt: now + 4 * 3600e3 }, { label: "Week", percent: 60, resetsAt: now + 4 * 86400e3 }],
  context: { percent: 15, tokens: 150_000, window: 1_000_000 },
  cost: 75.83,
};

test("a narrow pane's header takes as many rows as its usage needs, so the cost is never cut off", () => {
  const rows = usageRows(facts, 350, false, now);
  assert.ok(rows >= 3, `${rows} rows at 350 px`);
  assert.ok(heightFor(rows) > HEIGHTS.two);
});

test("wide panes keep one or two rows", () => {
  assert.equal(usageRows(facts, 1400, true, now), 1);
  assert.equal(usageRows(facts, 800, true, now), 2);
  assert.equal(heightFor(1), HEIGHTS.one);
  assert.equal(heightFor(2), HEIGHTS.two);
});
