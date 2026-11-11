// Tab names: which terminal tabs get a name of their own, what it is, and that names people give stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tabRenames, NAME_LIMIT } from "../mods/vsc/lib/tabnames.js";

const HOME = "/Users/me";
const tab = (id, extra = {}) => ({ id, name: extra.name ?? "1", named: false, ...extra });
const space = (tabs, machine = null) => ({ id: `sp-${tabs[0].id}`, machine, tabs });
const shell = (p, t, cwd, branch = null) => ({ pane: p, terminal: `t-${p}`, tab: t, cwd, branch, program: { name: "zsh" } });
const modPane = (p, t) => ({ pane: p, terminal: null, mod: "vsc", tab: t, cwd: null, branch: null });
const agent = (p, t, name = "Claude Code") => ({ pane: p, tab: t, program: { name } });
const run = (over = {}) => tabRenames({ spaces: [], panes: [], agents: [], agentKeys: new Set(), home: HOME, remembered: {}, ready: () => true, ...over });

test("a shell tab is named after its folder and branch, ~ at home, the folder alone without git", () => {
  const r = run({
    spaces: [space([tab("a"), tab("b", { name: "2" }), tab("c", { name: "3" })])],
    panes: [shell("p1", "a", "/code/herdr-vscode-like", "main"), shell("p2", "b", HOME), shell("p3", "c", "/tmp/notes")],
  });
  assert.deepEqual(r.renames, [{ id: "a", name: "herdr-vscode-like · main" }, { id: "b", name: "~" }, { id: "c", name: "notes" }]);
  assert.deepEqual(r.remembered, {
    a: { name: "herdr-vscode-like · main", was: ["1"], sent: ["herdr-vscode-like · main"], tries: 0 },
    b: { name: "~", was: ["2"], sent: ["~"], tries: 0 },
    c: { name: "notes", was: ["3"], sent: ["notes"], tries: 0 },
  });
});

test("an agent's tab is named after the agent and its folder; with several, the first in pane order", () => {
  const r = run({
    spaces: [space([tab("a")])],
    panes: [shell("p1", "a", "/code/shop", "dev"), shell("p2", "a", "/code/api")],
    agents: [agent("p2", "a", "Codex"), agent("p1", "a")],
  });
  // p1 comes first in the tab, whatever order the agents are listed in.
  assert.deepEqual(r.renames, [{ id: "a", name: "Claude Code · shop" }]);
});

test("the first terminal pane decides, not a mod pane in front of it", () => {
  const r = run({ spaces: [space([tab("a")])], panes: [modPane("m", "a"), shell("p1", "a", "/code/shop")] });
  assert.deepEqual(r.renames, [{ id: "a", name: "shop" }]);
});

test("tabs with only mod panes (editor, diagram, PDF tabs) are never touched", () => {
  const r = run({ spaces: [space([tab("e", { name: "notes.md", named: true })])], panes: [modPane("m", "e")] });
  assert.deepEqual(r.renames, []);
  assert.deepEqual(r.remembered, {});
});

test("a tab someone named is left alone, and stays left alone", () => {
  const panes = [shell("p1", "a", "/code/shop", "main")];
  // Named by hand before this mod ever named it.
  assert.deepEqual(run({ spaces: [space([tab("a", { name: "deploy", named: true })])], panes }).renames, []);
  // Named by this mod, then renamed by hand: forgotten, so a later folder change does not rename it.
  const r = run({ spaces: [space([tab("a", { name: "deploy", named: true })])], panes, remembered: { a: { name: "shop · main" } } });
  assert.deepEqual(r.renames, []);
  assert.deepEqual(r.remembered, {});
});

test("a tab this mod named follows its terminal; an unchanged name is not set again", () => {
  const spaces = [space([tab("a", { name: "shop · main", named: true })])];
  const moved = run({ spaces, panes: [shell("p1", "a", "/code/api", "main")], remembered: { a: { name: "shop · main" } } });
  assert.deepEqual(moved.renames, [{ id: "a", name: "api · main" }]);
  const same = run({ spaces, panes: [shell("p1", "a", "/code/shop", "main")], remembered: { a: { name: "shop · main" } } });
  assert.deepEqual(same.renames, []);
  assert.deepEqual(same.remembered, { a: { name: "shop · main" } });
});

