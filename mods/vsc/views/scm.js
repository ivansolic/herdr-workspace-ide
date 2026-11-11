// Source Control: changed files of the focused terminal's repository, commit, branches, and pull
// (fast-forward only) and push after a confirmation that says exactly what will happen.
// Secret files (.env, keys) are never committed, and a push is refused while unpushed commits
// contain one. Change listing follows Herdr's shipped Changes mod (Apache-2.0).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, watchFolder, readTextFile, writeTextFile, theme } from "herdr";
import { iconButton, viewCard, hint, icon, barButton } from "../lib/ui.js";
import { location, locationKey } from "../lib/location.js";
import { repoInfo, git, gitWrite, gitNetwork, actionCheck, unpushedSecrets, failure } from "../lib/git.js";
import { parseStatus, parseNumstat, parseAheadBehind, pushPlan, pullPlan, parseBranches, validBranchName,
  displayName, gitignoreLine, splitSecrets, branchOfRef } from "../lib/scm.js";
import { fileIcon } from "../lib/icons.js";
import { openDiff, openFile } from "../lib/open.js";

const LIMIT = 1000;
const markColor = (mark, t) => mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked;
const value = (r) => (r.code === 0 ? r.stdout.trim() : "") || null;
// Error text can carry "remote:" lines from a server: keep the lines, drop invisible characters.
const cleanText = (text) => String(text).split("\n").map(displayName).join("\n");

