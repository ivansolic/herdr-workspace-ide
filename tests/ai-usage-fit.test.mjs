import { test } from "node:test";
import assert from "node:assert/strict";
import { usageParts, usageRows, heightFor, HEIGHTS } from "../mods/ai-usage/lib/fit.js";

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

test("a tiny pane puts each part on its own row, and every row fits in the header", () => {
  const rows = usageRows(facts, 170, false, now);
  assert.equal(rows, 5);
  // A title row of 18 px and 3 px around, then each wrapped row as drawn (about 19 px).
  assert.ok(heightFor(rows) >= 3 + 18 + rows * 19, `${heightFor(rows)} px for ${rows} rows`);
  // With its separator, each part fits across the pane (less its 10 px sides).
  for (const [i, size] of usageParts(facts, 170, false, now).entries()) assert.ok(size + (i ? 14 : 0) <= 150, `part ${i}: ${Math.round(size)} px`);
});
