import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecretFile } from "../mods/vsc/lib/editing.js";
import { actionRisks, ACTION_KEYS } from "../mods/vsc/lib/git-safety.js";
import { pushPlan, pullPlan, displayName, displayAddress, gitignoreLine, splitSecrets, PUSH_SAFE, PULL_SAFE } from "../mods/vsc/lib/scm.js";

const rec = (scope, key, value) => `${scope}\0${key}\n${value}\0`;

test("env templates are not secrets; real env files are", () => {
  for (const n of [".env.example", ".env.sample", ".env.template", ".env.dist"]) assert.equal(isSecretFile(`/p/${n}`), false, n);
  for (const n of [".env", ".env.local", ".env.production"]) assert.equal(isSecretFile(`/p/${n}`), true, n);
});

test("action check lists programs the repository runs, from its own config only", () => {
  const out = rec("local", "core.hookspath", ".husky/_") + rec("local", "gpg.program", "/tmp/x")
    + rec("local", "remote.origin.uploadpack", "x; git-upload-pack") + rec("global", "credential.helper", "osxkeychain")
    + rec("local", "remote.origin.url", "ext::sh -c id") + rec("local", "remote.origin.url", "git@github.com:me/r.git");
  assert.deepEqual(actionRisks(0, out, []), [
    "core.hookspath = .husky/_", "gpg.program = /tmp/x", "remote.origin.uploadpack = x; git-upload-pack", "remote.origin.url = ext::sh -c id",
  ]);
  assert.deepEqual(actionRisks(1, "", ["pre-commit", "pre-push"]), ["hooks: pre-commit, pre-push"]);
  assert.deepEqual(actionRisks(1, "", []), []);
  assert.deepEqual(actionRisks(128, "", []), ["the repository's git settings could not be checked"]);
  const re = new RegExp(ACTION_KEYS);
  for (const k of ["core.hookspath", "core.gitproxy", "core.askpass", "credential.helper", "remote.o.receivepack", "remote.o.mirror",
    "remote.o.push", "url.x.insteadof", "url.x.pushinsteadof", "protocol.ext.allow", "gpg.ssh.program", "gpg.ssh.defaultkeycommand",
    "submodule.recurse", "commit.gpgsign", "remote.o.url", "remote.o.pushurl"]) assert.ok(re.test(k), k);
});

test("push names one remote and one branch, never forces, follows no tags, and shows the address", () => {
  const plan = pushPlan({ branch: "main", hasHead: true, remote: "origin", merge: "refs/heads/main", remotes: ["origin"], url: "git@github.com:me/r.git" });
  assert.deepEqual(plan.args, ["push", ...PUSH_SAFE, "origin", "refs/heads/main:refs/heads/main"]);
  assert.equal(plan.label, "Push main to origin/main (git@github.com:me/r.git)");
  assert.ok(!plan.args.some(a => /force|^\+|^-f$|mirror|--all/.test(a)));
  const fresh = pushPlan({ branch: "feat/x", hasHead: true, remote: null, merge: null, remotes: ["origin"], url: "u" });
  assert.deepEqual(fresh.args, ["push", ...PUSH_SAFE, "--set-upstream", "origin", "refs/heads/feat/x:refs/heads/feat/x"]);
  assert.equal(pushPlan({ branch: "x", hasHead: false, remote: "origin", merge: "refs/heads/x", remotes: ["origin"] }), null, "nothing committed yet");
  assert.equal(pushPlan({ branch: "x", hasHead: true, remote: "-oops", merge: "refs/heads/x", remotes: ["-oops"] }), null);
  assert.equal(pushPlan({ branch: "x", hasHead: true, remote: "origin", merge: "x", remotes: ["origin"] }), null, "merge must be a branch ref");
  assert.ok(PUSH_SAFE.includes("--receive-pack=git-receive-pack") && PUSH_SAFE.includes("--no-follow-tags"));
});