export default class SourceControl extends View {
  init(_props, cx) {
    this.files = []; this.branches = []; this.message = "";
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => { this.message = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.branchInput = InputState.new({ placeholder: "New branch name" });
    this.branchInput.on("change", (_e, cx) => cx.notify());
    this.branchInput.on("submit", (_e, cx) => this.createBranch(cx));
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  // One watcher per repository visit: each loop has its own number and stops when a newer one starts
  // (returning to the same folder must not leave the old loop running beside the new one).
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const gen = this.watchGen = (this.watchGen ?? 0) + 1;
    cx.spawn(async (cx) => {
      try { while (gen === this.watchGen) { await watchFolder(root); if (gen === this.watchGen) this.refresh(cx); } }
      catch (e) { console.log(`vsc: watching ${root} stopped: ${e?.message ?? e}`); if (gen === this.watchGen) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.refreshAgain = true; return; }
    const { cwd, on } = location(), context = locationKey();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.branches = []; this.error = null; this.note = null;
      this.confirm = null; this.branchMenu = false; this.watched = null; this.watchGen = (this.watchGen ?? 0) + 1;
      this.off = null; this.repo = null; this.message = ""; this.input.set_value("");
    }
    if (!cwd) return;
    this.loading = true; this.refreshAgain = false;
    cx.spawn(async (cx) => {
      try {
        const { top, off } = await repoInfo(cwd, on);
        if (locationKey() !== context) return;
        if (!top) { this.root = null; this.files = []; this.off = null; this.repo = null; return; }
        this.root = top; this.on = on; this.off = off;
        if (off) { this.files = []; this.repo = null; return; }
        const run = (args) => git(top, on, args);
        // Submodule pointer changes are shown (they are committed too); their insides are not read.
        const [status, head, branchR, remotesR, branchesR] = await Promise.all([
          run(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=dirty"]),
          run(["rev-parse", "--verify", "--quiet", "HEAD"]),
          run(["symbolic-ref", "--quiet", "HEAD"]),
          run(["remote"]),
          run(["branch", "--format=%(HEAD)%09%(refname:short)"]),
        ]);
        if (status.code !== 0) throw new Error(failure(status));
        const hasHead = head.code === 0, branch = branchOfRef(value(branchR));
        const numstatArgs = ["--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty"];
        const [numstat, remote, merge] = await Promise.all([
          Promise.all(hasHead ? [run(["diff", "HEAD", ...numstatArgs])] : [run(["diff", "--cached", ...numstatArgs]), run(["diff", ...numstatArgs])]),
          branch ? run(["config", "--get", `branch.${branch}.remote`]).then(value) : null,
          branch ? run(["config", "--get", `branch.${branch}.merge`]).then(value) : null,
        ]);
        const upstream = remote && merge ? `${remote}/${merge.replace(/^refs\/heads\//, "")}` : null;
        const okRemote = remote && !remote.startsWith("-");
        const [counts, pushUrl, fetchUrl] = await Promise.all([
          upstream ? run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).then(r => parseAheadBehind(r.stdout)) : null,
          okRemote ? run(["remote", "get-url", "--push", remote]).then(value) : null,
          okRemote ? run(["remote", "get-url", remote]).then(value) : null,
        ]);
        if (locationKey() !== context) return;
        const stats = parseNumstat(numstat.filter(r => r.code === 0).map(r => r.stdout));
        const all = parseStatus(status.stdout);
        this.files = all.slice(0, LIMIT).map(f => ({ ...f, ...(stats[f.path] ?? { add: 0, del: 0, binary: false }) }));
        this.limited = all.length > LIMIT;
        const remotes = remotesR.stdout.split("\n").filter(Boolean);
        // A confirmation was for the branch that was checked out then.
        if (this.confirm && this.repo?.branch !== branch) this.confirm = null;
        this.repo = { branch, hasHead, remote, merge, upstream, counts, remotes, pushUrl, fetchUrl };
        this.branches = parseBranches(branchesR.stdout); this.error = null;
        this.watch(top, cx);
      } catch (e) { if (locationKey() === context) this.error = String(e?.message ?? e); }
      finally {
        this.loading = false;
        if (this.refreshAgain) this.refresh(cx);
        cx.notify();
      }
    });
  }

  // Runs one git action; errors show under the header, success refreshes the view.
  act(label, job, cx) {
    if (this.busy) return;
    this.busy = label; this.error = null; this.note = null; this.confirm = null;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { const note = await job(); if (locationKey() === context) this.note = note ?? null; }
      catch (e) { if (locationKey() === context) this.error = cleanText(e?.message ?? e); }
      finally { this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Before an action: list what the repository itself will run. Nothing listed runs at once;
  // otherwise the confirmation shows it and waits for Continue.
  prepare(label, run, cx, { always = false, blocked = null } = {}) {
    const root = this.root, on = this.on, context = this.context;
    this.checking = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const risks = await actionCheck(root, on);
        const block = blocked ? await blocked() : null;
        if (locationKey() !== context) return;
        if (!block && !risks.length && !always) run(cx);
        else this.confirm = { label, risks, blocked: block, run };
      } catch (e) { if (locationKey() === context) this.error = cleanText(e?.message ?? e); }
      finally { this.checking = false; cx.notify(); }
    });
    cx.notify();
  }

  commit(cx) {
    const message = this.message.trim(), { include, secret } = splitSecrets(this.files);
    if (!message || !this.root || this.off || this.busy || this.checking || this.locationChanged()) return;
    if (this.files.some(f => f.status === "U")) { this.error = "Resolve conflicts first."; cx.notify(); return; }
    if (!include.length) { this.error = "Nothing to commit: only secret files changed."; cx.notify(); return; }
    const root = this.root, on = this.on, hasHead = this.repo?.hasHead;
    // The secrets to leave out come from what `add -A` actually staged, not from the list on screen
    // (which stops at 1,000 files and can be a refresh old).
    const stagedSecrets = async () => {
      const staged = await git(root, on, ["diff", "--cached", "--name-only", "-z", "--no-renames"]);
      if (staged.code !== 0) throw new Error(failure(staged));
      return splitSecrets(staged.stdout.split("\0").filter(Boolean).map(path => ({ path }))).secret.map(f => f.path);
    };
    const unstage = async (paths) => {
      if (!paths.length) return;
      const r = await gitWrite(root, on, hasHead ? ["reset", "-q", "--", ...paths] : ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...paths]);
      if (r.code !== 0) throw new Error(failure(r));
    };
    this.prepare(`Commit ${include.length} file${include.length === 1 ? "" : "s"}`, (cx) => this.act("Committing…", async () => {
      const add = await gitWrite(root, on, ["add", "-A"]);
      if (add.code !== 0) throw new Error(failure(add));
      const leftOut = await stagedSecrets();
      await unstage(leftOut);
      // Never commit a secret: check again right before committing, and leave nothing staged if refused.
      const still = await stagedSecrets();
      if (still.length) { await unstage(still).catch(e => console.log(`vsc: could not unstage ${still.join(", ")}: ${e?.message ?? e}`)); throw new Error(`Not committed: ${still.join(", ")} would have been included.`); }
      const r = await gitWrite(root, on, ["commit", "-m", message]);
      if (r.code !== 0) throw new Error(failure(r));
      this.message = ""; this.input.set_value("");
      return leftOut.length ? `Committed. Left out: ${leftOut.join(", ")}.` : "Committed.";
    }, cx), cx);
  }

