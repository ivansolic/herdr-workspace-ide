// Bookkeeping for "one editor per file": which tab or side pane shows a file. Pure: no herdr
// imports, so it runs under node --test.

// The entries of `map` ({ fileKey: id }) whose tab or pane still exists.
export function liveOnly(map, liveIds) {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, id]) => liveIds.has(id)));
}

// The one id in `after` that was not in `before` (a tab or pane just opened), or null when there
// is none or more than one (something else opened at the same time: don't guess).
export function addedIds(before, after) {
  const added = [...after].filter(id => !before.has(id));
  return added.length === 1 ? added[0] : null;
}