test("a tab renamed back to nothing (unnamed again) gets an automatic name again", () => {
  const r = run({ spaces: [space([tab("a", { name: "1", named: false })])], panes: [shell("p1", "a", "/code/shop")] });
  assert.deepEqual(r.renames, [{ id: "a", name: "shop" }]);
});

test("names are cut to NAME_LIMIT characters with an ellipsis", () => {
  const long = "/code/" + "a".repeat(60);
  const [{ name }] = run({ spaces: [space([tab("a")])], panes: [shell("p1", "a", long, "feature/very-long-branch-name")] }).renames;
  assert.equal([...name].length, NAME_LIMIT);
  assert.ok(name.endsWith("…"));
});

test("a terminal without a known folder, and tabs on a machine that is not ready, are skipped", () => {
  const r = run({
    spaces: [space([tab("a")]), space([tab("vps/b")], "vps")],
    panes: [shell("p1", "a", null), shell("vps/p2", "vps/b", "/srv/app")],
    remembered: { "vps/b": { name: "app" } },
    ready: (machine) => machine === null,
  });
  assert.deepEqual(r.renames, []);
  // Kept: that machine's tabs are only out of reach for now.
  assert.deepEqual(r.remembered, { "vps/b": { name: "app" } });
});

test("remembered names of closed tabs are dropped", () => {
  const r = run({ spaces: [space([tab("a", { name: "shop", named: true })])], panes: [shell("p1", "a", "/code/shop")],
    remembered: { a: { name: "shop" }, gone: { name: "api" }, "vps/x": { name: "app" } } });
  // "vps" is ready (ready() is true for every machine here) and has no such tab: it is gone too.
  assert.deepEqual(r.remembered, { a: { name: "shop" } });
});

test("on another machine, ~ is not used for this computer's home", () => {
  const r = run({ spaces: [space([tab("vps/a")], "vps")], panes: [shell("vps/p1", "vps/a", HOME)] });
  assert.deepEqual(r.renames, [{ id: "vps/a", name: "me" }]);
});

test("an agent that reports no status is still named by its program, when Herdr knows that program as an agent", () => {
  // As Herdr reports Claude Code without its status hook: agent is false, the key is a known agent's.
  const claude = { ...shell("p2", "a", "/code/shop", "main"), program: { key: "claude", name: "Claude Code", agent: false } };
  const vim = { ...shell("p3", "b", "/code/api"), program: { key: "nvim", name: "Neovim", agent: false } };
  const r = run({ spaces: [space([tab("a"), tab("b", { name: "2" })])], panes: [shell("p1", "a", "/code/api"), claude, vim], agentKeys: new Set(["claude", "codex"]) });
  assert.deepEqual(r.renames, [{ id: "a", name: "Claude Code · shop" }, { id: "b", name: "api" }]);
});

// Names are forgotten only on evidence: the tab carries another name on a machine that is ready, or that
// machine is ready and the tab is gone. A tab out of sight keeps its entry.
test("while this computer's layout is not ready (its tabs not listed yet), remembered names are kept", () => {
  const remembered = { a: { name: "shop · main" }, "vps/b": { name: "app" } };
  const r = run({ spaces: [], remembered, ready: () => false });
  assert.deepEqual(r.remembered, remembered);
});

test("a tab whose terminals are not listed yet keeps its remembered name", () => {
  const remembered = { a: { name: "shop · main" } };
  const r = run({ spaces: [space([tab("a", { name: "shop · main", named: true })])], panes: [], remembered });
  assert.deepEqual(r.renames, []);
  assert.deepEqual(r.remembered, remembered);
});

test("a rename that has not shown up yet does not make the tab someone else's", () => {
  const panes = [shell("p1", "vps/a", "/srv/app", "dev")];
  // Tick 1: the folder changed from main to dev.
  const t1 = run({ spaces: [space([tab("vps/a", { name: "app · main", named: true })], "vps")], panes, remembered: { "vps/a": { name: "app · main" } } });
  assert.deepEqual(t1.renames, [{ id: "vps/a", name: "app · dev" }]);
  // Tick 2: the tab still shows the old name (slow machine): still ours, no second rename yet.
  const t2 = run({ spaces: [space([tab("vps/a", { name: "app · main", named: true })], "vps")], panes, remembered: t1.remembered });
  assert.deepEqual(t2.renames, []);
  assert.equal(t2.remembered["vps/a"].name, "app · dev");
  // Tick 3: the rename landed; it is a settled name of ours again.
  const t3 = run({ spaces: [space([tab("vps/a", { name: "app · dev", named: true })], "vps")], panes, remembered: t2.remembered });
  assert.deepEqual(t3.renames, []);
  assert.deepEqual(t3.remembered, { "vps/a": { name: "app · dev" } });
});

