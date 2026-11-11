// The package's folders under the app home: drafts of unsaved text, the image preview cache and
// the compiled PDF renderer.
// Each folder gets a .gitignore of "*" so a dotfiles repo never picks up drafts (they can hold code or notes).
import * as fs from "fs/promises";
import { appHome, exec, readTextFile, shared, setShared } from "herdr";
import { parseDraft, cleanupDraft } from "./editing.js";
import { draftName } from "./files.js";
import { tabFor } from "./open.js";
import { privateFolderArgs } from "./scripts.js";

export const DRAFTS = "vsc-drafts", CACHE = "vsc-cache", TOOLS = "vsc-tools";
const CHECK_OUTPUT_MS = 15 * 60 * 1000; // longer than a check may run

export function folderPath(name) {
  return `${appHome()}/${name}`;
}

export async function ensureFolder(name) {
  const path = folderPath(name);
  await fs.mkdir(path, { recursive: true });
  // Only this user may enter: drafts can hold any file's text, and the home folder is often group-readable.
  const r = await exec("chmod", privateFolderArgs(path));
  if (r.code !== 0) throw new Error(`Cannot protect ${name}: ${r.stderr.trim()}`);
  if (!(await fs.exists(`${path}/.gitignore`))) await fs.writeFile(`${path}/.gitignore`, "*\n");
  return path;
}

// Run once when the workbench starts: drop drafts that are no longer needed (cleanupDraft) and
// forget unsaved marks that have neither a draft nor an open tab.
export async function tidy() {
  const drafts = folderPath(DRAFTS), keep = new Set();
  for (const name of [DRAFTS, CACHE, TOOLS]) if (await fs.exists(folderPath(name))) await ensureFolder(name);
  if (await fs.exists(drafts)) {
    for (const name of await fs.readdir(drafts)) {
      if (!name.endsWith(".txt")) continue;
      try {
        const draft = parseDraft(await fs.readFile(`${drafts}/${name}`, "utf8").catch(() => ""));
        if (!draft) continue; // old or half-written drafts are judged when their file is opened
        const current = draft.on ? null : await readTextFile(draft.path).catch(() => null);
        if (cleanupDraft(draft, current) === "delete") await fs.unlink(`${drafts}/${name}`);
        else keep.add(`${draft.on ?? ""}|${draft.path}`);
      } catch (e) { console.log(`vsc: skipped draft ${name}: ${e?.message ?? e}`); }
    }
  }
  // Image copies belong to an open tab; anything else is left over from a crash or quit.
  const cache = folderPath(CACHE);
  if (await fs.exists(cache)) {
    const open = Object.keys(shared("vsc.tabs") ?? {}).map(key => {
      const split = key.indexOf("|");
      return `${draftName(key.slice(0, split) || null, key.slice(split + 1)).replace(/\.txt$/, "")}-`;
    });
    // One entry that cannot be removed (a folder, a permission problem) must not stop the rest.
    for (const name of await fs.readdir(cache)) {
      if (name === ".gitignore" || open.some(prefix => name.startsWith(prefix))) continue;
      // Output of a check that may still be running (the name starts with its start time in ms).
      const started = /^problems-(\d+)-/.exec(name);
      if (started && Date.now() - Number(started[1]) < CHECK_OUTPUT_MS) continue;
      try { await fs.unlink(`${cache}/${name}`); }
      catch (e) { console.log(`vsc: could not remove cache entry ${name}: ${e?.message ?? e}`); }
    }
  }
  const unsaved = (shared("vsc.dirty") ?? []).filter(key => {
    const split = key.indexOf("|"), on = key.slice(0, split) || null, path = key.slice(split + 1);
    return keep.has(key) || tabFor(on, path);
  });
  setShared("vsc.dirty", unsaved);
}

// An image tab's copies, deleted when that tab goes (its block's close()).
export async function dropImageCopies(on, path) {
  const cache = folderPath(CACHE), prefix = `${draftName(on, path).replace(/\.txt$/, "")}-`;
  if (!(await fs.exists(cache))) return;
  // One entry that cannot be removed (a folder left by an interrupted unpacking) must not keep the rest.
  for (const name of await fs.readdir(cache)) {
    if (name.startsWith(prefix)) await fs.unlink(`${cache}/${name}`).catch(e => console.log(`vsc: could not remove cache entry ${name}: ${e?.message ?? e}`));
  }
}
