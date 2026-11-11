// File-type icons: which svg in mods/vsc/icons/ and which theme color token.
// Pure: no herdr imports, so it runs under node --test.

const NAMES = {
  "package.json": ["package", "ansi1"],
  "package-lock.json": ["lock", "dim"],
  "pnpm-lock.yaml": ["lock", "dim"],
  "yarn.lock": ["lock", "dim"],
  "bun.lockb": ["lock", "dim"],
  "cargo.lock": ["lock", "dim"],
  "poetry.lock": ["lock", "dim"],
  ".gitignore": ["git", "ansi1"],
  ".gitattributes": ["git", "ansi1"],
  ".gitmodules": ["git", "ansi1"],
  "dockerfile": ["container", "ansi4"],
  "docker-compose.yml": ["container", "ansi4"],
  "docker-compose.yaml": ["container", "ansi4"],
  "makefile": ["terminal", "ansi2"],
};

const EXTENSIONS = {
  ts: ["file-code", "ansi4"], tsx: ["file-code", "ansi4"], mts: ["file-code", "ansi4"], cts: ["file-code", "ansi4"],
  js: ["file-code", "ansi3"], jsx: ["file-code", "ansi3"], mjs: ["file-code", "ansi3"], cjs: ["file-code", "ansi3"],
  py: ["file-code", "ansi4"], rb: ["file-code", "ansi1"], go: ["file-code", "ansi6"], rs: ["file-code", "ansi1"],
  java: ["file-code", "ansi1"], kt: ["file-code", "ansi5"], swift: ["file-code", "ansi1"], c: ["file-code", "ansi4"],
  h: ["file-code", "ansi5"], cpp: ["file-code", "ansi4"], cs: ["file-code", "ansi5"], php: ["file-code", "ansi5"],
  vue: ["file-code", "ansi2"], svelte: ["file-code", "ansi1"], lua: ["file-code", "ansi4"], dart: ["file-code", "ansi6"],
  html: ["code", "ansi1"], htm: ["code", "ansi1"], xml: ["code", "ansi1"], svg: ["image", "ansi3"],
  css: ["palette", "ansi4"], scss: ["palette", "ansi5"], sass: ["palette", "ansi5"], less: ["palette", "ansi4"],
  json: ["braces", "ansi3"], jsonc: ["braces", "ansi3"], json5: ["braces", "ansi3"],
  yml: ["file-cog", "ansi5"], yaml: ["file-cog", "ansi5"], toml: ["file-cog", "ansi5"], ini: ["file-cog", "muted"],
  conf: ["file-cog", "muted"], cfg: ["file-cog", "muted"],
  md: ["file-text", "ansi4"], mdx: ["file-text", "ansi4"], txt: ["file-text", "muted"], rst: ["file-text", "muted"],
  pdf: ["file-text", "ansi1"], csv: ["table", "ansi2"], tsv: ["table", "ansi2"], xlsx: ["table", "ansi2"],
  sql: ["database", "ansi6"], db: ["database", "ansi6"], sqlite: ["database", "ansi6"],
  sh: ["terminal", "ansi2"], bash: ["terminal", "ansi2"], zsh: ["terminal", "ansi2"], fish: ["terminal", "ansi2"], ps1: ["terminal", "ansi4"],
  png: ["image", "ansi5"], jpg: ["image", "ansi5"], jpeg: ["image", "ansi5"], gif: ["image", "ansi5"], webp: ["image", "ansi5"],
  ico: ["image", "ansi5"], bmp: ["image", "ansi5"],
  zip: ["archive", "dim"], gz: ["archive", "dim"], tar: ["archive", "dim"], tgz: ["archive", "dim"], "7z": ["archive", "dim"],
  lock: ["lock", "dim"], log: ["file-text", "dim"],
  env: ["key", "ansi3"], pem: ["key", "ansi3"], key: ["key", "ansi3"],
};

const DIM_FOLDERS = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".next", ".venv", "venv", "__pycache__", ".cache"]);

const result = ([icon, color]) => ({ icon, color });

export function fileIcon(name) {
  const lower = (name ?? "").toLowerCase();
  if (NAMES[lower]) return result(NAMES[lower]);
  if (lower === ".env" || lower.startsWith(".env.")) return result(EXTENSIONS.env);
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 || (dot === 0 && lower.length > 1 && !lower.slice(1).includes(".")) ? lower.slice(dot + 1) : "";
  return result(EXTENSIONS[ext] ?? ["file", "muted"]);
}

export function folderIcon(name, open) {
  return { icon: open ? "folder-open" : "folder", color: DIM_FOLDERS.has(name) ? "dim" : "muted" };
}

// Every icon name this module can return, for checks that the svg files exist.
export const ICON_NAMES = [...new Set([...Object.values(NAMES), ...Object.values(EXTENSIONS)].map(([icon]) => icon).concat(["file", "folder", "folder-open"]))];