  locationChanged() {
    return this.context !== locationKey();
  }

  network(plan, cx) {
    const root = this.root, on = this.on, push = plan.args[0] === "push", remote = this.repo.remote;
    this.act(push ? "Pushing…" : "Pulling…", async () => {
      // The confirmation named a branch; refuse if another one is checked out by now.
      const now = branchOfRef((await git(root, on, ["symbolic-ref", "--quiet", "HEAD"])).stdout);
      if (now !== plan.branch) throw new Error(`Not done: ${displayName(now || "a detached HEAD")} is checked out now, not ${displayName(plan.branch)}.`);
      if (push) {
        const secrets = await unpushedSecrets(root, on, remote, `refs/heads/${plan.branch}`);
        if (secrets.length) throw new Error(`Push refused: commits not on the server yet contain ${secrets.join(", ")}.`);
      }
      const r = await gitNetwork(root, on, plan.args);
      if (r.code !== 0) throw new Error(`${failure(r)}\nIf git needs a password or passphrase, run "git ${plan.args[0]}" in a terminal.`);
      return push ? "Pushed." : "Pulled.";
    }, cx);
  }

  askPush(cx) {
    const repo = this.repo, plan = pushPlan({ ...repo, url: repo.pushUrl });
    if (!plan) return;
    const root = this.root, on = this.on, remote = repo.remote;
    this.prepare(plan.label, cx => this.network(plan, cx), cx, {
      always: true,
      blocked: async () => {
        const secrets = await unpushedSecrets(root, on, remote, `refs/heads/${plan.branch}`);
        return secrets.length ? `Push refused: commits not on the server yet contain ${secrets.join(", ")}. Remove them from those commits first; anything that was pushed must be treated as leaked and changed.` : null;
      },
    });
  }

  askPull(cx) {
    const repo = this.repo, plan = pullPlan({ ...repo, url: repo.fetchUrl });
    if (plan) this.prepare(plan.label, cx => this.network(plan, cx), cx, { always: true });
  }

  switchBranch(name, cx) {
    const root = this.root, on = this.on;
    this.branchMenu = false;
    this.prepare(`Switch to ${displayName(name)}`, cx => this.act("Switching branch…", async () => {
      const r = await gitWrite(root, on, ["switch", "--no-recurse-submodules", "--", name]);
      if (r.code !== 0) throw new Error(failure(r));
      return `Switched to ${displayName(name)}.`;
    }, cx), cx);
  }

  createBranch(cx) {
    const name = this.branchInput.value().trim();
    if (!validBranchName(name)) { this.error = "That is not a valid branch name."; cx.notify(); return; }
    const root = this.root, on = this.on;
    this.branchMenu = false; this.branchInput.set_value("");
    this.prepare(`Create ${displayName(name)}`, cx => this.act("Creating branch…", async () => {
      const r = await gitWrite(root, on, ["switch", "--no-recurse-submodules", "-c", name]);
      if (r.code !== 0) throw new Error(failure(r));
      return `Created and switched to ${displayName(name)}.`;
    }, cx), cx);
  }

  // Adds the exact path to the repository's .gitignore (never overwriting a concurrent edit).
  // Only into a missing or regular .gitignore: a symlink could point at a credentials file, whose
  // text would then land in .gitignore and be committed. Only on this computer: writeTextFile
  // cannot write on another machine.
  ignore(path, cx) {
    const file = `${this.root}/.gitignore`, on = this.on, line = gitignoreLine(path);
    if (on || line === null) return;
    this.act("Updating .gitignore…", async () => {
      const regular = await exec("sh", ["-c", '{ [ ! -e "$1" ] && [ ! -L "$1" ]; } || { [ -f "$1" ] && [ ! -L "$1" ]; }', "vsc", file]);
      if (regular.code !== 0) throw new Error(".gitignore is not a regular file (it may be a link), so it was not changed.");
      const old = await readTextFile(file);
      const text = old === null ? `${line}\n` : `${old}${old.endsWith("\n") || old === "" ? "" : "\n"}${line}\n`;
      await writeTextFile(file, text, old);
      return `${path} is now in .gitignore.`;
    }, cx);
  }

