// Herdr's main layout against the copy the workspace-studio layout follows: when to say it changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutNotice, canonical } from "../mods/vsc/lib/layoutcheck.js";

const BASE = JSON.stringify({ id: "root", type: "row", children: [{ id: "tabs", type: "block", content: { mod: "tabs" } }] }, null, 2);

test("the same layout written in another key order or spacing is no change", () => {
  const same = '{"type":"row","children":[{"content":{"mod":"tabs"},"type":"block","id":"tabs"}],"id":"root"}';
  assert.equal(canonical(same), canonical(BASE));
  assert.deepEqual(layoutNotice({ base: BASE, current: same, seen: null }), { notice: false, fingerprint: null, reason: "same" });
});

test("a changed layout is noticed once: the version shown is remembered", () => {
  const changed = BASE.replace('"tabs"', '"tabs2"');
  const first = layoutNotice({ base: BASE, current: changed, seen: null });
  assert.equal(first.notice, true);
  assert.match(first.fingerprint, /^[0-9a-z]+$/);
  assert.deepEqual(layoutNotice({ base: BASE, current: changed, seen: first.fingerprint }), { notice: false, fingerprint: first.fingerprint, reason: "seen" });
  // A later, different version is noticed again.
  const again = layoutNotice({ base: BASE, current: changed.replace('"row"', '"column"'), seen: first.fingerprint });
  assert.equal(again.notice, true);
  assert.notEqual(again.fingerprint, first.fingerprint);
});

test("no file, or one that is not JSON (half written), is no notice", () => {
  assert.equal(layoutNotice({ base: BASE, current: null, seen: null }).notice, false);
  assert.equal(layoutNotice({ base: BASE, current: BASE.slice(0, 40), seen: null }).notice, false);
  assert.equal(canonical("{ nope"), null);
});

test("the shipped base is Herdr's main layout as valid JSON", () => {
  const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "mods", "vsc", "main-base.json"), "utf8");
  assert.notEqual(canonical(base), null);
  assert.equal(JSON.parse(base).id, "root");
});

test("each answer says why: missing, unreadable, same, seen or changed", () => {
  const changed = BASE.replace('"tabs"', '"tabs2"');
  assert.equal(layoutNotice({ base: BASE, current: null, seen: null }).reason, "missing");
  assert.equal(layoutNotice({ base: BASE, current: "{ half", seen: null }).reason, "unreadable");
  assert.equal(layoutNotice({ base: "{ half", current: BASE, seen: null }).reason, "base unreadable");
  assert.equal(layoutNotice({ base: BASE, current: BASE, seen: "x" }).reason, "same");
  const first = layoutNotice({ base: BASE, current: changed, seen: null });
  assert.equal(first.reason, "changed");
  assert.equal(layoutNotice({ base: BASE, current: changed, seen: first.fingerprint }).reason, "seen");
});
