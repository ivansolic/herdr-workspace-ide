// Source Control decisions: reading git's output and deciding what pull and push will do.
// Pure: no herdr imports, so it runs under node --test.
import { gitLetter, isSecretFile } from "./editing.js";

// `git status --porcelain=v1 -z --no-renames` -> [{ path, status: A|M|D|U, fresh }]
export function parseStatus(out) {
  return out.split("\0").filter(Boolean).map(entry => {
    const xy = entry.slice(0, 2);
    return { path: entry.slice(3), status: gitLetter(xy), fresh: xy === "??" };
  });
}

// One or more `git diff --numstat -z --no-renames` outputs -> { path: { add, del, binary } }
export function parseNumstat(outputs) {
  const stats = {};
  for (const out of outputs) for (const entry of out.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0, binary: false };
    stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: old.binary || a === "-" };
  }
  return stats;
}

// `git rev-list --left-right --count HEAD...@{upstream}` -> { ahead, behind }
export function parseAheadBehind(out) {
  const m = /^(\d+)\s+(\d+)/.exec(out.trim());
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

// Flags that keep a push to exactly what its confirmation says, whatever the repository's config:
// no tags, the standard receive-pack program, one explicit target, never forced.
// --recurse-submodules=no: a repository's push.recurseSubmodules would otherwise push inside
// submodules, whose settings (receive-pack programs) are never checked.
export const PUSH_SAFE = ["--no-follow-tags", "--receive-pack=git-receive-pack", "--recurse-submodules=no"];
// Pull only fast-forwards (no merge commit, no conflicts), runs the standard upload-pack,
// and leaves submodules alone.
export const PULL_SAFE = ["--ff-only", "--no-recurse-submodules", "--upload-pack=git-upload-pack"];

const shortRef = (ref) => ref.replace(/^refs\/heads\//, "");
const okRemote = (remote) => Boolean(remote) && !remote.startsWith("-");
const okMerge = (merge) => typeof merge === "string" && merge.startsWith("refs/heads/") && validBranchName(merge.slice("refs/heads/".length));

// `remote`/`merge`: branch.<branch>.remote / .merge; `url`: where the remote really points.
export function pushPlan({ branch, hasHead, remote, merge, remotes, url }) {
  if (!branch || !hasHead) return null;
  const where = url ? ` (${displayAddress(url)})` : "";
  if (remote || merge) {
    if (!okRemote(remote) || !okMerge(merge)) return null;
    return { branch, args: ["push", ...PUSH_SAFE, remote, `refs/heads/${branch}:${merge}`], label: `Push ${displayName(branch)} to ${displayName(remote)}/${displayName(shortRef(merge))}${where}` };
  }
  if (remotes.length !== 1 || !okRemote(remotes[0])) return null;
  const only = remotes[0];
  return { branch, args: ["push", ...PUSH_SAFE, "--set-upstream", only, `refs/heads/${branch}:refs/heads/${branch}`], label: `Push ${displayName(branch)} to ${displayName(only)}/${displayName(branch)}, new on ${displayName(only)}${where}` };
}

export function pullPlan({ branch, remote, merge, url }) {
  if (!branch || !okRemote(remote) || !okMerge(merge)) return null;
  const where = url ? ` (${displayAddress(url)})` : "";
  return { branch, args: ["pull", ...PULL_SAFE, remote, merge], label: `Pull ${displayName(remote)}/${displayName(shortRef(merge))} into ${displayName(branch)}, fast-forward only${where}` };
}

// Names from a repository (branches, remotes, addresses) shown to the user: no control characters,
// so right-to-left overrides cannot make a name read as something else.
export function displayName(text) {
  return String(text ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

// A remote address for the screen: without "user:password@" or a token in front of the host.
export function displayAddress(url) {
  return displayName(String(url ?? "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1"));
}

// A .gitignore line that matches exactly this path from the repository root.
// Null for a path with a line break: it would add more lines (such as "!.env") to the file.
export function gitignoreLine(path) {
  if (/[\r\n]/.test(path)) return null;
  return "/" + path.replace(/[\\*?[\]]/g, ch => `\\${ch}`).replace(/ $/, "\\ ");
}

// Commit never includes secret files (lib/editing.js isSecretFile).
export function splitSecrets(files) {
  const include = [], secret = [];
  for (const f of files) (isSecretFile(f.path) ? secret : include).push(f);
  return { include, secret };
}

// `git branch --format=%(HEAD)%09%(refname:short)` -> [{ name, current }]
export function parseBranches(out) {
  return out.split("\n").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    return { name: line.slice(tab + 1), current: line.slice(0, tab) === "*" };
  });
}

// git check-ref-format rules for a branch name, plus no leading "-" (it would read as an option).
export function validBranchName(name) {
  if (!name || name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  return name.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

// The checked-out branch from `symbolic-ref HEAD` (the full name; --short gives "heads/x" when a tag x exists).
export function branchOfRef(ref) {
  const r = String(ref ?? "").trim();
  return r.startsWith("refs/heads/") && r.length > 11 ? r.slice(11) : null;
}

// What a push would add to the server: commits of `tip` on no remote-tracking branch of the push
// remote, as this clone last saw it. Merged-in commits already on the server are left out, and
// nothing depends on one tracking ref that may never have been fetched. With no upstream the push
// goes to the only remote. A remote that is not a plain name (a URL, say) cannot be matched to its
// tracking refs, and a commit on another remote is not on this server, so the whole branch is scanned.
export function unpushedRange(remote, tip) {
  if (remote === null || remote === undefined) return [tip, "--not", "--remotes"];
  const plain = typeof remote === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(remote);
  return plain ? [tip, "--not", `--remotes=${remote}`] : [tip];
}
