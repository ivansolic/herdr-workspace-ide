# What it runs, reads and writes

Herdr asks every shared mod to say this before it is installed. Back to the [README](../README.md).

## Workspace layout (`vsc` mod)

- **Runs programs** (`exec`, on this computer or the space's machine): `sh` (folder listing and
  file checks), `wc`, `cksum`, `head`, `stat`, `readlink`, `base64` (reading files and images),
  `chmod` (its own folders), `mkdir`, `mv -n`, `cp -RP`, `trash` / `gio trash` and `rm -rf` (only
  Explorer's Delete for good, after two confirmations), `open -R` / `xdg-open` (Reveal in Finder),
  `grep` and `find` (Search and Quick Open), `git` (status, ls-files, rev-parse, config, diff,
  cat-file, rev-list, log, branch, remote, symbolic-ref; and add, reset, rm, commit, switch, pull
  and push when you click them, through `env` and your ssh for the network), `osascript` (Finder's
  Trash before macOS 15), `mktemp`, `chgrp`, `dirname`, `id`, `tr` and `find … -exec rm` (saving on
  another machine, removing its own stale temporary files), and, in folders you
  trust, the project's own `tsc`, `eslint` and `ruff` (Problems), in the background with their
  output in `vsc-cache/`, deleted once read; `pkill`, `kill` and `sleep` stop them, and `stat`,
  `command -v` and `grep` find them. "Open in VS Code" runs `code --goto`, or `open` (macOS) /
  `xdg-open` (Linux) with a `vscode://file` link when `code` is not on PATH.
  PDFs and documents (macOS): `xcode-select -p`, then once `swiftc` to build a small PDF page
  renderer into `vsc-tools/` and `mv` to put it in place; that renderer draws pages into
  `vsc-cache/`. `unzip -l` lists a .docx or .odt file's pictures (plain names in its media folder
  only), and `unzip -p … | head -c` copies each into `vsc-cache/`, cut off at 20 MB whatever the
  archive claims; a stored symlink is copied as its link text, never followed.
  `textutil` reads Word, RTF and OpenDocument files, always told the file's format,
  so an HTML file named `.docx` is refused rather than converted (converting would fetch its
  images). "Open in default app" runs `/usr/bin/open` (macOS) or `xdg-open` (Linux) on the
  file, only for document, image and media formats, never on an executable file or on a symlink to
  another kind of file. Office files (doc, docx, rtf, odt, xlsx, pptx) open in Word, Excel or
  LibreOffice, which can run macros (after their own prompt) and follow links in them; files from
  git or an archive carry no download mark, so Office's Protected View does not apply. `uname -s` tells macOS from Linux.
  Diagrams (macOS): once `swiftc` to build a small diagram renderer into `vsc-tools/`, which draws
  a diagram with the Mermaid, draw.io or Excalidraw library shipped in `vendor/` inside a windowless WebKit view
  that blocks every network and file load and has WebRTC switched off (WebKit keeps that blocking rule in
  `vsc-tools/webkit-rules/`),
  and writes the picture to `vsc-cache/`. The diagram's
  text is written next to it for the drawing and deleted after.
  PlantUML diagrams: the `plantuml` on your PATH (or in `/opt/homebrew/bin`, `/usr/local/bin`) is run
  with the diagram's text, in PlantUML's SANDBOX security profile (no includes of files or URLs).
  It runs Java and Graphviz `dot` on this computer, in an empty folder of its own in `vsc-cache/`
  that is removed after, and is stopped after 30 s. Use PlantUML 1.2023.9 or newer: older versions
  had ways around SANDBOX.
- **Runs `git status` automatically** in the focused terminal's folder to show git marks, as
  Herdr's own Files and Spaces do. A repository's own git configuration can name programs (filter
  drivers) that `git status` runs, so Explorer first reads the repository's settings, which runs
  nothing, and leaves git marks off when the repository defines such programs (the standard git-lfs
  filter commands excepted; git-lfs extensions are not).
  Submodules are not checked. Herdr's Spaces sidebar still runs `git status` in the same folder,
  so do not open folders containing a `.git` from archives you do not trust.
- **Finds programs on your PATH**, as Herdr runs them with your shell's environment: `git`, `sh`, `code`
  and the others run directly, not through a shell script, take the first match on your PATH. Its own
  shell scripts drop relative PATH entries first; the direct calls do not, so keep `.` (or an empty
  entry) off your PATH, or a program planted in a repository could run in place of `git`.
- **Writes your files** only when you save or confirm a Replace, through Herdr's `writeTextFile`,
  which refuses to overwrite a file that changed since it was read. Replace never writes through a
  symlink and leaves files over 1 MiB alone.
  On another machine (where `writeTextFile` does not work) the text goes over `exec` into a
  temporary file `.vsc-save.XXXXXX` beside the file (`mktemp`, readable only by you), which
  replaces the file only when the text arrived whole and the file still holds what was read; the
  file keeps its mode and group, and files owned by another user are not saved. The replacement is
  a new file, so hard links and ACLs are not carried over. Such temporary files are never
  committed, and leftovers over an hour old are removed at the next save in that folder. In a
  folder other users may write to without the sticky bit, they could interfere with a save, as
  they could with the file itself.
