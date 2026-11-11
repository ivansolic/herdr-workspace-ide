import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, parseNumstat, parseAheadBehind, parseBranches, validBranchName, unpushedRange, branchOfRef } from "../mods/vsc/lib/scm.js";

test("status -z: path, letter, untracked flag; conflicts first", () => {
  const out = " M src/a.ts\0?? new file.md\0D  old.ts\0UU both.ts\0A  added.ts\0";
  assert.deepEqual(parseStatus(out), [
    { path: "src/a.ts", status: "M", fresh: false },
    { path: "new file.md", status: "A", fresh: true },
    { path: "old.ts", status: "D", fresh: false },
    { path: "both.ts", status: "U", fresh: false },
    { path: "added.ts", status: "A", fresh: false },
  ]);
  assert.deepEqual(parseStatus(""), []);
});

test("numstat -z sums added and removed lines, binary files marked", () => {
  const out = "3\t1\tsrc/a.ts\0-\t-\tlogo.png\0" + "2\t0\tsrc/a.ts\0";
  assert.deepEqual(parseNumstat([out]), { "src/a.ts": { add: 5, del: 1, binary: false }, "logo.png": { add: 0, del: 0, binary: true } });
});

test("ahead/behind from rev-list --left-right --count", () => {
  assert.deepEqual(parseAheadBehind("2\t3\n"), { ahead: 2, behind: 3 });
  assert.deepEqual(parseAheadBehind(""), null);
});

test("branch list keeps local branches and marks the current one", () => {
  assert.deepEqual(parseBranches("*\tmain\n \tfeat/x\n \tfix y\n"), [{ name: "main", current: true }, { name: "feat/x", current: false }, { name: "fix y", current: false }]);
});

test("branch names: what git accepts, without leading dashes", () => {
  for (const n of ["feature/x", "fix-1", "a.b"]) assert.equal(validBranchName(n), true, n);
  for (const n of ["", "-x", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "/a", "a/", "a.lock", "@", "a@{b", ".a", "a//b"])
    assert.equal(validBranchName(n), false, n);
});

test("push secret scan: commits on no remote-tracking branch of the push remote", () => {
  assert.deepEqual(unpushedRange("origin", "refs/heads/feat"), ["refs/heads/feat", "--not", "--remotes=origin"]);
  // No upstream (the push goes to the only remote): compare against every remote.
  assert.deepEqual(unpushedRange(null, "refs/heads/feat"), ["refs/heads/feat", "--not", "--remotes"]);
  // A remote given as a URL, an option-like or a glob-like name: a commit on another remote must not
  // count as on the server, so the whole branch is scanned.
  for (const remote of ["https://x/y.git", "-x", "o*", "a/b", ""]) {
    assert.deepEqual(unpushedRange(remote, "refs/heads/feat"), ["refs/heads/feat"]);
  }
});

test("branch from the full symbolic-ref (a tag of the same name gives no heads/ prefix)", () => {
  assert.equal(branchOfRef("refs/heads/x"), "x");
  assert.equal(branchOfRef("refs/heads/feature/a"), "feature/a");
  assert.equal(branchOfRef(""), null);
  assert.equal(branchOfRef(null), null);
  assert.equal(branchOfRef("refs/remotes/origin/x"), null);
});