  button(id, label, onClick, t, options) {
    return barButton(id, label, onClick, t, options);
  }

  branchBar(t) {
    const repo = this.repo, idle = !this.busy && !this.checking;
    const canPush = Boolean(pushPlan(repo)), canPull = Boolean(pullPlan(repo));
    const counts = repo.counts ? `↑${repo.counts.ahead} ↓${repo.counts.behind}` : repo.upstream ? "" : "no upstream";
    return h_flex().h(40).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("vsc-scm-branch").min_w(0).flex_1().h(28).px(6).gap(6).items_center().rounded(7).cursor_pointer()
        .hover(s => s.bg(t.hover)).tooltip("Switch or create a branch")
        .on_click((_e, cx) => { this.branchMenu = !this.branchMenu; cx.notify(); })
        .child(icon("git-branch").size(14).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().child(repo.branch ? displayName(repo.branch) : "detached HEAD"))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(counts)))
      .child(this.button("vsc-scm-pull", "Pull", cx => this.askPull(cx), t, { enabled: idle && canPull }))
      .child(this.button("vsc-scm-push", "Push", cx => this.askPush(cx), t, { enabled: idle && canPush }));
  }

  confirmBar(t) {
    const c = this.confirm;
    return v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(t.border).bg(t.raised)
      .child(div().text_size(12).child(`${c.label}?`))
      .when(c.risks.length > 0, el => el.child(v_flex().gap(2).text_size(11).text_color(t.blocked)
        .child(div().child("This repository runs its own programs here:"))
        .children(c.risks.map(r => div().pl(8).truncate().child(displayName(r))))))
      .when(Boolean(c.blocked), el => el.child(div().text_size(11).text_color(t.ansi1).child(c.blocked)))
      .child(h_flex().gap(6).justify_end()
        .child(this.button("vsc-scm-cancel", "Cancel", () => { this.confirm = null; }, t))
        .when(!c.blocked, el => el.child(this.button("vsc-scm-confirm", c.risks.length ? "Continue" : "OK", cx => { this.confirm = null; c.run(cx); }, t, { primary: true }))));
  }

  branchMenuView(t) {
    const valid = validBranchName(this.branchInput.value().trim());
    return v_flex().flex_none().max_h(260).border_b(1).border_color(t.border).bg(t.raised)
      .child(v_flex().id("vsc-scm-branches").flex_1().min_h(0).overflow_y_scrollbar().p(4)
        .children(this.branches.map(b => h_flex().id(`vsc-scm-b-${b.name}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6).text_size(12)
          .when(b.current, el => el.text_color(t.dim).child(icon("git-branch").size(12)).child(div().min_w(0).truncate().child(`${displayName(b.name)} (current)`)))
          .when(!b.current, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.switchBranch(b.name, cx))
            .child(icon("git-branch").size(12).text_color(t.muted)).child(div().min_w(0).truncate().child(displayName(b.name)))))))
      .child(h_flex().flex_none().p(6).gap(6).border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.branchInput).h_full().text_size(12)))
        .child(this.button("vsc-scm-create", "Create", cx => this.createBranch(cx), t, { primary: true, enabled: valid && !this.busy })));
  }

  // Secret files are never committed: say so, and offer to ignore new ones for good.
  secretsView(secret, t) {
    return v_flex().flex_none().px(12).py(6).gap(4).border_b(1).border_color(t.border)
      .children(secret.map(f => h_flex().gap(8).items_center().text_size(11)
        .child(div().flex_1().min_w(0).text_color(f.fresh ? t.dim : t.ansi1).child(f.fresh
          ? `Left out of the commit: ${displayName(f.path)} (looks like a secret)`
          : `${displayName(f.path)} is already in this repository's history and stays out of commits. Remove it from git and change the secrets in it.`))
        .when(f.fresh && !this.on && gitignoreLine(f.path) !== null, el => el.child(this.button(`vsc-scm-ignore-${f.path}`, "Add to .gitignore", cx => this.ignore(f.path, cx), t, { enabled: !this.busy })))));
  }

  fileRow(f, t) {
    const parts = displayName(f.path).split("/"), name = parts.pop(), kind = fileIcon(name);
    return h_flex().id(`vsc-scm-${f.path}`).h(26).flex_none().px(8).gap(6).items_center().rounded(7).cursor_pointer()
      .hover(s => s.bg(t.hover)).tooltip(displayName(f.path))
      .on_click((_e, cx) => cx.spawn(async (cx) => openDiff(this.root, f.path, this.on, f.fresh ? "?" : f.status, cx)))
      .child(icon(kind.icon).size(14).flex_none().text_color(t[kind.color] ?? t.muted))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().max_w_full().truncate().text_color(markColor(f.status, t)).child(name))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
      .when(f.add > 0, el => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, el => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
      .when(f.status !== "D", el => el.child(div().id(`vsc-scm-open-${f.path}`).size(20).flex_none().flex().items_center().justify_center()
        .rounded(5).text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.foreground)).tooltip("Open file")
        .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => openFile(`${this.root}/${f.path}`, this.on, cx)); })
        .child(icon("file").size(12))))
      .child(div().w(12).flex_none().text_size(11).text_color(markColor(f.status, t)).child(f.status));
  }

  render(cx) {
    if (locationKey() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const actions = [iconButton("vsc-scm-refresh", "refresh", "Refresh", cx => this.refresh(cx), t)];
    const title = h_flex().gap(8).items_center().min_w(0).child("Source Control")
      .when(this.files.length > 0, el => el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).font_normal().text_size(10).text_color(t.muted).child(String(this.files.length))));
    let body;
    if (!this.root) body = hint(this.loading ? "Loading…" : "Not a git repository", t);
    else if (this.off) body = div().p(12).text_size(12).text_color(t.dim).child(`Source Control is off: ${this.off}`);
    else if (!this.repo) body = hint("Loading…", t);
    else {
      const { include, secret } = splitSecrets(this.files), conflicts = this.files.some(f => f.status === "U");
      const canCommit = Boolean(this.message.trim()) && include.length > 0 && !conflicts && !this.busy && !this.checking;
      body = v_flex().flex_1().min_h(0)
        .child(this.branchBar(t))
        .when(this.branchMenu, el => el.child(this.branchMenuView(t)))
        .when(Boolean(this.confirm), el => el.child(this.confirmBar(t)))
        .when(!this.repo.branch, el => el.child(div().px(12).py(6).text_size(11).text_color(t.blocked).child("Detached HEAD: commits made here are not on any branch.")))
        .when(Boolean(this.busy || this.checking), el => el.child(div().px(12).py(6).text_size(11).text_color(t.dim).child(this.busy || "Checking…")))
        .when(Boolean(this.error), el => el.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.error)))
        .when(Boolean(this.note) && !this.error, el => el.child(div().px(12).py(6).text_size(11).text_color(t.dim).child(this.note)))
        .child(h_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border)
          .child(div().id("vsc-scm-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1()
            .border_color(this.typing ? t.accent : t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(div().id("vsc-scm-commit").h(32).px(14).flex().items_center().rounded(8).text_size(12)
            .bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim)
            .when(canCommit, el => el.cursor_pointer().on_click((_e, cx) => this.commit(cx))).child("Commit")))
        .when(conflicts, el => el.child(div().px(14).pt(6).text_size(11).text_color(t.ansi1).child("Resolve conflicts first: files marked U still have conflict markers.")))
        .when(secret.length > 0, el => el.child(this.secretsView(secret, t)))
        .child(h_flex().h(28).flex_none().px(14).gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_1().child(this.files.length ? "Changes · commit includes all of them except secrets" : "No changes"))
          .when(add > 0, el => el.child(div().text_color(t.ansi2).child(`+${add}`)))
          .when(del > 0, el => el.child(div().text_color(t.ansi1).child(`−${del}`))))
        .child(v_flex().id("vsc-scm-files").flex_1().min_h(0).overflow_y_scrollbar().px(6).pb(6)
          .children(this.files.map(f => this.fileRow(f, t)))
          .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(`Showing the first ${LIMIT.toLocaleString("en")} changed files`))));
    }
    return viewCard("vsc-scm", title, actions, body, t);
  }
}
