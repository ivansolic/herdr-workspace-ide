# Workspace layout: every feature

The `workspace-studio` layout and its `vsc` mod, in detail. Back to the [README](../README.md).

- An activity rail with Explorer, Changes (Herdr's own Changes panel), Source Control, Search and Problems. The panel resizes, and folds to
  the rail when dragged narrow or when the shown view's icon is clicked.
- Explorer: file tree of the focused terminal's folder, file-type icons, git marks (folders take the
  strongest mark below them), and unsaved files and the folders that contain them marked in blue.
- Right-click in Explorer, as in VS Code: New File, New Folder, Rename, Delete (to the Trash, with
  a confirmation; on a machine without one, deleting for good asks a second time), Cut, Copy and
  Paste (a copy never replaces anything: it becomes "name copy"), Copy Path, Copy Relative Path,
  Reveal in Finder, Open in Integrated Terminal, Open to the Side, Find in Folder, and Select for
  Compare / Compare with Selected. Actions stay inside the Explorer's folder and never write
  through a symlink that leads out of it. A file with unsaved changes in its tab is not renamed,
  moved or deleted; tabs of moved files follow them. Each file has one editor: Open to the Side on a
  file that is already open shows that editor (VS Code would open a second view of it).
- Files open in their own tab: code with syntax colors, markdown with Preview/Edit, images.
  On macOS, PDFs show as pages (20 at a time, "Show more" for the next) and Word, RTF and
  OpenDocument files as read-only text with tables; headings from Word styles show as plain text.
  The pictures of a .docx or .odt file are listed under its text (up to 60, 20 MB each, 100 MB in
  all); each opens in its own tab. PDFs and documents open up to 50 MB, on this computer only.
  Mermaid diagrams (macOS): `.mmd` / `.mermaid` files open as Diagram (a picture) or Source (the
  text, editable); a Markdown preview lists its ```` ```mermaid ```` blocks, each opening as a
  picture in its own tab or to the side, drawn again when the file changes. draw.io files
  (`.drawio`, `.dio`, compressed or not) open the same way, with a button per page; shapes draw.io
  loads from its website (stencil libraries such as cloud provider icons) stay empty, because
  diagrams never load anything. `.drawio.svg` files already show as pictures.
  PlantUML files (`.puml`, `.plantuml`, `.pu`) open the same way when PlantUML is installed on this
  computer (`brew install plantuml`, which brings Java), else the tab says how to install it; they
  are never sent to a PlantUML server. Includes of other files or URLs are refused.
  Excalidraw files (`.excalidraw`) open the same way, drawn with Excalidraw's own library and its own
  fonts (Excalifont, Virgil and the others), pictures inside the drawing included; they are shown, not
  edited as drawings (Source edits the JSON). Files over 8 MB (drawings with many photos) open as too
  large. `.excalidraw.svg` / `.excalidraw.png` exports already show as pictures.
  Files a tab cannot show offer "Open in default app" for documents, images and media (PDF, Office
  files, audio, video), else "Reveal in Finder".
  `cmd-s` saves. A file changed elsewhere is never overwritten silently: you choose Compare,
  Use disk version or Keep mine.

- Source Control: changed files with line counts, changes against the last commit in a tab, commit,
  branches, and pull (fast-forward only) and push after a confirmation that names the branch, the
  remote and its address. Push never forces and pushes exactly one branch.
- **Secrets never leave your machine through this panel:** `.env` files, keys and other secret files
  are never committed (they are left out and can be added to `.gitignore` with one click), and a push
  is refused while commits not yet on the server contain one. `.env.example`-style templates are
  committed normally. "On the server" means what this clone last fetched from that remote: after a
  secret was purged from the server by a force-push, run `git fetch --prune` before pushing again.
  When the branch's remote is set as an address rather than a name, the branch's whole history is checked.
- Before commit, branch switch, pull or push, the panel lists programs the repository itself would run
  (hooks such as husky, signing programs, credential helpers, custom transport settings) and waits for
  Continue. Transport helpers that run programs (`ext::`, `fd::`), the repository's own upload-pack and
  receive-pack programs and submodule recursion are always switched off.

- Search (`cmd-shift-f`): text or a regular expression (JavaScript syntax) across the focused
  terminal's folder (the one Explorer shows), with match case and whole word. In a repository, files
  `.gitignore` excludes are left out unless you tick "Include ignored files". Files reached through a
  symlinked folder that points outside the folder are never searched or changed. Results show the line number; clicking one opens the file (Herdr's
  editor cannot jump to a line yet).
- Replace: shows every changed line per file before anything is written, lets you leave files out,
  skips files with unsaved changes in their tab or changed since the preview, and offers "Undo replace".
- Quick Open (`cmd-p`): type part of a file's name or path in the same folder; recently opened files come first.

- Problems (`cmd-shift-m`): errors and warnings from the folder's own TypeScript (`tsc`), ESLint and
  Ruff, grouped by file, with a count on the rail. Each one opens its file, or VS Code at its exact
  line ("Open in VS Code"). Checks run the project's own programs, so nothing runs until you trust
  the folder; the prompt lists each command. After that they run when you ask and after each save.
  Only tools the project installs are used (`node_modules/.bin`, `.venv/bin/ruff`, or Ruff on your
  PATH, shown and run by its full path), never `npx`. A tsconfig.json that only lists references
  (as Vite writes it) is checked through each referenced config inside the folder. Trust is kept
  for the folder's real path, its identity on disk and the exact commands: a different project
  unpacked at the same path, or a change in the checks (a pulled branch adds eslint), is asked about
  again. On Linux a folder made again at the same path can get the same identity back. Checks stop after 10 minutes, and when you focus a terminal in another
  folder. With `incremental` or `composite` in a tsconfig, tsc writes its `.tsbuildinfo` file.

- **Tab names**: terminal tabs are named after the agent in them and its folder ("Claude Code ·
  shop"), else their folder and git branch ("shop · main", "~" at home), and follow `cd`. A name you
  give a tab is kept; renaming it to nothing hands it back (typing exactly the automatic name counts
  as automatic). Editor and diagram tabs keep their file names. Only while this layout is shown: in
  another layout tabs keep the name they last had.

- **Herdr's main layout**: this layout is built from parts of Herdr's `main` layout, which Herdr
  replaces on updates. When `layouts/main.json` differs from the copy this mod follows
  (`mods/vsc/main-base.json`, key order ignored), you get one notice per changed version; clicking it
  opens both side by side, so you can see what to take over. It is read at start and every 10 minutes.
  Only the layout is compared: a change in one of Herdr's own mods, such as a renamed setting this
  layout passes but `main` does not, is not noticed.
  Missed the notice? Run `herdr-app do vsc.comparemain` while this layout is shown. After taking changes
  over into `layouts/workspace-studio.json`, copy `layouts/main.json` to `mods/vsc/main-base.json`, so the
  difference is not told again.


It uses only its own mod (`vsc`) and Herdr's shipped mods, so Herdr updates keep arriving.
Look and feel follow [DESIGN.md](../DESIGN.md).