- **Writes under `~/.config/herdr-app`:**
  - `vsc-drafts/`: unsaved text of open files, so closing a tab or the app loses nothing.
    A draft is deleted when you save or discard, or at start-up once the file already holds that text.
    Secret files never get a draft: `.env*`, `.envrc`, keys and certificates, `*.tfvars`, `secrets.*`,
    everything in `.ssh`, `.aws`, `.kube`, `.docker`, `.gnupg`, any file reached through a symlink to
    one of those, and any file only its owner may read.
  - `vsc-cache/`: copies of images being previewed, pictures of PDF pages and documents' pictures (the app shows images
    only from its own folder), removed when their tab closes.
  - `vsc-tools/`: the PDF page renderer and the diagram renderer built from this mod's source,
    each rebuilt when its source changes.
  - In `shared.json` (Herdr's shared state), paths and counts only: `vsc.trusted` (folders you
    trusted for Problems), `vsc.recent` (recently opened files), `vsc.saved` (the last saved file),
    `vsc.problems` (the problem count), `vsc.tabs` and `vsc.dirty` (open tabs, unsaved files),
    `vsc.fileclip`, `vsc.compare-pick`, `vsc.search-scope` and `vsc.fs-changed` (Explorer's Cut/Copy,
    Select for Compare, Find in Folder, and a change counter), `vsc.autonames` (the tab names it gave,
    by tab id) and `vsc.main-seen` (a fingerprint of the last changed main layout it told you about).
  - These folders are readable only by you (mode 700) and contain a `.gitignore` of `*`, so a dotfiles
    repository does not pick them up.
- **Changes one Herdr setting**: it hides the Files/Changes buttons in the tab bar while this layout
  is shown and puts your previous setting back when you switch away.
- **No network access of its own.** Web links in markdown open in your browser only when clicked.
  Markdown previews load no images (they show as text) until you choose "Load images", so opening
  a file does not tell anyone that you read it.

## AI usage panel (`ai-usage` mod)

- **Reads agents' own logs on this computer**, through `node mods/ai-usage/scan.mjs` (Node 20+), started
  when the panel opens and once a minute: Claude Code transcripts (`~/.claude/projects/**/*.jsonl`),
  Gemini CLI chats (`~/.gemini/tmp/*/chats/*.jsonl`) and Codex sessions (`~/.codex/sessions/**`). Only
  usage figures come out: model, token counts, day, the project folder's name and the git branch. Message
  text, prompts and file contents are never read into the panel or kept.
- **Reads the plan of your Claude login** from `~/.claude.json`: organization type, seat tier, rate
  limit tier and whether extra usage is on. Never the email or name. Gemini and Codex plans are
  chosen in the panel; they are not stored on disk, and the panel does not read any login or keychain.
- **Reads the Claude Code progress tracker's snapshots** in `~/.claude/progress-tracker/` for live limits
  and subagents, and deletes snapshots older than 30 days (`find … -mtime +30 -delete`).
- **Network:** fetches the ECB's euro reference rate
  (`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`) at most every 12 hours, for showing
  euros. Nothing is sent: it is a plain download of a public file.
- **Writes under `~/.config/herdr-app`:** `data/ai-usage/cache.json`, the usage figures of each log file
  it has read (so it reads only what changed, and keeps daily totals of logs an agent deletes for up to
  400 days); in `shared.json`: `ai-usage.plans`, `ai-usage.budgets`, `ai-usage.budget-warned`,
  `ai-usage.links`, `ai-usage.folded`, `ai-usage.currency` and `ai-usage.ecb`.
  `data/ai-usage/demo.json` exists only while demo mode is on (`scripts/ai-usage-demo.mjs`).
- **Writes your files** only when you click Export CSV: `~/Downloads/ai-usage-<name>-<period>-<date>.csv`,
  then `open -R` shows it in Finder.
- **Notifications:** one when a project passes 80% and one at 100% of the monthly budget you set.

## Claude Code progress tracker (Claude Code plugin)

- **Reads** the plan fields of `~/.claude.json` (as above) and, from Claude Code itself, the session's
  limits, context and cost.
- **Writes** one snapshot per session to `~/.claude/progress-tracker/sessions/<session id>.json`
  (limits, context, cost, token counts per model, task counts and labels, subagent names) and the
  per-day cost to `~/.claude/progress-tracker/ledger.json`, every 5 seconds while work runs. The AI
  usage panel reads them; nothing leaves the computer.
- **Adds a `progress` tool** for subagents, and one line to each subagent's prompt asking it to report
  its steps with that tool. The tool only updates the progress bar.
- **Keeps** the mode, budgets and plan price you set with `/tracker` in Claude Code's plugin store.
