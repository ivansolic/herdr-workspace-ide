// Diagram files and Mermaid blocks in Markdown. Pure: no herdr imports, so it runs under node --test.

const KINDS = { mmd: "mermaid", mermaid: "mermaid", drawio: "drawio", dio: "drawio", puml: "plantuml", plantuml: "plantuml", pu: "plantuml", excalidraw: "excalidraw" };

// The diagram kind a file is drawn with, or null.
export function diagramKind(path) {
  const name = String(path ?? "").split(/[\\/]/).pop().toLowerCase(), dot = name.lastIndexOf(".");
  return dot > 0 ? KINDS[name.slice(dot + 1)] ?? null : null;
}

// Fenced ```mermaid / ~~~mermaid blocks: { index (from 1), line (of the opening fence, from 1),
// source }. A fence closes only with the same character and at least as many; blocks inside other
// fences are code, not diagrams. An unclosed block runs to the end, as Markdown renders it.
export function mermaidBlocks(md) {
  const lines = String(md ?? "").split(/\r?\n/), blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(lines[i]);
    if (!open) {
      if (fence) open = { mark: fence[1], mermaid: fence[2].toLowerCase() === "mermaid", line: i + 1, body: [] };
    } else if (fence && fence[1][0] === open.mark[0] && fence[1].length >= open.mark.length && !fence[2]) {
      if (open.mermaid) blocks.push({ index: blocks.length + 1, line: open.line, source: open.body.join("\n") });
      open = null;
    } else open.body.push(lines[i]);
  }
  if (open?.mermaid) blocks.push({ index: blocks.length + 1, line: open.line, source: open.body.join("\n") });
  return blocks;
}

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// A numeric entity outside Unicode (a broken or hostile file) becomes U+FFFD instead of throwing.
const codePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd");
const decode = (text) => text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_all, e) =>
  e[0] === "#" ? codePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e.toLowerCase()]);

// The page names of a draw.io file (its <diagram> elements, compressed or not); a file with a bare
// model is one page. Unnamed pages are numbered.
export function drawioPages(xml) {
  const pages = [...String(xml ?? "").matchAll(/<diagram\b([^>]*)>/g)].map((m, i) => {
    const name = /\bname="([^"]*)"/.exec(m[1]);
    return name && name[1].trim() ? decode(name[1]) : `Page ${i + 1}`;
  });
  return pages.length ? pages : ["Page 1"];
}
