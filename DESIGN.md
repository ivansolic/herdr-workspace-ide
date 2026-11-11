# Design rules

Every mod in this package must look like it shipped with Herdr. These rules are
taken from Herdr's own mods (`files`, `changes`, `tabs`, `spaces`, `agents`,
`workspace-status`, `pane`) and its `main` layout, read on Herdr app 0.1.12.
When Herdr's own mods change, re-read them and update this file first.

## Colors: theme tokens only

Never write a hex color. Read `theme()` in `render` and use its names, so light
and dark themes and the theme picker work unchanged.

| Use | Token |
|---|---|
| Panel body (Files, Changes) | `background` |
| Bars and sidebars (tab bar, status bar) | `chrome` |
| Raised surface: active tab, diff hunk header, disabled button | `raised` |
| Row hover | `hover` |
| Selected or open row | `selected` |
| Lines, panel border, header separator | `border` |
| Text | `foreground` |
| Secondary text, inactive tab label, folder/file icons | `muted` |
| Hints, empty states, chevrons, counts, paths before a file name | `dim` |
| Focus ring, typing field border | `accent` |
| Primary button (Commit) | `solid` on, `solid_foreground` text; `raised` + `dim` when disabled |
| Popups and menus | `popover` |
| Text fields | `input` |
| Git added / untracked, `+N` | `ansi2` |
| Git deleted / conflict, `−N`, error notes | `ansi1` |
| Git modified | `blocked` |
| Unsaved changes (Explorer name + 7px dot; tab title gets `● `) | `ansi4` |
| Added / removed diff line background | `ansi2 + "18"` / `ansi1 + "18"` (hex alpha suffix) |
| Agent states | `working`, `blocked`, `done`, `idle`, `unknown` |

Code syntax (the `EditorState` `syntax` option, as `files` does):
`keyword: ansi5, string: ansi2, comment: dim, function: ansi4, type: ansi3,
number: ansi1, constant: ansi6`.

## Type

- Panel text 13 px; row metadata and hints 11–12 px; badges 10 px; tab labels 12.8 px.
- Panel title: `font_semibold()`, 13 px. No uppercase titles, no letter spacing.
- Code and diffs: `settings().font_family` (fallback "JetBrains Mono"), 11–12 px.
- Long names: `truncate()` with `min_w(0)` on the flex child.

## Size and spacing

| Element | Value |
|---|---|
| Panel | `rounded(10)`, `border_1()` `border`, `overflow_hidden()` |
| Panel header | `h(42)`, `px(14)`, `gap(8)`, `border_b(1)` `border` |
| List padding | `p(6)` around the list |
| Tree / list row | `h(28)`, `px(8)`, `gap(7)`–`gap(8)`, `rounded(7)`, `cursor_pointer()` |
| Tree indent | `pl(8 + depth * 18)` |
| Tab pill | `h(29)`, `px(10)`, `gap(7)`, `rounded(7)`, `border(1)` |
| Small icon button | `size(26)`, `rounded(6)`, `dim` → hover `hover` bg + `foreground` |
| Bar button with label (Files/Changes) | `h(26)`, `px(8)`, `gap(5)`, `rounded(6)`, 12 px |
| Text field / primary button | `h(32)`, `rounded(8)`, field `px(10)`, button `px(14)` |
| Footer action bar | `p(10)`, `gap(8)`, `border_t(1)` |
| Badge | `px(5)`, `py(1)`, `rounded(4)`, `border_1()`, 10 px `muted` |
| Diff row | `h(20)`, line number column `w(30)` right-aligned `dim` |
| Pane cards (layout) | `gap 6`, `radius 6`, `surface` background, `border` 1 px, focus `accent` 1 px |

Sizes are written as designed at zoom 1; the app scales them.

## Deliberate differences from Herdr's mods

These are chosen, not drift; keep them unless the reason goes away.

