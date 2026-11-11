# Herdr Workspace IDE

An editor workbench beside Herdr's sidebar, in the style of VS Code: an activity rail with Explorer, Source
Control, Search and Problems, files, diffs, PDFs, documents and diagrams opening in Herdr's own tabs next to
your terminals and agents, and terminal tabs named after the agent or folder in them.

![Herdr Workspace IDE](preview.png)

## What you see

Left to right, on the theme's `canvas` background, the system title bar hidden (`titlebar: "none"`, window
buttons at 12, 16):

- **Sidebar**, 268 px (`chrome`, fixed width, 44 to 480): Herdr's brand bar (46 px, drags the window), the
  Spaces list and the Agents list (half each, at least 90 px), and the sidebar footer (69 px).
- **Activity rail**, 46 px (`chrome`): five 34 px icon buttons, Explorer (files), Changes (Herdr's own
  Changes panel, file-diff icon), Source Control (git branch), Search, Problems (triangle with a count badge: red with errors, the warning color with warnings
  only). The shown view's icon has the `selected` background.
- **Views panel**, 320 px (60 to 900, 8 px top and bottom padding): one of Explorer, Changes, Source Control,
  Search or Problems. Panels follow Herdr's own Files/Changes look: `background` body, 10 px corners, 42 px header
  with a 13 px semibold title, 28 px rows with 7 px corners.
- **Work area**: Herdr's tab bar (42 px, drags the window), the shown tab with 8 px padding and gaps (pane
  cards on `background` with a 1 px `border`, `accent` when focused, Herdr's `pane` header 30 px on top),
  and Herdr's status bar (28 px).

Editor tabs are Herdr tabs whose only pane is the mod: a 36 px toolbar (file path, Diagram | Source or
Preview | Edit segments, Save) above the content.

## How it behaves

- **Rail**: a click shows that view; clicking the shown view's icon folds the panel to the rail; dragging
  the panel narrower than 150 px folds it and it comes back at its last width. While this layout shows,
  Herdr's Files/Changes tab-bar buttons are hidden; the previous setting returns when you switch away.
- **Explorer**: the focused terminal's folder as a tree with file-type icons, git marks (folders take the
  strongest mark below them) and unsaved files in `ansi4`. Right-click: New File/Folder, Rename, Delete (to
  the Trash, confirmed), Cut/Copy/Paste (never replaces: "name copy"), Copy Path / Relative Path, Reveal in
  Finder, Open in Integrated Terminal, Open to the Side, Find in Folder, Select for Compare / Compare with
  Selected. Actions stay inside the folder and never write through a symlink that leads out of it.
- **Files** open in their own tab (one per file; opening again focuses it): code with syntax colors (edit
  up to 1 MB, read-only up to 20 MB), Markdown Preview/Edit, images; on macOS PDFs as pages (20 at a time)
  or selectable text (with OCR for scanned pages), Word/RTF/OpenDocument as read-only text with their
  pictures listed below. `cmd-s` saves; a file changed on disk meanwhile is not overwritten without asking;
  unsaved text survives closing the tab.
