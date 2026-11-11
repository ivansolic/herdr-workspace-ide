// Line diff for Compare: common prefix and suffix, then LCS on what is left.
// Pure: no herdr imports, so it runs under node --test.

const LCS_CELLS = 4_000_000; // above this the middle is shown as a plain replace

// Rows of { kind: " " | "-" | "+", text, old, new } with 1-based line numbers (null when absent).
export function lineDiff(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const rows = [];
  for (let i = 0; i < start; i++) rows.push({ kind: " ", text: a[i], old: i + 1, new: i + 1 });
  rows.push(...middle(a, b, start, endA, endB));
  for (let i = endA, j = endB; i < a.length; i++, j++) rows.push({ kind: " ", text: a[i], old: i + 1, new: j + 1 });
  return rows;
}

function middle(a, b, start, endA, endB) {
  const n = endA - start, m = endB - start, out = [];
  const removed = (i) => ({ kind: "-", text: a[i], old: i + 1, new: null });
  const added = (j) => ({ kind: "+", text: b[j], old: null, new: j + 1 });
  if (n * m > LCS_CELLS) {
    for (let i = start; i < endA; i++) out.push(removed(i));
    for (let j = start; j < endB; j++) out.push(added(j));
    return out;
  }
  // lengths[i][j] = LCS of a[start+i..endA) and b[start+j..endB)
  const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lengths[i][j] = a[start + i] === b[start + j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { out.push({ kind: " ", text: a[start + i], old: start + i + 1, new: start + j + 1 }); i++; j++; }
    else if (i < n && (j === m || lengths[i + 1][j] >= lengths[i][j + 1])) { out.push(removed(start + i)); i++; }
    else { out.push(added(start + j)); j++; }
  }
  return out;
}
