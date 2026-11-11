// Explorer's file actions (new, rename, move, copy, trash, delete), run through the scripts in
// scripts.js on the Explorer's machine. Open tabs are looked after: an action that would touch a
// file with unsaved changes is refused; clean tabs of moved files are reopened under the new path.
import { exec, run, shared, setShared } from "herdr";
import { failure } from "./git.js";
import { FILE_NEW, FOLDER_NEW, ENTRY_MOVE, ENTRY_COPY, ENTRY_TRASH, ENTRY_DELETE, osNameArgs } from "./scripts.js";
import { copyName } from "./fileops.js";
import { fileKey, unsavedFiles, openFile, SIDE } from "./open.js";
import { intoItself } from "./fileops.js";

export const CLIP = "vsc.fileclip";       // { mode: "cut" | "copy", on, root, rel } for Paste
export const COMPARE = "vsc.compare-pick"; // { on, path } chosen with "Select for Compare"
export const CHANGED = "vsc.fs-changed";   // bumped after an action, so Explorer lists again

const MESSAGES = {
  2: "The Explorer's folder cannot be opened.",
  5: "That name is already taken here.",
  10: "That is not inside the Explorer's folder (or no longer exists).",
  11: "This machine has no trash (macOS trash or gio).",
};

async function script(code, on, ...args) {
  const r = await exec("sh", ["-c", code, "vsc", ...args], { on });
  if (r.code === 0) { setShared(CHANGED, Date.now()); return; }
  if (r.code === 12) { setShared(CHANGED, Date.now()); throw new Error(`The rename could not finish, and the old name was taken meanwhile: the entry is now at ${r.stdout.trim()}. Move it back by hand.`); }
  const error = new Error(MESSAGES[r.code] ?? failure(r));
  error.code = r.code;
  throw error;
}

const join = (root, rel) => (rel ? `${root}/${rel}` : root);
const parentOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

// Editors of `path` or of files below it, tabs and side panes: [{ key, id, path, side }].
function tabsUnder(on, path) {
  const prefix = fileKey(on, path), under = ([key]) => key === prefix || key.startsWith(`${prefix}/`);
  const entries = (map, side) => Object.entries(map ?? {}).filter(under).map(([key, id]) => ({ key, id, side, path: key.slice(key.indexOf("|") + 1) }));
  return [...entries(shared("vsc.tabs"), false), ...entries(shared(SIDE), true)];
}

// Refuses when a file at or below `path` has unsaved changes in its tab.
function ensureSaved(on, path) {
  const prefix = fileKey(on, path), unsaved = [...unsavedFiles()].filter(k => k === prefix || k.startsWith(`${prefix}/`));
  if (unsaved.length) throw new Error(`${unsaved.map(k => k.slice(k.indexOf("|") + 1).split("/").pop()).join(", ")} has unsaved changes: save or close it first.`);
}

function closeTabs(tabs) {
  for (const tab of tabs) run(tab.side ? "pane.close" : "tab.close", tab.side ? { pane: tab.id } : { id: tab.id });
}

export async function newFile(root, dirRel, name, on, cx) {
  await script(FILE_NEW, on, root, dirRel, name);
  await openFile(join(root, dirRel ? `${dirRel}/${name}` : name), on, cx);
}

export function newFolder(root, dirRel, name, on) {
  return script(FOLDER_NEW, on, root, dirRel, name);
}

// Rename or move `rel` into the folder `destRel` as `name`; tabs of moved files follow.
export async function move(root, rel, destRel, name, on, cx) {
  if (intoItself(rel, destRel)) throw new Error("A folder cannot be moved into itself.");
  const from = join(root, rel), to = join(root, destRel ? `${destRel}/${name}` : name);
  ensureSaved(on, from);
  const tabs = tabsUnder(on, from);
  await script(ENTRY_MOVE, on, root, rel, destRel, name);
  closeTabs(tabs);
  for (const tab of tabs) await openFile(to + tab.path.slice(from.length), on, cx);
}

export const rename = (root, rel, name, on, cx) => move(root, rel, parentOf(rel), name, on, cx);

// The names in a folder, to pick a free name for a copy.
async function namesIn(root, dirRel, on) {
  const r = await exec("sh", ["-c", 'cd -P -- "$1" || exit 2; for p in ./* ./.[!.]* ./..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; printf "%s\\0" "${p#./}"; done', "vsc", join(root, dirRel)], { on });
  if (r.code !== 0) throw new Error(MESSAGES[r.code] ?? failure(r));
  return new Set(r.stdout.split("\0").filter(Boolean));
}

// Paste what Cut or Copy picked into the folder `destRel`. A copy takes a free "… copy" name;
// a cut keeps its name and is refused when it is taken.
export async function paste(root, destRel, on, cx) {
  const clip = shared(CLIP);
  if (!clip || clip.root !== root || (clip.on ?? null) !== (on ?? null)) throw new Error("Nothing to paste here: cut or copy something in this folder first.");
  const name = clip.rel.split("/").pop();
  if (clip.mode === "cut") {
    await move(root, clip.rel, destRel, name, on, cx);
    setShared(CLIP, null);
  } else {
    if (intoItself(clip.rel, destRel)) throw new Error("A folder cannot be pasted into itself.");
    await script(ENTRY_COPY, on, root, clip.rel, destRel, copyName(name, await namesIn(root, destRel, on)));
  }
}

// To the trash; { noTrash: true } when the machine has none (the caller may offer deleting for good).
export async function trash(root, rel, on) {
  const path = join(root, rel);
  ensureSaved(on, path);
  const tabs = tabsUnder(on, path);
  try { await script(ENTRY_TRASH, on, root, rel); }
  catch (e) { if (e.code === 11) return { noTrash: true }; throw e; }
  closeTabs(tabs);
  return { noTrash: false };
}

export async function deleteForGood(root, rel, on) {
  const path = join(root, rel);
  ensureSaved(on, path);
  const tabs = tabsUnder(on, path);
  await script(ENTRY_DELETE, on, root, rel);
  closeTabs(tabs);
}

// Shows the entry in Finder (macOS) or its folder in the file manager (Linux); this computer only.
export async function reveal(path) {
  const [uname, unameArgs] = osNameArgs();
  const os = await exec(uname, unameArgs).catch(() => null);
  const mac = os?.stdout.trim() === "Darwin";
  // macOS's open by its fixed path, not whatever PATH finds first.
  const r = await exec(mac ? "/usr/bin/open" : "xdg-open", mac ? ["-R", path] : [path.slice(0, path.lastIndexOf("/")) || "/"]);
  if (r.code !== 0) throw new Error(failure(r));
}
