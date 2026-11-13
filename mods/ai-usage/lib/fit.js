// How tall a pane header must be: the usage row's parts wrapped onto the pane's width, as header.js draws them.

// About this many px a character at the header's text size.
export const CHAR = 5.6;
export const LIMIT_NAMES = { "5h": "5-hour limit", Week: "Weekly limit", Day: "Daily limit" };
// Folded (title row alone), a title and one row, a title and two rows.
export const HEIGHTS = { folded: 26, one: 44, two: 64 };

// The header's height for a title row and `rows` rows under it: 44, 64, then 19 px a row (83, 102 ...),
// as wrapped rows draw a little taller than one.
export const heightFor = (rows) => (rows <= 1 ? HEIGHTS.one : rows === 2 ? HEIGHTS.two : 26 + rows * 19);

// Below this width the usage row drops the reset times and draws short bars, so each part fits across.
export const TINY = 260;
// The bar's width in each form.
export const barWidth = (width, wide) => (width < TINY ? 28 : wide ? 56 : 40);

// Each part's width at `width` px (plan, limits, memory, cost), estimated from its text and bar.
export function usageParts(f, width, wide, now = Date.now()) {
  const tiny = width < TINY;
  const part = (chars, bars = 0, pieces = 2) => chars * CHAR + bars * barWidth(width, wide) + (pieces - 1) * 4;
  const sizes = [part(5 + (f.plan ?? "–").length)];
  for (const l of f.limits) {
    const reset = tiny ? 0 : l.resetsAt ? (l.resetsAt - now < 24 * 3600e3 ? 5 : 9) : l.resetsIn ? 3 + l.resetsIn.length : 0;
    const name = wide ? LIMIT_NAMES[l.label] ?? l.label : l.label;
    sizes.push(part(name.length + 4 + (reset ? reset + (wide ? 9 : 1) : 0), 1, reset ? 4 : 3));
  }
  if (f.context?.percent !== undefined && f.context?.percent !== null) sizes.push(part((wide ? 6 : 3) + 4 + (wide ? 22 : 0), 1, wide ? 4 : 3));
  sizes.push(part(5 + 8 + (wide ? 13 : 0), 0, wide ? 3 : 2));
  return sizes;
}

// How many rows the usage row wraps onto at `width` px, in full words (`wide`) or short labels; a part
// never splits, and each after the first carries its separator.
export function usageRows(f, width, wide, now = Date.now()) {
  const room = width - 20;
  let rows = 1, x = 0;
  const sizes = usageParts(f, width, wide, now);
  sizes.forEach((size, i) => {
    const w = size + (i ? 14 : 0);
    if (x && x + 8 + w > room) { rows++; x = w; } else x += (x ? 8 : 0) + w;
  });
  return rows;
}
