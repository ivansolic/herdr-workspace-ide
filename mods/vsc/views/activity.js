// Activity rail: one icon per view. Click shows that view; clicking the shown one folds the panel.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, layout, run, shared, setShared, nextCommand, openOverlay, spaces, panes, agents, machines, home, knownAgents, readTextFile, appHome, notify } from "herdr";
import { location } from "../lib/location.js";
import { PROBLEM_COUNT } from "../lib/problems.js";
import { MOD, openCompare } from "../lib/open.js";
import { icon, VIEWS_ID } from "../lib/ui.js";
import { tidy } from "../lib/storage.js";
import { tabRenames } from "../lib/tabnames.js";
import { layoutNotice } from "../lib/layoutcheck.js";

const ITEMS = [
  { id: "vsc-explorer", label: "Explorer", icon: "files", command: "explorer" },
  // Herdr's own Changes panel (the shipped `changes` mod), as in its main layout.
  { id: "vsc-changes", label: "Changes", icon: "file-diff", command: "changes" },
  { id: "vsc-scm", label: "Source Control", icon: "git-branch", command: "scm" },
  { id: "vsc-search", label: "Search", icon: "search", command: "search" },
  { id: "vsc-problems", label: "Problems", icon: "triangle-alert", command: "problems" },
  // AI usage (the `ai-usage` mod): every agent's subscriptions, limits, cost and models.
  { id: "vsc-usage", label: "AI usage", icon: "gauge", command: "usage" },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const FOLD_BELOW = 150, DEFAULT_WIDTH = 320;

function views() {
  const node = find(layout(), VIEWS_ID);
  return { shown: Boolean(node && !node.hidden), active: node?.active, width: node?.size?.px };
}

// Like Herdr's sidebar: dragging the panel narrower than FOLD_BELOW folds it to the rail,
// and it comes back at the last comfortable width.
function foldIfNarrow() {
  const { shown, width } = views();
  if (!shown || width === undefined) return;
  if (width >= FOLD_BELOW) { if (shared("vsc.width") !== width) setShared("vsc.width", width); return; }
  run("layout.hide", { id: VIEWS_ID });
  run("layout.resize", { id: VIEWS_ID, px: shared("vsc.width") ?? DEFAULT_WIDTH });
}

// The rail replaces Herdr's Files/Changes tab-bar buttons. That setting is shared by every layout,
// so the previous value is kept and put back when this layout goes (restorePanelButtons, from close).
const PANELS = "workspace.panels", PANELS_BEFORE = "vsc.panels-before";

function hidePanelButtons() {
  if (shared(PANELS_BEFORE) === undefined || shared(PANELS_BEFORE) === null)
    // An empty list is what this rail sets itself (left over from a crash), so it counts as "not set".
    setShared(PANELS_BEFORE, { value: shared(PANELS)?.length ? shared(PANELS) : null });
  if (shared(PANELS)?.length !== 0) setShared(PANELS, []);
}

export function restorePanelButtons() {
  const before = shared(PANELS_BEFORE);
  if (!before) return;
  setShared(PANELS, before.value ?? ["files", "changes"]);
  setShared(PANELS_BEFORE, null);
}

// Terminal tabs carry the agent in them, else their folder and branch (lib/tabnames.js). The names given
// here are remembered across restarts, so a name someone gives by hand is never replaced.
const AUTONAMES = "vsc.autonames";

function nameTabs(agentKeys) {
  const ready = new Map(machines().map(m => [m.name, m.layout === "ready"]));
  const before = shared(AUTONAMES) ?? {};
  const { renames, remembered } = tabRenames({ spaces: spaces(), panes: panes(), agents: agents(), agentKeys, home: home(), remembered: before,
    ready: (machine) => ready.get(machine) ?? false });
  // Remembered first: the next check must see a renamed tab as one named here.
  if (JSON.stringify(remembered) !== JSON.stringify(before)) setShared(AUTONAMES, remembered);
  for (const { id, name } of renames) run("tab.rename", { id, name });
}

// The workspace-ide layout is built from parts of Herdr's main layout, which Herdr replaces on updates: a changed
// main is said once per version (its fingerprint remembered), and the notice opens both side by side.
const MAIN_SEEN = "vsc.main-seen";
const mainBase = () => `${appHome()}/mods/${MOD}/main-base.json`, mainNow = () => `${appHome()}/layouts/main.json`;

async function checkMainLayout() {
  const [base, current] = await Promise.all([readTextFile(mainBase()), readTextFile(mainNow())]);
  if (base === null) { console.log(`vsc: ${mainBase()} is missing; Herdr's main layout is not compared`); return; }
  const { notice, fingerprint, reason } = layoutNotice({ base, current, seen: shared(MAIN_SEEN) ?? null });
  if (reason === "missing" || reason === "unreadable") console.log(`vsc: ${mainNow()} is ${reason}; Herdr's main layout is not compared (checked again in 10 minutes)`);
  if (reason === "base unreadable") console.log(`vsc: ${mainBase()} is not valid JSON; Herdr's main layout is not compared`);
  // Back to the base (the base was brought up to date): a later return to that old version is told again.
  if (reason === "same" && shared(MAIN_SEEN)) setShared(MAIN_SEEN, null);
  if (!notice) return;
  // Remembered before it shows, so another window's check does not show it again.
  setShared(MAIN_SEEN, fingerprint);
  notify({ title: "Herdr's main layout changed", body: "It differs from the one the workspace-ide layout was made from. Click to compare them.",
    level: "info", action: { name: `${MOD}.comparemain` } });
}

// Show `id` in the panel; when it is already the shown view and `fold` is set, fold the panel.
function open(id, fold) {
  const { shown, active } = views();
  if (shown && active === id) { if (fold) run("layout.hide", { id: VIEWS_ID }); return; }
  run("layout.select", { stack: VIEWS_ID, child: id });
  if (!shown) run("layout.show", { id: VIEWS_ID });
}

// cmd-p: the Quick Open dialog for the focused terminal's folder (the dialog itself has no folder).
function quickOpen() {
  const { cwd, on } = location();
  openOverlay({ mod: MOD, kind: "dialog", width: 600, height: 520, props: { view: "quickopen", cwd: cwd ?? null, on: on ?? null } });
}

export default class Activity extends View {
  init(_props, cx) {
    hidePanelButtons();
    cx.spawn(async () => {
      try { await tidy(); }
      catch (e) { console.log(`vsc: draft cleanup failed: ${e?.message ?? e}`); }
    });
    // Checked on a timer, not in render: render must not run layout commands.
    cx.timer.every(250, () => foldIfNarrow());
    // The agents Herdr knows (programs.json), asked now and every 5 minutes; Herdr caches the answer.
    this.agentKeys = new Set();
    const learnAgents = (cx) => cx.spawn(async () => {
      try { this.agentKeys = new Set((await knownAgents()).map(a => a.key)); }
      catch (e) { console.log(`vsc: could not list agents for tab names: ${e?.message ?? e}`); }
    });
    learnAgents(cx);
    cx.timer.every(5 * 60 * 1000, (cx) => learnAgents(cx));
    cx.timer.every(2000, () => nameTabs(this.agentKeys));
    const compareMain = (cx) => cx.spawn(async () => {
      try { await checkMainLayout(); }
      catch (e) { console.log(`vsc: could not compare Herdr's main layout: ${e?.message ?? e}`); }
    });
    compareMain(cx);
    cx.timer.every(10 * 60 * 1000, (cx) => compareMain(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand()).split(".").pop();
        const item = ITEMS.find(i => i.command === command);
        if (item) open(item.id, true);
        else if (command === "quickopen") quickOpen();
        else if (command === "comparemain") openCompare(mainBase(), mainNow(), null, cx);
        else if (command === "toggle") { const { shown } = views(); run(shown ? "layout.hide" : "layout.show", { id: VIEWS_ID }); }
        cx.notify();
      }
    });
  }

  // The Problems icon carries the count: red with errors, the warning color with warnings only.
  badge(t) {
    const count = shared(PROBLEM_COUNT), total = (count?.errors ?? 0) + (count?.warnings ?? 0);
    if (!total) return null;
    return div().absolute().right(1).bottom(1).min_w(14).h(14).px(3).flex().items_center().justify_center().rounded(7)
      .bg(count.errors ? t.ansi1 : t.blocked).text_color(t.background).text_size(9).font_semibold()
      .child(total > 99 ? "99+" : String(total));
  }

  render() {
    const t = theme(), { shown, active } = views(), badge = this.badge(t);
    return v_flex().id("vsc-activity").size_full().pt(8).gap(4).items_center().bg(t.chrome)
      .children(ITEMS.map(item => {
        const on = shown && active === item.id;
        return div().id(`vsc-activity-${item.command}`).relative().size(34).flex().items_center().justify_center().rounded(7).cursor_pointer()
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(item.label)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { open(item.id, true); cx.notify(); })
          .child(icon(item.icon).size(18))
          .when(item.command === "problems" && Boolean(badge), el => el.child(badge));
      }));
  }
}