test("pull is explicit and fast-forward only", () => {
  const plan = pullPlan({ branch: "main", remote: "origin", merge: "refs/heads/main", url: "https://h/r.git" });
  assert.deepEqual(plan.args, ["pull", ...PULL_SAFE, "origin", "refs/heads/main"]);
  assert.equal(plan.label, "Pull origin/main into main, fast-forward only (https://h/r.git)");
  assert.ok(PULL_SAFE.includes("--ff-only") && PULL_SAFE.includes("--upload-pack=git-upload-pack") && PULL_SAFE.includes("--no-recurse-submodules"));
  assert.equal(pullPlan({ branch: "main", remote: null, merge: null }), null);
});

test("display names drop direction-control and other control characters", () => {
  assert.equal(displayName("main‮txt.exe"), "maintxt.exe");
  assert.equal(displayName("a⁦b‏c\x07"), "abc");
  assert.equal(displayName("feature/ok"), "feature/ok");
});

test(".gitignore lines match exactly that file from the repository root", () => {
  assert.equal(gitignoreLine(".env"), "/.env");
  assert.equal(gitignoreLine("config/secret[1]*.json"), "/config/secret\\[1\\]\\*.json");
  assert.equal(gitignoreLine("a?b\\c"), "/a\\?b\\\\c");
  assert.equal(gitignoreLine("trailing "), "/trailing\\ ");
});

test("commit leaves secret files out", () => {
  const files = [{ path: "src/a.ts" }, { path: ".env" }, { path: "deploy/prod.tfvars" }, { path: ".env.example" }];
  const { include, secret } = splitSecrets(files);
  assert.deepEqual(include.map(f => f.path), ["src/a.ts", ".env.example"]);
  assert.deepEqual(secret.map(f => f.path), [".env", "deploy/prod.tfvars"]);
});

test("push never recurses into submodules, whatever the repository sets", () => {
  assert.ok(PUSH_SAFE.includes("--recurse-submodules=no"));
  const re = new RegExp(ACTION_KEYS);
  for (const k of ["push.recursesubmodules", "core.worktree", "http.proxy", "http.https://h/.proxy", "http.sslverify",
    "http.sslcainfo", "http.sslcapath", "http.extraheader", "http.cookiefile"]) assert.ok(re.test(k), k);
});

test("paths with line breaks never reach .gitignore", () => {
  assert.equal(gitignoreLine("x\n!.env\n.pem"), null);
  assert.equal(gitignoreLine("a\rb"), null);
});

test("display names drop every invisible or control character", () => {
  for (const ch of ["؜", "​", "‌", "‍", " ", " ", "\u0085", "\u009F", "﻿"])
    assert.equal(displayName(`a${ch}b`), "ab", JSON.stringify(ch));
});

test("addresses are shown without passwords or tokens", () => {
  const plan = pushPlan({ branch: "main", hasHead: true, remote: "origin", merge: "refs/heads/main", remotes: ["origin"], url: "https://me:ghp_TOKEN@github.com/me/r.git" });
  assert.equal(plan.label, "Push main to origin/main (https://github.com/me/r.git)");
  assert.equal(displayAddress("ssh://git:pw@h/r"), "ssh://h/r");
  assert.equal(displayAddress("git@github.com:me/r.git"), "git@github.com:me/r.git");
});

test("branch.<b>.merge must name a valid branch", () => {
  for (const merge of ["refs/heads/a:b", "refs/heads/-x", "refs/heads/a..b"])
    assert.equal(pushPlan({ branch: "a", hasHead: true, remote: "origin", merge, remotes: ["origin"] }), null, merge);
});

test("prod.env is a secret", () => {
  assert.equal(isSecretFile("/p/prod.env"), true);
});

test("push names the branch it sends, not whatever is checked out when it runs", () => {
  const plan = pushPlan({ branch: "main", hasHead: true, remote: "origin", merge: "refs/heads/main", remotes: ["origin"] });
  assert.ok(!plan.args.some(a => a.startsWith("HEAD")));
  assert.equal(plan.branch, "main");
  assert.equal(pullPlan({ branch: "main", remote: "origin", merge: "refs/heads/main" }).branch, "main");
});

test("more settings that run programs or redirect credentials are listed", () => {
  assert.ok(new RegExp(ACTION_KEYS).test("core.alternaterefscommand"));
});
