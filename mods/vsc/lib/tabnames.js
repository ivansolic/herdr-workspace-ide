// Names for terminal tabs: the agent in it and its folder, else the folder and git branch. Pure: no
// herdr imports, so it runs under node --test.
//
// Herdr reports a renamed tab as named, whoever renamed it, so the names this mod gave are remembered:
// a tab is renamed while it is unnamed or still carries the name it was given here. Once someone names
// it otherwise it is forgotten and left alone (renaming it to "" makes it unnamed again).
//
// Remembered per tab id: { name } once that name shows, or { name, was, sent, tries } while renames have
// not shown up yet (a slow machine, a failed command): `sent` lists the names sent and not yet seen
// settled, `was` every other name the tab may still show (its name before, and those sent), and a tab
// carrying one of them is still this mod's. After LAST_TRY checks they are dropped, so the remembered
// names stop changing.
// A name is forgotten only on evidence: the tab shows another name on a machine that is ready, or that
// machine is ready and the tab is gone. A tab merely out of sight (a layout still loading) keeps it.

export const NAME_LIMIT = 40;
// Checks after which a rename that has not shown up is sent again; after the last it is not resent.
const RETRY_AT = new Set([5, 30, 120]), LAST_TRY = 120;

const baseName = (path) => String(path).replace(/\/+$/, "").split("/").pop() || "/";
const machineOf = (id) => (id.includes("/") ? id.slice(0, id.indexOf("/")) : null);

function cut(name) {
  const chars = [...name];
  return chars.length > NAME_LIMIT ? `${chars.slice(0, NAME_LIMIT - 1).join("")}…` : name;
}

// "~" only for this computer's home: another machine's home is a different folder.
function folderLabel(cwd, home, machine) {
  return machine === null && cwd === home ? "~" : baseName(cwd);
}

// The name a tab should carry, or null when its terminals give nothing to name it by.
function wantedName(tabPanes, agentPanes, agentKeys, home, machine) {
  const terminals = tabPanes.filter(p => p.terminal);
  // The first agent in pane order: one that reports its status (agents()), or a terminal running a
  // program Herdr knows as an agent (knownAgents()): Claude Code without its status hook reports
  // nothing, and Herdr then marks its program agent: false.
  const agent = terminals.find(p => agentPanes.has(p.pane) || p.program?.agent || agentKeys.has(p.program?.key));
  if (agent) {
    const program = agentPanes.get(agent.pane)?.program?.name ?? agent.program.name;
    return cut(agent.cwd ? `${program} · ${folderLabel(agent.cwd, home, machine)}` : program);
  }
  const first = terminals[0];
  if (!first?.cwd) return null;
  const folder = folderLabel(first.cwd, home, machine);
  return cut(first.branch ? `${folder} · ${first.branch}` : folder);
}

// Entries from earlier versions of this mod: the bare name, or a pending rename with `was` as one name.
function entryOf(value) {
  if (typeof value === "string") return { name: value };
  return value.was === undefined || Array.isArray(value.was) ? value : { ...value, was: [value.was], sent: [value.name] };
}

const unique = (names, except) => [...new Set(names)].filter(n => n !== undefined && n !== except);

// What to rename now ({ id, name }, in tab order) and the names to remember afterwards. `agentKeys`: the
// program keys of the agents Herdr knows. `ready(machine)` says whether that machine's layout can be
// changed; its tabs are skipped (and remembered) until then.
export function tabRenames({ spaces, panes, agents, agentKeys, home, remembered, ready }) {
  const renames = [], kept = {}, seen = new Set(), byTab = new Map(), agentPanes = new Map();
  for (const pane of panes) { if (byTab.has(pane.tab)) byTab.get(pane.tab).push(pane); else byTab.set(pane.tab, [pane]); }
  for (const agent of agents) agentPanes.set(agent.pane, agent);
  for (const space of spaces) {
    for (const tab of space.tabs) {
      seen.add(tab.id);
      const entry = remembered[tab.id] === undefined ? undefined : entryOf(remembered[tab.id]);
      const keep = () => { if (entry) kept[tab.id] = entry; };
      if (!ready(space.machine)) { keep(); continue; }
      const tabPanes = byTab.get(tab.id) ?? [];
      // Terminals not listed yet: nothing to decide on (a tab with only mod panes has no entry).
      if (!tabPanes.some(p => p.terminal)) { keep(); continue; }
      const inFlight = entry?.was ?? [], sent = entry?.sent ?? [];
      if (tab.named && tab.name !== entry?.name && !inFlight.includes(tab.name)) continue;
      const wanted = wantedName(tabPanes, agentPanes, agentKeys, home, space.machine);
      if (wanted === null) { keep(); continue; }
      if (tab.named && tab.name === wanted) {
        // Settled; names sent before it may still land, for a while.
        const late = unique(sent, wanted), tries = (entry?.tries ?? 0) + 1;
        kept[tab.id] = late.length && tries < LAST_TRY ? { name: wanted, was: late, sent: late, tries } : { name: wanted };
        continue;
      }
      if (entry?.name === wanted && sent.includes(wanted) && inFlight.includes(tab.name)) {
        // Waiting for the wanted name to show: resent a few times, then left as it is.
        if (entry.tries >= LAST_TRY) { keep(); continue; }
        const tries = entry.tries + 1;
        if (RETRY_AT.has(tries)) renames.push({ id: tab.id, name: wanted });
        kept[tab.id] = { ...entry, tries };
        continue;
      }
      renames.push({ id: tab.id, name: wanted });
      const nowSent = unique([...sent, wanted]);
      kept[tab.id] = { name: wanted, was: unique([tab.name, ...inFlight, ...nowSent], wanted), sent: nowSent, tries: 0 };
    }
  }
  // A tab not listed is forgotten only when its machine is ready (then it is closed).
  for (const [id, value] of Object.entries(remembered)) {
    if (!seen.has(id) && !ready(machineOf(id))) kept[id] = entryOf(value);
  }
  return { renames, remembered: kept };
}
