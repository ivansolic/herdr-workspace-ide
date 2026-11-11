#!/usr/bin/env bash
# Copies this package's mods and layout into the Herdr app home for development.
# Copies, not symlinks: the app does not reliably pick up edits behind a symlink.
# Only replaces what this script put there before (a .vsc-dev marker), never a user's own files.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

for mod in "$repo"/mods/*/; do
  name="$(basename "$mod")" dst="$home/mods/$(basename "$mod")"
  if [ -L "$dst" ]; then rm "$dst"
  elif [ -e "$dst" ] && [ ! -e "$dst/.vsc-dev" ]; then echo "skip: $dst is not from this repo" >&2; continue
  fi
  mkdir -p "$dst"
  rsync -a --delete --exclude .vsc-dev "${mod}" "$dst/"
  touch "$dst/.vsc-dev"
  echo "copied: mods/$name"
done
for layout in "$repo"/layouts/*.json; do
  dst="$home/layouts/$(basename "$layout")"
  [ -L "$dst" ] && rm "$dst"
  if [ -e "$dst" ] && ! grep -q '"id": "vsc-' "$dst"; then echo "skip: $dst is not from this repo" >&2; continue; fi
  cp "$layout" "$dst"
  echo "copied: layouts/$(basename "$layout")"
done
