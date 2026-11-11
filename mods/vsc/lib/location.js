// The folder the panel views show: the focused terminal's. While an editor or diff tab (a mod pane,
// which has no folder) has focus, the last terminal folder of that space stays.
import { spaces, panes, focused } from "herdr";
import { MOD } from "./open.js";

let lastTerminal = null;

export function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  if (pane?.mod === MOD && lastTerminal?.space === space?.id) return lastTerminal;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const here = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
  if (pane && !pane.mod) lastTerminal = here;
  return here;
}

export const locationKey = () => JSON.stringify(location());
