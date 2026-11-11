// Decisions behind saving, drafts and paths, kept pure so they are tested under node --test.
import { baseName } from "./files.js";

// A draft remembers the file text it was based on, so a later restore can tell
// "still the same file" from "someone changed it since".
export function makeDraft(on, path, base, text) {
  return JSON.stringify({ v: 1, on: on ?? null, path, base, text });
}

// Drafts written by this version start like this; a partial write still does, which tells it
// apart from an old plain-text draft.
export function looksLikeDraft(raw) {
  return typeof raw === "string" && raw.startsWith('{"v":');
}

export function parseDraft(raw) {
  try {
    const d = JSON.parse(raw);
    return d?.v === 1 && typeof d.path === "string" && typeof d.text === "string" && typeof d.base === "string" ? d : null;
  } catch { return null; }
}

// clean: open the file as it is. restored: unsaved text on top of the current file.
// conflict: unsaved text based on an older version; the user must choose.
export function restoreDecision(disk, draft, on, path) {
  if (!draft || draft.path !== path || (draft.on ?? null) !== (on ?? null) || sameText(draft.text, disk)) return { state: "clean" };
  if (draft.base === disk) return { state: "restored", text: draft.text, base: draft.base };
  return { state: "conflict", text: draft.text, base: draft.base, disk };
}

// After writeTextFile rejected: what is on disk now, compared with what we last read.
export function saveFailure(lastRead, reread) {
  if (reread === null) return "missing";
  return reread === lastRead ? "error" : "conflict";
}

const SECRET_NAMES = new Set([".netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".htpasswd", ".envrc",
  ".vault-token", ".s3cfg", ".boto", "credentials", "terraform.tfstate"]);
const SECRET_EXT = new Set(["env", "pem", "key", "p12", "pfx", "keystore", "jks", "kdbx", "tfvars", "tfstate", "gpg", "asc", "ovpn"]);
// Templates listing variable names without values are meant to be committed.
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
// Every file in these folders is treated as secret (cloud, cluster and SSH configuration).
const SECRET_DIRS = new Set([".ssh", ".aws", ".kube", ".docker", ".gnupg", ".azure"]);

// Files whose unsaved text must not be copied into a draft.
export function isSecretFile(path) {
  const parts = String(path ?? "").split("/"), name = (parts.pop() ?? "").toLowerCase();
  if (SECRET_DIRS.has((parts.pop() ?? "").toLowerCase())) return true;
  if (ENV_TEMPLATES.has(name)) return false;
  if (name === ".env" || name.startsWith(".env.") || SECRET_NAMES.has(name)) return true;
  if (/^\.vsc-save\.[a-z0-9]{6}$/.test(name)) return true;        // a remote save's temporary file
  if (/^id_[a-z0-9_]+$/.test(name)) return true;                  // SSH keys, including *_sk
  if (/^secrets?\.[a-z0-9]+$/.test(name)) return true;           // secrets.yaml, secret.json
  const dot = name.lastIndexOf(".");
  return dot > 0 && SECRET_EXT.has(name.slice(dot + 1));
}

// Unix permission bits as printed by stat ("600"): true when neither group nor others may read.
export function isPrivateMode(mode) {
  if (typeof mode !== "string" || !/^[0-7]{3,4}$/.test(mode)) return false;
  const bits = Number.parseInt(mode.slice(-3), 8);
  return (bits & 0o044) === 0;
}

// Resolves a markdown link against the document's folder: decodes %xx, folds . and ..
export function joinPath(dir, link) {
  let decoded = link;
  try { decoded = decodeURIComponent(link); } catch { /* keep the raw link */ }
  const parts = (decoded.startsWith("/") ? decoded : `${dir}/${decoded}`).split("/"), out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return `/${out.join("/")}`;
}

const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// git status --porcelain XY to one Explorer letter.
export function gitLetter(xy) {
  if (UNMERGED.has(xy)) return "U";
  if (xy === "??" || xy.includes("A")) return "A";
  if (xy.includes("D")) return "D";
  return "M";
}

// Windows line endings: the editor may show "\r\n" as "\n", so compare and save with the file's own ending.
export function lineEnding(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function toLineEnding(text, ending) {
  return ending === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
}

export function sameText(a, b) {
  return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

// readTextFile decodes UTF-8; bytes that are not UTF-8 come back as U+FFFD. Saving that would corrupt the file.
export function looksMisdecoded(text) {
  return text.includes("\uFFFD");
}

// Start-up cleanup: a draft goes only when it is no longer needed. A missing or unreadable file
// keeps it (a branch switch must not lose edits); secret files never keep one.
export function cleanupDraft(draft, current) {
  if (isSecretFile(draft.path)) return "delete";
  if (draft.on) return "keep";
  return current !== null && sameText(current, draft.text) ? "delete" : "keep";
}
