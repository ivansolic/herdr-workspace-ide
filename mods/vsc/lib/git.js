// Running git safely for the panel views.
// Reads (status, diff, branch lists) run automatically, so they run only when the repository's own
// config names no programs git would run while reading files (repoInfo). Actions the user clicks
// (commit, switch, pull, push) can still run the repository's hooks, signing programs or credential
// helpers, as they would in a terminal; actionCheck lists them so the confirmation can show them.
import { exec } from "herdr";
import { gitConfigVerdict, GIT_RISKY_KEYS, actionRisks, ACTION_KEYS } from "./git-safety.js";
import { isSecretFile } from "./editing.js";
import { unpushedRange } from "./scm.js";
import { inFolderArgs } from "./scripts.js";

// Every program here runs inside the repository, which may not be trusted (see IN_FOLDER).
const inRepo = (folder, on, argv) => exec(...inFolderArgs(folder, argv), { on });

// On every call, whatever the repository's config says: no transport helpers that run programs
// ("ext::", "fd::"), and no recursion into submodules (their settings are never checked).
// Signature display is off too: showing a signature runs the repository's gpg.program.
export const SAFE = ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never", "-c", "submodule.recurse=false", "-c", "log.showSignature=false"];
// Reads also take no index lock, skip fsmonitor and never refresh the index, as Herdr's Changes does,
// and read the real commits rather than replacements (git replace): push sends the real ones.
export const READ = ["--no-optional-locks", "--no-replace-objects", ...SAFE, "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const OFF = {
  "repo-filter": "this repository defines its own filter programs.",
  unknown: "this repository's git settings could not be checked.",
};

// { top: repository root or null, off: why git must not run here, or null }
export async function repoInfo(cwd, on) {
  const top = await inRepo(cwd, on, ["git", "rev-parse", "--show-toplevel"]).catch(() => null);
  if (top?.code !== 0) return { top: null, off: null };
  const root = top.stdout.trim();
  // Reading config runs nothing.
  const config = await inRepo(root, on, ["git", "--no-optional-locks", "config", "-z", "--includes", "--show-scope", "--get-regexp", GIT_RISKY_KEYS]).catch(() => null);
  const verdict = config ? gitConfigVerdict(config.code, config.stdout) : "unknown";
  return { top: root, off: verdict === "safe" ? null : OFF[verdict] };
}

export function git(root, on, args) {
  return inRepo(root, on, ["git", ...READ, ...args]);
}

// Commands that change the repository (add, commit, switch).
export function gitWrite(root, on, args) {
  return inRepo(root, on, ["git", ...SAFE, ...args]);
}

// The user's own ssh command (global or system config, never the repository's), made non-interactive.
async function sshCommand(root, on) {
  for (const scope of ["--global", "--system"]) {
    const r = await inRepo(root, on, ["git", "config", scope, "--get", "core.sshCommand"]).catch(() => null);
    if (r?.code === 0 && r.stdout.trim()) return `${r.stdout.trim()} -o BatchMode=yes`;
  }
  return "ssh -o BatchMode=yes";
}

// Network commands must never wait for a password prompt nobody can see: they fail instead,
// and the user runs them in a terminal.
export async function gitNetwork(root, on, args) {
  const ssh = await sshCommand(root, on);
  return inRepo(root, on, ["env", "GIT_TERMINAL_PROMPT=0", `GIT_SSH_COMMAND=${ssh}`, "git", ...SAFE, ...args]);
}

// Programs the repository itself will run during an action: settings and active hooks.
export async function actionCheck(root, on) {
  const config = await inRepo(root, on, ["git", "--no-optional-locks", "config", "-z", "--includes", "--show-scope", "--get-regexp", ACTION_KEYS]).catch(() => null);
  const hooksScript = 'd=$(git rev-parse --git-path hooks) || exit 1; for f in "$d"/*; do [ -f "$f" ] && [ -x "$f" ] || continue; case "$f" in *.sample) continue;; esac; printf "%s\\0" "${f##*/}"; done';
  const hooks = await inRepo(root, on, ["sh", "-c", hooksScript]).catch(() => null);
  const names = hooks?.code === 0 ? hooks.stdout.split("\0").filter(Boolean) : null;
  if (!config || names === null) return ["the repository's git settings could not be checked"];
  return actionRisks(config.code, config.stdout, names);
}

// Secret files added or changed in the commits of `tip` that are not on `remote` yet (see unpushedRange).
// Deleting a secret is not counted, so the commit that removes one can be pushed; for a merge only the
// files it changes against every parent are listed (a secret added while merging), the merged-in
// commits are scanned themselves when they are not on the server.
export async function unpushedSecrets(root, on, remote, tip) {
  const args = ["log", "--no-show-signature", "--name-only", "-z", "--format=", "--diff-filter=d", "--diff-merges=dense-combined", "--no-renames", "--no-relative", "--no-color", "--root", ...unpushedRange(remote, tip)];
  const r = await git(root, on, args);
  if (r.code !== 0) throw new Error(failure(r));
  return [...new Set(r.stdout.split(/[\0\n]/).filter(Boolean))].filter(isSecretFile);
}

export function failure(r) {
  return (r.stderr || r.stdout || `git exited with ${r.code}`).trim();
}