test("a rename that never lands is tried again only a few times, not every tick", () => {
  const spaces = [space([tab("a", { name: "app · main", named: true })])], panes = [shell("p1", "a", "/srv/app", "dev")];
  let remembered = { a: { name: "app · main" } }, sent = 0, lastChange = 0;
  for (let tick = 0; tick < 300; tick++) {
    const r = run({ spaces, panes, remembered });
    sent += r.renames.length;
    if (JSON.stringify(r.remembered) !== JSON.stringify(remembered)) lastChange = tick;
    remembered = r.remembered;
    assert.ok(remembered.a, `forgotten at tick ${tick}`);
  }
  assert.ok(sent >= 2 && sent <= 5, `sent ${sent} renames`);
  // The remembered names (shared state: every change re-renders every mod) stop changing.
  assert.ok(lastChange < 150, `still changing at tick ${lastChange}`);
});

test("the first agent in pane order names the tab, whether it reports its status or not", () => {
  const claude = { ...shell("p1", "a", "/code/shop"), program: { key: "claude", name: "Claude Code", agent: false } };
  const codex = { ...shell("p2", "a", "/code/api"), program: { key: "codex", name: "Codex", agent: true } };
  const r = run({ spaces: [space([tab("a")])], panes: [claude, codex], agents: [agent("p2", "a", "Codex")], agentKeys: new Set(["claude"]) });
  assert.deepEqual(r.renames, [{ id: "a", name: "Claude Code · shop" }]);
});

// Several renames on their way at once (a machine slower than one check): every name sent may still show.
const step = (name, cwd, branch, remembered) =>
  run({ spaces: [space([tab("vps/a", { name, named: true })], "vps")], panes: [shell("p1", "vps/a", cwd, branch)], remembered });

test("two changes before the first rename shows: neither name makes the tab someone else's", () => {
  const t1 = step("app · main", "/srv/app", "dev", { "vps/a": { name: "app · main" } });        // sends "app · dev"
  const t2 = step("app · main", "/srv/app", "fix", t1.remembered);                              // sends "app · fix"
  assert.deepEqual(t2.renames, [{ id: "vps/a", name: "app · fix" }]);
  const t3 = step("app · dev", "/srv/app", "fix", t2.remembered);                               // the first lands
  assert.ok(t3.remembered["vps/a"], "forgotten when the first rename showed");
  const t4 = step("app · fix", "/srv/app", "fix", t3.remembered);                               // the second lands
  assert.equal(t4.remembered["vps/a"].name, "app · fix");
  assert.deepEqual(t4.renames, []);
});

test("a change that goes back before its rename shows: the late rename is still the mod's", () => {
  const t1 = step("app · main", "/srv/app", "dev", { "vps/a": { name: "app · main" } });        // sends "app · dev"
  const t2 = step("app · main", "/srv/app", "main", t1.remembered);                             // back on main
  assert.deepEqual(t2.renames, []);
  const t3 = step("app · dev", "/srv/app", "main", t2.remembered);                              // the late rename lands
  assert.ok(t3.remembered["vps/a"], "forgotten when the late rename showed");
  assert.deepEqual(t3.renames, [{ id: "vps/a", name: "app · main" }]);
});

test("names remembered by earlier versions of this mod are read", () => {
  const panes = [shell("p1", "a", "/code/api")];
  const bare = run({ spaces: [space([tab("a", { name: "shop", named: true })])], panes, remembered: { a: "shop" } });
  assert.deepEqual(bare.renames, [{ id: "a", name: "api" }]);
  const single = run({ spaces: [space([tab("a", { name: "1", named: true })])], panes, remembered: { a: { name: "api", was: "1", tries: 2 } } });
  assert.ok(single.remembered.a, "a pending rename saved with a single was was not read");
});
