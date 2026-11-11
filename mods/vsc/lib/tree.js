// Folder markers in Explorer, the way VS Code shows them: a folder reflects the files below it.
// Pure: no herdr imports, so it runs under node --test.

// Conflicts first, then deletions, edits, additions.
const STRENGTH = { U: 4, D: 3, M: 2, A: 1 };

function* ancestors(path, stopAt) {
  let dir = path.slice(0, path.lastIndexOf("/"));
  while (dir.length >= (stopAt?.length ?? 0) && dir !== "") {
    yield dir;
    if (dir === stopAt) return;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  if (!stopAt) yield "/";
}

// Every folder between each marked file and `root`, with the strongest mark below it. Built once per git refresh.
export function folderMarks(marks, root) {
  const out = new Map();
  for (const [path, mark] of Object.entries(marks))
    for (const dir of ancestors(path, root))
      if ((STRENGTH[mark] ?? 0) > (STRENGTH[out.get(dir)] ?? 0)) out.set(dir, mark);
  return out;
}

// Every folder (on machine `on`) that has an unsaved file somewhere below it.
export function unsavedFolders(on, unsaved) {
  const prefix = `${on ?? ""}|`, out = new Set();
  for (const key of unsaved) if (key.startsWith(prefix)) for (const dir of ancestors(key.slice(prefix.length))) out.add(dir);
  return out;
}
