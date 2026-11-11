// Explorer's file actions: which names are allowed, the name a copy gets, paths relative to the
// Explorer's folder. Pure: no herdr imports, so it runs under node --test.
import { utf8Bytes } from "./remote-text.js";

// null when `name` may be a file or folder name, else why not. One path part, as typed: no "/",
// not "." or "..", no control characters, at most 255 bytes (the usual file-system limit).
export function validName(name) {
  if (!name || !name.trim()) return "A name is required.";
  if (name.includes("/")) return "A name cannot contain \"/\".";
  if (name === "." || name === "..") return "\".\" and \"..\" are not names.";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "A name cannot contain control characters.";
  if (utf8Bytes(name).length > 255) return "This name is too long.";
  return null;
}

// The name a pasted copy gets when `name` is taken, as VS Code does: "a copy.js", "a copy 2.js".
export function copyName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf("."), split = dot > 0 ? dot : name.length;
  const base = name.slice(0, split), ext = name.slice(split);
  for (let n = 1; ; n++) {
    const candidate = `${base} copy${n === 1 ? "" : ` ${n}`}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// `path` relative to `root` ("" for the root itself), or null when it is not under it.
export function relativeTo(root, path) {
  if (path === root) return "";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

// Strictly below `root` (the root itself is not inside).
export function isInside(root, path) {
  return path.startsWith(`${root}/`);
}

// Whether pasting `rel` into the folder `destRel` would put a folder into itself or below itself.
export function intoItself(rel, destRel) {
  return destRel === rel || destRel.startsWith(`${rel}/`);
}
