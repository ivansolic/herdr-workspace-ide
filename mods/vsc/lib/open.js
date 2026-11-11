// Opening files in editors: one editor per file (a tab, or a side pane from "Open to the Side"),
// focusing it when it is already open, plus the shared set of files with unsaved changes.
// Two editors of one file would overwrite each other's unsaved mark and draft.
import { run, spaces, panes, shared, setShared } from "herdr";
import { baseName } from "./files.js";
import { liveOnly, addedIds } from "./registry.js";

export const MOD = "vsc";
const TABS = "vsc.tabs";   // { "<machine>|<path>": tabId }
export const SIDE = "vsc.side"; // { "<machine>|<path>": paneId } editors opened to the side
const DIRTY = "vsc.dirty"; // ["<machine>|<path>", ...]
export const RECENT = "vsc.recent"; // ["<machine>|<path>", ...], most recent first
const RECENT_LIMIT = 50;

export const fileKey = (on, path) => `${on ?? ""}|${path}`;
const pathOfKey = (key) => key.slice(key.indexOf("|") + 1);

function openTabIds() {
  return new Set(spaces().flatMap(s => s.tabs?.map(t => t.id) ?? []));
}

function remember(on, path, id) {
  const tabs = liveOnly(shared(TABS), openTabIds());
  if (id) tabs[fileKey(on, path)] = id;
  setShared(TABS, tabs);
}

const vscPaneIds = () => new Set(panes().filter(p => p.mod === MOD).map(p => p.pane));

// The side pane already showing this file, if it is still open.
export function sideFor(on, path) {
  const id = shared(SIDE)?.[fileKey(on, path)];
  return id && vscPaneIds().has(id) ? id : null;
}

// Shows the file's editor if it has one (tab or side pane); true when it did.
function showExisting(on, path) {
  const tab = tabFor(on, path), side = sideFor(on, path);
  if (tab) run("tab.select", { id: tab });
  else if (side) run("pane.focus", { pane: side });
  return Boolean(tab || side);
}

// "Open to the Side": a new editor pane beside the current one, unless the file already has an
// editor, which is shown instead. The new pane is found as the one vsc pane that was not there.
export function openToSide(path, on, cx) {
  return openToSideWith(path, on, { view: "editor", file: path, on: on ?? null }, cx);
}

// `path` names what the pane shows (a file, or a diagram in one): one pane per name.
async function openToSideWith(path, on, props, cx) {
  if (showExisting(on, path)) return;
  const before = vscPaneIds();
  run("pane.split", { direction: "right", mod: MOD, props });
  for (let attempt = 0; attempt < 10; attempt++) {
    const added = addedIds(before, vscPaneIds());
    if (added) { setShared(SIDE, { ...liveOnly(shared(SIDE), vscPaneIds()), [fileKey(on, path)]: added }); return; }
    if (!cx) return;
    await cx.sleep(50);
  }
}

// The tab already showing this file, if it is still open.
export function tabFor(on, path) {
  const id = shared(TABS)?.[fileKey(on, path)];
  return id && openTabIds().has(id) ? id : null;
}

// For an editor whose tab is not on record (for example made by another tool): the one tab named
// after the file with a vsc pane in it, and only when no other known file shares that name.
export function claimTab(on, path) {
  const known = tabFor(on, path);
  if (known) return known;
  const name = baseName(path), map = shared(TABS) ?? {};
  if (Object.keys(map).some(k => k !== fileKey(on, path) && baseName(pathOfKey(k)) === name)) return null;
  const claimed = new Set(Object.values(map)), names = new Set([name, `● ${name}`]);
  const vscTabs = new Set(panes().filter(p => p.mod === MOD).map(p => p.tab));
  const candidates = spaces().flatMap(s => s.tabs ?? []).filter(t => vscTabs.has(t.id) && names.has(t.name) && !claimed.has(t.id));
  if (candidates.length !== 1) return null;
  remember(on, path, candidates[0].id);
  return candidates[0].id;
}

const opening = new Set();

// Opens a vsc tab for `key` (one tab per key), or shows the one it already has.
// `run` returns nothing to a mod, so the new tab is found as the one id that was not there before.
async function openTab(key, name, props, cx) {
  const split = key.indexOf("|"), on = key.slice(0, split) || null, path = key.slice(split + 1);
  if (showExisting(on, path)) return;
  if (opening.has(key)) return; // a double click while the first open is still in progress
  opening.add(key);
  try {
    const before = openTabIds();
    run("tab.new", { name, mod: MOD, props });
    for (let attempt = 0; attempt < 10; attempt++) {
      const after = openTabIds(), added = addedIds(before, after);
      if (added) { remember(on, path, added); return; }
      if (after.size - before.size > 1 || !cx) return; // ambiguous (another tab opened at the same time): don't guess
      await cx.sleep(50);
    }
  } finally { opening.delete(key); }
}

function markRecent(key) {
  setShared(RECENT, [key, ...(shared(RECENT) ?? []).filter(k => k !== key)].slice(0, RECENT_LIMIT));
}

// Opens `path` (on machine `on`, null = this computer) in an editor tab. `label` names the tab
// (default: the file name); `recent: false` keeps it out of Quick Open's recent files (a picture
// copied out of a document is not a file of the project).
export function openFile(path, on, cx, { label = baseName(path), recent = true } = {}) {
  if (recent) markRecent(fileKey(on, path));
  return openTab(fileKey(on, path), label, { view: "editor", file: path, on: on ?? null }, cx);
}

// A Mermaid block of a Markdown file (`index` from 1), drawn in its own tab or a pane to the side.
export const diagramPath = (file, index) => `${file}#diagram-${index}`;
export function openDiagram(file, index, on, cx, { side = false } = {}) {
  const props = { view: "diagram", file, index, on: on ?? null };
  if (side) return openToSideWith(diagramPath(file, index), on, props, cx);
  return openTab(fileKey(on, diagramPath(file, index)), `${baseName(file)} · Diagram ${index}`, props, cx);
}

// Opens the changes of `path` (relative to the repository `root`) against HEAD in a diff tab.
export function openDiff(root, path, on, status, cx) {
  return openTab(fileKey(on, `diff:${root}/${path}`), `${baseName(path)} (changes)`, { view: "diff", root, path, on: on ?? null, status }, cx);
}

// The last file saved from an editor tab ({ key, at }), so Problems can check again.
export const SAVED = "vsc.saved";

export function markSaved(on, path) {
  setShared(SAVED, { key: fileKey(on, path), at: Date.now() });
}

// Compares two files of one machine in a tab ("Compare with Selected").
export function openCompare(left, right, on, cx) {
  return openTab(fileKey(on, `compare:${left}|${right}`), `${baseName(left)} ↔ ${baseName(right)}`, { view: "compare", left, right, on: on ?? null }, cx);
}

export function unsavedFiles() {
  return new Set(shared(DIRTY) ?? []);
}

export function markUnsaved(on, path, unsaved) {
  const files = unsavedFiles(), key = fileKey(on, path);
  if (files.has(key) === unsaved) return;
  if (unsaved) files.add(key); else files.delete(key);
  setShared(DIRTY, [...files]);
}
