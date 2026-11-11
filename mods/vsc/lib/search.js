// Matching, replacing and fuzzy ranking for Search and Quick Open.
// Pure: no herdr imports, so it runs under node --test. Matching always happens here (grep only
// narrows the files to read), so Search and Replace agree on what matches.
import { lineDiff } from "./diff.js";

// Shared key: { root, on, rel } set by "Find in Folder…", limiting Search to that folder.
export const SEARCH_SCOPE = "vsc.search-scope";

export const MAX_PREVIEW = 200; // characters of a result line shown
const BEFORE = 12;              // characters kept before a match, so it stays in view in a narrow panel

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// { re } for a query, { error } for a regular expression that does not compile, null for nothing to find.
// Regular expressions are JavaScript's; ^ and $ apply per line.
export function buildMatcher(query, { matchCase, wholeWord, regex }) {
  if (!query) return null;
  const source = regex ? query : escape(query);
  try {
    return { re: new RegExp(wholeWord ? `\\b(?:${source})\\b` : source, `gm${matchCase ? "" : "i"}`) };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// Start offsets of each line, to turn a match offset into line and column.
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function preview(lineText, col, length) {
  const shownMatch = lineText.slice(col, col + Math.min(length, MAX_PREVIEW));
  const before = col > BEFORE ? `…${lineText.slice(col - BEFORE, col)}` : lineText.slice(0, col);
  const room = Math.max(0, MAX_PREVIEW - before.length - shownMatch.length);
  const rest = lineText.slice(col + length);
  return { before, match: shownMatch, after: rest.length > room ? `${rest.slice(0, room)}…` : rest };
}

// { matches: [{ line, col, length, preview: { before, match, after } }], truncated } with 1-based line and column.
// A match spanning lines is shown on its first line.
export function findMatches(text, matcher, limit = Infinity) {
  const re = new RegExp(matcher.re.source, matcher.re.flags), starts = lineStarts(text), matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (matches.length >= limit) return { matches, truncated: true };
    const index = lineAt(starts, m.index), start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] - 1 : text.length;
    const lineText = text.slice(start, end).replace(/\r$/, ""), col = m.index - start;
    matches.push({ line: index + 1, col: col + 1, length: m[0].length, preview: preview(lineText, col, Math.min(m[0].length, lineText.length - col)) });
    if (m[0].length === 0) re.lastIndex++;
  }
  return { matches, truncated: false };
}

// { text, count }. Plain-text mode inserts the replacement as typed; regex mode understands $1, $&.
export function replaceText(text, matcher, replacement, regex) {
  const re = new RegExp(matcher.re.source, matcher.re.flags);
  const count = [...text.matchAll(re)].length;
  return { text: count ? text.replace(re, regex ? replacement : () => replacement) : text, count };
}

// The lines a replacement changes, as diff rows.
export function changedRows(before, after) {
  return lineDiff(before, after).filter(r => r.kind !== " ");
}

const SEPARATOR = /[/._\-\s]/;

// Higher is better, null when the query's letters are not in the path in order. Letters are matched
// in the file name first, then in the whole path; consecutive letters and word starts score more.
export function fuzzyScore(query, path) {
  if (!query) return 0;
  const q = query.toLowerCase().replace(/\s+/g, ""), p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  const inName = match(q, p, nameStart), anywhere = inName ?? match(q, p, 0);
  if (anywhere === null) return null;
  return anywhere + (inName !== null ? 100 : 0) - p.length * 0.1;
}

function match(q, p, from) {
  let score = 0, last = -2, at = from;
  for (const ch of q) {
    const i = p.indexOf(ch, at);
    if (i === -1) return null;
    score += 1 + (i === last + 1 ? 5 : 0) + (i === 0 || SEPARATOR.test(p[i - 1]) ? 3 : 0);
    last = i; at = i + 1;
  }
  return score;
}

// The `limit` best paths for `query`; with no query, recently opened files first, then the list's order.
export function rankFiles(query, files, recent, limit) {
  if (!query) {
    const known = new Set(files), first = recent.filter(f => known.has(f)), seen = new Set(first);
    return [...first, ...files.filter(f => !seen.has(f))].slice(0, limit);
  }
  return files.map(f => ({ f, s: fuzzyScore(query, f) })).filter(x => x.s !== null)
    .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f)).slice(0, limit).map(x => x.f);
}

// NUL-separated paths (git ls-files -z, find -print0), at most `limit`.
// Output that does not end in NUL was cut off at a byte limit: its last, partial name is dropped.
export function parseFileList(out, limit) {
  const cut = out !== "" && !out.endsWith("\0");
  const all = out.split("\0").filter(Boolean);
  if (cut) all.pop();
  return { files: all.slice(0, limit), truncated: cut || all.length > limit };
}

// What one match becomes, for the result list: a function, so the pattern is compiled once per
// list rather than once per row. In regex mode the pattern is applied to the match alone; a pattern
// that needs the text around it (lookarounds, ^) shows the replacement as typed.
export function replacerFor(matcher, replacement, regex) {
  if (!regex) return () => replacement;
  const whole = new RegExp(`^(?:${matcher.re.source})$`, matcher.re.flags.replace("g", ""));
  return (matchText) => whole.test(matchText) ? matchText.replace(whole, replacement) : replacement;
}

// Whether grep -F can pick the files to read: it matches text exactly as JavaScript does except
// that grep -i does not fold case beyond ASCII on every system.
export function grepCanNarrow(query, { matchCase, regex }) {
  return !regex && (matchCase || /^[\x00-\x7f]*$/.test(query));
}

// A listed path must name a file below the folder: relative, with no "", "." or ".." parts.
export function plainPath(path) {
  return path !== "" && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

// Whether the real folder `dir` is the real root or below it.
export function insideFolder(root, dir) {
  return Boolean(dir) && (dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`));
}

// One file of a Replace preview: its machine (`on`) and whether it is ticked (`chosen`) are two keys.
export function planEntry({ rel, full, on, old, next, count }) {
  return { rel, full, on: on ?? null, old, next, count, rows: changedRows(old, next), chosen: true };
}
