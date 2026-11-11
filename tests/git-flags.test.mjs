import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// lib/git.js imports herdr, so its flag list is checked as text.
const src = readFileSync(new URL("../mods/vsc/lib/git.js", import.meta.url), "utf8");

test("every git call turns off signature display (it runs gpg.program)", () => {
  assert.match(src, /"log\.showSignature=false"/);
  assert.match(src, /"--no-show-signature"/);
});

test("the push secret check shows only what a merge itself adds, and no merged-in commits already on the server", () => {
  assert.match(src, /"--diff-merges=dense-combined"/);
  assert.doesNotMatch(src, /--diff-merges=separate/);
  assert.match(src, /unpushedRange\(/);
});

test("the push secret check lists the files of a root commit whatever log.showRoot says", () => {
  assert.match(src, /"--root"/);
});

test("reads see the real commits, never replacements (push sends the real ones)", () => {
  assert.match(src, /export const READ = \["--no-optional-locks", "--no-replace-objects"/);
});

test("the push secret check is not narrowed to a folder by diff.relative", () => {
  assert.match(src, /"--no-relative"/);
});

// Git runs inside repositories that may not be trusted: a program named git planted there must never
// run in place of the real one, even with "." on the user's PATH.
test("inFolderArgs: runs the program in the folder with only absolute PATH entries", async () => {
  const { inFolderArgs } = await import("../mods/vsc/lib/scripts.js");
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const repo = join(mkdtempSync(join(tmpdir(), "vsc-planted-")), "-repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "git"), "#!/bin/sh\necho PLANTED\n");
  chmodSync(join(repo, "git"), 0o755);
  const [cmd, args] = inFolderArgs(repo, ["git", "--version"]);
  assert.equal(cmd, "/bin/sh");
  const out = execFileSync(cmd, args, { cwd: repo, env: { PATH: `.:${repo}x::/usr/bin:/bin` }, encoding: "utf8" });
  assert.match(out, /^git version/);
  // It runs in the folder (a name starting with "-" is still a folder).
  assert.equal(execFileSync(...inFolderArgs(repo, ["pwd"]), { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" }).trim().endsWith("/-repo"), true);
  // A folder that cannot be entered fails with git's own "not a repository" code, running nothing.
  assert.throws(() => execFileSync(...inFolderArgs(join(repo, "missing"), ["sh", "-c", "echo RAN"]), { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", stdio: "pipe" }), (e) => e.status === 128 && !String(e.stdout).includes("RAN"));
});
