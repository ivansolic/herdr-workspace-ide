// Herdr's shipped main layout against the copy the workspace-studio layout follows (main-base.json): Herdr replaces
// main on updates, and the workspace-studio layout, built from parts of it, would miss what changed. Pure: no herdr
// imports, so it runs under node --test.

// The layout as JSON with keys in order, so the same layout written another way compares equal; null
// when the text is not JSON (a file read while it was being written).
export function canonical(text) {
  const sorted = (v) => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  try { return JSON.stringify(sorted(JSON.parse(text))); } catch { return null; }
}

// FNV-1a, as files.js's draft names.
function fingerprintOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

// Whether to say main changed: only when it differs from the base and that version was not shown
// before (`seen`: the fingerprint remembered when it was). `fingerprint`: the current version's, to
// remember when noticed (null when there is none). `reason`: "missing" / "unreadable" (main.json),
// "base unreadable", "same", "seen" or "changed", so a check that cannot work is not silent.
export function layoutNotice({ base, current, seen }) {
  const was = canonical(base);
  if (was === null) return { notice: false, fingerprint: null, reason: "base unreadable" };
  if (current === null) return { notice: false, fingerprint: null, reason: "missing" };
  const now = canonical(current);
  if (now === null) return { notice: false, fingerprint: null, reason: "unreadable" };
  if (now === was) return { notice: false, fingerprint: null, reason: "same" };
  const fingerprint = fingerprintOf(now);
  return fingerprint === seen ? { notice: false, fingerprint, reason: "seen" } : { notice: true, fingerprint, reason: "changed" };
}
