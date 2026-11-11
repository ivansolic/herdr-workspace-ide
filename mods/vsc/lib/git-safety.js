// Before running `git status` in a folder, check whether the repository itself names programs git
// would run while checking files (filter drivers, fsmonitor). Reading config runs nothing.
// Pure: no herdr imports, so it runs under node --test.

// git-lfs extensions run their own clean commands inside the standard lfs filter.
export const GIT_RISKY_KEYS = "^(filter\\..+\\.(clean|smudge|process)|lfs\\.extension\\..+\\.(clean|smudge)|core\\.fsmonitor)$";

// Scopes that came with the folder; global and system config are the user's own.
const REPO_SCOPES = new Set(["local", "worktree"]);

// The commands `git lfs install` writes, matched exactly: git runs filter commands through sh,
// so anything appended to an allowed prefix would run too.
const LFS_COMMANDS = {
  "filter.lfs.clean": new Set(["git-lfs clean -- %f"]),
  "filter.lfs.smudge": new Set(["git-lfs smudge -- %f", "git-lfs smudge --skip -- %f"]),
  "filter.lfs.process": new Set(["git-lfs filter-process", "git-lfs filter-process --skip"]),
};

function risky(key, value) {
  if (key === "core.fsmonitor") return !/^(false|0|no|off)?$/i.test(value);
  return !LFS_COMMANDS[key]?.has(value);
}

// From `git config -z --includes --show-scope --get-regexp GIT_RISKY_KEYS`, whose records are
// "scope\0key\nvalue\0" (keys may contain spaces, so only -z output is parsed).
// Returns "safe" (run git), "repo-filter" (the repository defines programs: don't), "unknown" (fail closed).
export function gitConfigVerdict(code, stdout) {
  if (code === 1) return "safe";
  if (code !== 0) return "unknown";
  const fields = stdout.split("\0");
  if (fields.at(-1) !== "" || fields.length % 2 !== 1) return "unknown";
  let found = false;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i], entry = fields[i + 1], newline = entry.indexOf("\n");
    if (!/^[a-z]+$/.test(scope) || newline < 0) return "unknown";
    if (REPO_SCOPES.has(scope) && risky(entry.slice(0, newline), entry.slice(newline + 1))) found = true;
  }
  return found ? "repo-filter" : "safe";
}

// Settings that make commit, switch, pull or push run programs or go somewhere other than shown.
// Git prints keys in lower case.
export const ACTION_KEYS = "^(core\\.(hookspath|gitproxy|askpass|worktree|alternaterefscommand)|credential\\..*|remote\\..+\\.(uploadpack|receivepack|proxy|mirror|push|url|pushurl|vcs)|branch\\..+\\.(remote|pushremote)|url\\..+\\.(insteadof|pushinsteadof)|protocol\\..*|gpg\\..*(program|defaultkeycommand)|commit\\.gpgsign|submodule\\.recurse|push\\.recursesubmodules|http\\..*(proxy|sslverify|sslcainfo|sslcapath|extraheader|cookiefile))$";

// What the repository itself will run during an action, for the confirmation to list.
// `code`/`stdout`: git config -z --includes --show-scope --get-regexp ACTION_KEYS; `hooks`: active hook names.
export function actionRisks(code, stdout, hooks) {
  const risks = [];
  if (code !== 0 && code !== 1) return ["the repository's git settings could not be checked"];
  const fields = code === 0 ? stdout.split("\0") : [""];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i], entry = fields[i + 1], nl = entry.indexOf("\n");
    if (nl < 0) return ["the repository's git settings could not be checked"];
    const key = entry.slice(0, nl), value = entry.slice(nl + 1);
    if (!REPO_SCOPES.has(scope)) continue;
    // Plain addresses and remote names are expected; transport helpers ("ext::", "fd::", "foo::")
    // run programs. A remote's vcs always names one (git-remote-<vcs>).
    if (/^(remote\..+\.(url|pushurl)|branch\..+\.(remote|pushremote))$/.test(key) && !/::|^(ext|fd):/i.test(value)) continue;
    if (key === "commit.gpgsign" && /^(false|0|no|off)$/i.test(value)) continue;
    risks.push(`${key} = ${value}`);
  }
  if (hooks.length) risks.push(`hooks: ${hooks.join(", ")}`);
  return risks;
}