- **Diagrams** (macOS): Mermaid (`.mmd`, and each ```` ```mermaid ```` block of a Markdown preview), draw.io
  (a button per page), Excalidraw (`.excalidraw`, with its own fonts and pictures) and PlantUML (`.puml`,
  only with a local `plantuml`) open as Diagram or Source and are drawn again when the file changes.
- **Source Control**: changed files with line counts, changes against the last commit in a tab, commit,
  branches, pull (fast-forward only) and push after a confirmation naming the branch and remote.
- **Search**: text in the folder, with a multi-file replace that shows a preview first. `cmd-p` Quick Open.
- **Problems**: tsc, eslint and ruff results, after the folder is trusted once; Open in VS Code per item.
- **Agents**: their status shows in Herdr's own sidebar, tabs and pane headers (working, blocked, done,
  idle), unchanged. Terminal tabs are named "Claude Code · folder" while an agent runs in them, else
  "folder · branch" ("~" at home); a name you give a tab is kept.
- **Herdr's main layout**: when Herdr's shipped `main` layout differs from the copy this layout follows, one
  notice per changed version; clicking it opens both side by side.
- **Other machines**: a file of a space on another machine opens and saves (text over `exec`, about
  500 KB at most); a file changed there meanwhile is not overwritten.

## Built from

- `layouts/workspace-ide.json`: root row → `sidebar` column (`brand` block `workspace-chrome`, `sidebar-lists`
  column with `spaces` and `agents` blocks, `sidebar-footer` block `workspace-chrome` with
  `{"footer": true}`), `vsc-activity` block (`vsc`, `{"view": "activity"}`), `vsc-views` stack (`vsc` blocks
  `{"view": "explorer" | "scm" | "search" | "problems"}` and Herdr's `changes` block), `work` column (`tabs` block
  `tabs`, `work-body` row with the `{"tab": "active"}` block and its pane frame, `status` block
  `workspace-status`).
- Shipped mods used as they are: `workspace-chrome`, `spaces`, `agents`, `tabs`, `pane`, `workspace-status`,
  `changes`.
- One mod, `mods/vsc`: `main.js` picks the view by `props.view`; editor, diagram, diff and compare tabs are
  opened with `herdr-app do tab.new {mod, props}`. Pure logic lives in `lib/` with node tests in `tests/`.
- `herdr` functions: `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `spaces`, `panes`, `agents`,
  `machines`, `knownAgents`, `shared`/`setShared`, `notify`, `run` (`layout.select/show/hide/resize`,
  `tab.new`, `tab.rename`, `pane.split`).
- Programs it runs: git, grep, find, sh, the project's own tsc/eslint/ruff (after trust), `textutil`,
  `unzip`, `swiftc` once to build a PDF renderer and a diagram renderer (WebKit, every load blocked),
  `plantuml` when installed, `open`/`xdg-open`.
- Vendored libraries in `mods/vsc/vendor/` (Mermaid, draw.io viewer, Excalidraw utils), unchanged except
  Excalidraw's Liberation Sans font (taken out by `scripts/vendor-excalidraw.mjs`); own icon set in
  `mods/vsc/icons/`.
- `keys.json`: `layout:workspace-ide` (`cmd-shift-e` Explorer, `ctrl-shift-g` Source Control, `cmd-shift-f`
  Search, `cmd-shift-m` Problems, `cmd-p` Quick Open) and `mod:vsc` (`cmd-s` save).

## Watch out

- `run()` returns nothing to mods: tabs are opened with `herdr-app do tab.new` to learn their id.
- `image()` reads only the app's folder: images, PDF pages and diagrams are copied or drawn into
  `vsc-cache/` first. `exec` output stops at 8 MiB, hence the read-only and remote size limits.
- There is no close-tab veto: unsaved text is kept as drafts and restored.
- BSD and GNU tools differ (`chmod --`, `stat -f`/`-c`): every argument list is in `lib/scripts.js` and
  tested with the real program.
- Herdr marks every renamed tab as named, so the tab names the mod gave are remembered in shared state.
- PDF, document and diagram viewers are macOS only (PDFKit, textutil, WebKit through `swiftc`, which needs
  the Xcode command line tools); a first `swiftc` build can take ~30 s.
- Mod commands (`vsc.comparemain`) reach shown copies only.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/vsc` passes and `npm test` passes.
- Switching to `workspace-ide` shows sidebar, rail, panel, tabs and status bar as above; the rail folds and
  restores the panel; Herdr's Files/Changes buttons come back after switching away.
- Explorer lists the focused terminal's folder; a file opens in its own tab, edits save with `cmd-s`.
- A PDF shows pages, a `.mmd` file draws, an `.excalidraw` file draws with its fonts and pictures.
- Source Control shows a diff; Search finds text; Problems lists tsc errors after trusting the folder.
- A new terminal tab is named after its folder and follows `cd`; a hand-given name stays.