| Element | Here | Herdr | Why |
|---|---|---|---|
| Explorer tree row | `h(26)`, `pl(6 + depth * 14)`, `gap(6)` | `h(28)`, `pl(8 + depth * 18)`, `gap(7)` | VS Code density: deep trees stay readable in a 320 px panel |
| View header | `pl(14)`, `pr(8)`, `gap(4)` | `px(14)`, `gap(8)` | Its right side holds 26 px icon buttons, which carry their own padding |
| Activity rail icons | `size(18)` in a `size(34)` button | 12–14 | A rail of icons only needs a larger target, as in VS Code |
| Editor toolbar buttons (Save, conflict choices) | bar-button size `h(26)`, `px(10)`, `rounded(6)`; Save uses `solid` when enabled | primary `h(32)` | They sit in a 36 px toolbar |
| Compare line-number columns | `w(40)` | diff `w(30)` | Two columns, files up to five-digit line counts |
| Diff tab line-number columns | `w(40)` | diff `w(30)` | Same view as Compare |
| Source Control file rows | `h(26)`, `gap(6)` | `h(28)`, `gap(8)` | Same density as the Explorer tree |
| Source Control bar buttons (Pull, Push, Create, confirmations) | `h(26)`, `px(10)` | `h(26)`, `px(8)` | Room for the one-word labels next to the branch name |
| Open-file button in a change row | `size(20)`, `rounded(5)` | icon button `size(26)` | Fits inside a 26 px row |
| Source Control messages (errors, notes, conflicts) | above the file list | under the content | They are about the commit and branch controls above the list |
| Search file rows / match rows | `h(26)`, `gap(6)` / `h(22)` | `h(28)`, `gap(8)` | VS Code density: many results in a 320 px panel; match rows are lines of text, not items |
| Search option toggles (Aa, ab, .*) | `h(22)`, `px(5)`, `rounded(5)`, 11 px mono, `selected` + `accent` border when on | no equivalent | They sit inside the 32 px search field, as in VS Code |
| Search messages (counts, limits, errors) | above the results | under the content | They describe the search above them, like Source Control's |
| Problems rows | `h(26)`, `pl(26)`, severity icon 13, VS Code button `size(26)` | `h(28)` | Same density as Search; the source and position sit at the right like VS Code |
| Rail badge (Problems count) | `h(14)`, `min_w(14)`, `rounded(7)`, 9 px semibold, `ansi1` (errors) or `blocked` (warnings only) on `background` text | Herdr's tab badges | A count over a 34 px icon, as on VS Code's activity bar |
| Quick Open field | `h(36)`, `rounded(9)`, `accent` border, 12.8 px | same as Herdr's picker | Quick Open is a picker: it copies the picker, not the panel fields |

## States

- Hover: background `hover`; text may go `dim`/`muted` → `foreground`.
- Selected / open: background `selected`.
- Active tab: `raised` background with a `border` outline; inactive: `chrome` with no visible outline.
- Disabled: `raised` background, `dim` text, no `cursor_pointer()`.
- Focus inside a field: border `accent`.
- Empty and loading states: one line in `dim` inside the list padding
  ("Loading files…", "No uncommitted changes", "No folder"). Use the `…` character.
- Errors in a panel: `ansi1`, 11 px, under the content; never a modal for a recoverable error.
- Limits reached: one `dim` 11 px line that says the limit ("File list limited to …").

## Icons

- Line icons in Lucide style: 24×24 viewBox, `fill="none"`, `stroke="currentColor"`,
  `stroke-width="2"`, round caps and joins. Color comes from `text_color(...)`.
- Rendered with `svg("mods/<mod>/<name>.svg")` at `size(12)`–`size(14)`; chevrons 12, file/folder 14.
- File-type colors are theme tokens (`ansi*`), never fixed colors.

## Behavior

- Clicks: `on_click`; a click inside a row control calls `cx.stop_propagation()`.
  Bar buttons stop `mouse_down` so the window does not start a drag.
- Slow work (listing, git, reading files) runs in `cx.spawn` through `exec` /
  `readTextFile`, never in `render`. Show a loading line meanwhile.
- Bounded work: cap lists (Files: 500 per folder, 5,000 total; Changes: 1,000) and say so.
- Programs run with `exec(cmd, [args])`, arguments as a list, never a shell string built from input.
- Keep state per location (space + folder + machine) the way `files` does, so switching spaces restores the view.
