// The files Search and Quick Open look at: those under the focused terminal's folder (as Explorer
// shows it, so paths match open tabs), without what .gitignore excludes inside a repository.
import { exec } from "herdr";
import { repoInfo, git, failure } from "./git.js";
import { parseFileList, plainPath, insideFolder } from "./search.js";
import { FIND, GREP, SIZES, REAL_FOLDERS } from "./scripts.js";

export const FILE_LIMIT = 10000;
const CHUNK = 500; // paths per call: thousands in one would pass the system's argument limit

// { root, files (relative to root), truncated, note }. `root` is the folder as given, never resolved.
export async function listFiles(cwd, on, { includeIgnored = false } = {}) {
  const { top, off } = await repoInfo(cwd, on);
  if (top && !off && !includeIgnored) {
    // Run in the folder itself, git lists only what is below it, relative to it; it runs no filters.
    const r = await git(cwd, on, ["ls-files", "-z", "-co", "--exclude-standard", "--deduplicate"]);
    if (r.code !== 0) throw new Error(failure(r));
    return { root: cwd, ...parseFileList(r.stdout, FILE_LIMIT), note: null };
  }
  // Folders find may not read (permission denied) are left out; only a failed cd is an error.
  const r = await exec("sh", ["-c", FIND, "vsc", cwd], { on });
  if (r.code !== 0) throw new Error(failure(r));
  const { files, truncated } = parseFileList(r.stdout, FILE_LIMIT);
  return { root: cwd, files: files.map(f => f.replace(/^\.\//, "")), truncated, note: top && off ? `Ignored files are included: ${off}` : null };
}

// Of `files` (relative to root), those containing `text` (grep -F; -is for any case). Narrows what
// is read; the final match is made in JavaScript (see grepCanNarrow for when this may be used).
export async function filesContaining(root, files, text, matchCase, on) {
  const out = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    const r = await exec("sh", ["-c", GREP, "vsc", root, matchCase ? "-s" : "-is", text, ...files.slice(i, i + CHUNK)], { on });
    // 0 found, 1 none, 2 a listed file was unreadable or gone (messages are off with -s); anything
    // printed to stderr anyway is a real error.
    if (r.code > 2 || (r.code === 2 && r.stderr.trim())) throw new Error(failure(r));
    out.push(...r.stdout.split("\0").filter(Boolean));
  }
  return out;
}

const folderOf = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";

// Of `files`, those whose real folder is the real root or below it: a folder swapped for a symlink
// to somewhere else (git still lists the files it tracked there) is left out, as are paths with
// "." or ".." parts.
async function insideOnly(root, files, on) {
  const plain = files.filter(plainPath), folders = [...new Set(plain.map(folderOf))], real = new Map();
  let realRoot = null;
  for (let i = 0; i < folders.length; i += CHUNK) {
    const chunk = folders.slice(i, i + CHUNK);
    const r = await exec("sh", ["-c", REAL_FOLDERS, "vsc", root, ...chunk.map(d => `./${d}`)], { on });
    if (r.code !== 0) throw new Error(failure(r));
    const parts = r.stdout.split("\0");
    realRoot = parts[0];
    chunk.forEach((d, j) => real.set(d, parts[j + 1]));
  }
  return plain.filter(f => insideFolder(realRoot, real.get(folderOf(f))));
}

// Of `files` (relative to root): regular files up to 1 MiB (`small`, what readTextFile reads whole)
// and over it (`large`), only below the folder's real path. Symlinks, folders and missing files are
// in neither: Search shows and Replace writes only files that really are in the folder.
export async function splitBySize(root, files, on) {
  const inside = await insideOnly(root, files, on), small = [], large = [];
  for (let i = 0; i < inside.length; i += CHUNK) {
    // "./" keeps a name starting with "-" or "(" from reading as part of find's expression.
    const r = await exec("sh", ["-c", SIZES, "vsc", root, ...inside.slice(i, i + CHUNK).map(f => `./${f}`)], { on });
    // A file deleted since it was listed is simply left out; any other complaint is an error.
    const other = r.stderr.split("\n").filter(line => line.trim() && !/No such file/.test(line));
    if (r.code !== 0 && (other.length || !r.stdout.includes("--\0"))) throw new Error(failure(r));
    let into = small;
    for (const entry of r.stdout.split("\0").filter(Boolean)) {
      if (entry === "--") into = large; else into.push(entry.slice(2));
    }
  }
  return { small, large };
}
