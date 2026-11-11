// The Explorer's right-click menu, as VS Code's: which items a file, a folder or the empty area
// gets. Pure: no herdr imports, so it runs under node --test. "-" is a separator.

const ITEM_H = 28, SEPARATOR_H = 9, PADDING = 12;

const item = (id, label) => ({ id, label });

// `target`: { kind: "file" | "folder" | "root", on, root, path }; `state`: { clip, pick } from shared.
export function menuItems(target, { clip = null, pick = null } = {}) {
  const local = !target.on, here = (x) => x && x.root === target.root && (x.on ?? null) === (target.on ?? null);
  const open = [...(local ? [item("reveal", "Reveal in Finder")] : []), item("terminal", "Open in Integrated Terminal")];
  const paths = ["-", item("copy-path", "Copy Path"), item("copy-relative", "Copy Relative Path")];
  const edit = ["-", item("rename", "Rename…"), item("delete", "Delete")];
  const create = [item("new-file", "New File…"), item("new-folder", "New Folder…")];
  if (target.kind === "root") return [...create, ...open, item("find", "Find in Folder…")];
  if (target.kind === "folder") return [...create, ...open, item("find", "Find in Folder…"), "-",
    item("cut", "Cut"), item("copy", "Copy"), ...(here(clip) ? [item("paste", "Paste")] : []), ...paths, ...edit];
  const comparable = pick && (pick.on ?? null) === (target.on ?? null) && pick.path !== target.path;
  return [item("side", "Open to the Side"), ...open, "-", item("pick-compare", "Select for Compare"),
    ...(comparable ? [item("compare", "Compare with Selected")] : []), "-", item("cut", "Cut"), item("copy", "Copy"), ...paths, ...edit];
}

export function menuHeight(items) {
  return PADDING + items.reduce((h, i) => h + (i === "-" ? SEPARATOR_H : ITEM_H), 0);
}
