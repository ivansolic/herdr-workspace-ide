#!/usr/bin/env bash
# Installs Herdr Workspace Studio into the Herdr app: the workspace-studio layout, its vsc mod and the
# ai-usage mod (AI usage panel and the agent tracker in every pane's header), and this package's keys.
# Then switches to the layout and prints the line that adds the progress tracker to Claude Code.
#
#   ./install.sh               install and switch to the layout
#   ./install.sh --no-switch   install only
#
# What it replaces is kept in ~/.config/herdr-app/backups/<time>/; your own keys win over this package's.
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
stamp="$(date +%Y%m%d-%H%M%S)"
switch=1
[ "${1:-}" = "--no-switch" ] && switch=0

say() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { say "Missing: $1. $2"; exit 1; }; }

need herdr-app "Install the Herdr app first: https://herdr.dev"
need git "Source Control needs git 2.31 or newer."
if ! command -v node >/dev/null 2>&1; then
  say "Note: Node.js 20+ is not installed. The AI usage panel and agent tracker need it to read the agents' logs."
fi
[ -d "$home" ] || { say "No Herdr home at $home. Open the Herdr app once, then run this again."; exit 1; }

# A file or folder of ours goes in; what was there moves to backups/<time>/ (outside mods/, so Herdr
# never loads an old copy as a mod).
backup="$home/backups/$stamp"
put() {
  local from="$1" to="$2"
  if [ -e "$to" ]; then
    mkdir -p "$backup"
    mv "$to" "$backup/"
    say "kept the previous $(basename "$to") in $backup"
  fi
  cp -R "$from" "$to"
}

mkdir -p "$home/layouts" "$home/mods"
put "$repo/layouts/workspace-studio.json" "$home/layouts/workspace-studio.json"
put "$repo/mods/vsc" "$home/mods/vsc"
put "$repo/mods/ai-usage" "$home/mods/ai-usage"

for mod in vsc ai-usage; do
  herdr-app check "$home/mods/$mod"
done

# This package's keys go into keys.json section by section; a key you already set keeps your action.
keys="$home/keys.json"
if [ -f "$keys" ]; then mkdir -p "$backup" && cp "$keys" "$backup/keys.json"; else printf '{}\n' > "$keys"; fi
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const [mine, ours] = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
    for (const [section, keys] of Object.entries(ours)) mine[section] = { ...keys, ...(mine[section] ?? {}) };
    fs.writeFileSync(process.argv[1], JSON.stringify(mine, null, 2) + "\n");
  ' "$keys" "$repo/keys.json"
  say "keys merged into $keys (the previous file is in $backup)"
else
  say "Merge $repo/keys.json into $keys by hand (Node.js is needed to do it here)."
fi
[ -f "$home/keys.error" ] && { say "Herdr refused keys.json: $(cat "$home/keys.error")"; }

if [ "$switch" = 1 ]; then
  herdr-app do layout.switch '{"name":"workspace-studio"}' >/dev/null && say "switched to the workspace-studio layout"
fi

cat <<'EOF'

Done. In the Herdr window: the gauge icon in the rail opens AI usage; agents' panes show their tracker.

For Claude Code's progress tracker (tasks, subagents and limits above its prompt), type this at
the Claude Code prompt:

  /plugin install progress-tracker --marketplace ivansolic/herdr-workspace-studio
EOF
