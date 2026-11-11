// The current picture of a diagram for one view: drawn into the image cache under the view's own
// prefix (dropped with its tab, as image copies are), a new name per drawing (the image loader
// caches by path), the previous picture deleted once the new one is in place.
import * as fs from "fs/promises";
import { draftName } from "./files.js";
import { ensureFolder, folderPath, CACHE } from "./storage.js";
import { renderDiagram } from "./viewers.js";

// "dark" when a #rrggbb background is dark, so the diagram matches the theme.
export function themeOf(background) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(background ?? ""));
  if (!m) return "light";
  const [r, g, b] = m.slice(1).map(x => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? "dark" : "light";
}

const RETRY_MS = 60 * 1000;

export class DiagramPicture {
  // `key` is what the cache names follow: a file, or a block in one (diagramPath).
  constructor(on, key) {
    this.prefix = draftName(on, key).replace(/\.txt$/, "");
    this.image = null; this.error = null; this.drawn = null; this.drawing = false; this.stamp = 0;
  }

  // Draws `source` (`page` of a draw.io file) unless that exact source, theme and page are already
  // shown; true when it drew. A request during a drawing is kept and drawn next. A drawing that
  // failed for another reason than the diagram itself (a timeout, a missing tool) is not recorded
  // as drawn, but the same request waits RETRY_MS before it is tried again, unless `retry` (a click:
  // the person may have just installed what was missing).
  async draw(kind, source, theme, page = 0, { retry = false } = {}) {
    const wanted = `${theme}\n${page}\n${source}`;
    if (this.drawing) { this.pending = { kind, source, theme, page, retry: retry || this.pending?.retry }; return false; }
    if (wanted === this.drawn) return false;
    if (!retry && this.failed?.wanted === wanted && Date.now() - this.failed.at < RETRY_MS) return false;
    this.drawing = true;
    try {
      this.stamp = Math.max(this.stamp + 1, Date.now());
      const name = `${this.prefix}-${this.stamp}-d.png`, folder = await ensureFolder(CACHE);
      await renderDiagram(kind, source, `${folder}/${name}`, theme, page);
      const previous = this.image;
      this.image = `${CACHE}/${name}`; this.error = null; this.drawn = wanted; this.failed = null;
      if (previous) await fs.unlink(`${folderPath("")}${previous}`).catch(() => null);
    } catch (e) {
      // The last good picture stays, under the error.
      this.error = String(e?.message ?? e);
      if (e?.inDiagram) this.drawn = wanted; else this.failed = { wanted, at: Date.now() };
    } finally {
      this.drawing = false;
    }
    const next = this.pending;
    this.pending = null;
    if (next) await this.draw(next.kind, next.source, next.theme, next.page, { retry: Boolean(next.retry) });
    return true;
  }
}
