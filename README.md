# Herdr Workspace Studio

An editor workbench for the [Herdr](https://herdr.dev) app, plus a view of what your coding agents cost.
It works in the style of VS Code but isn't affiliated with Microsoft or Visual Studio Code.

![Explorer, a terminal and an editor side by side in Herdr](docs/images/workspace.png)

| Part | What it gives you |
| --- | --- |
| **Workspace layout** | Explorer, Source Control, Search, Problems and editor tabs next to your terminals |
| **AI usage panel** | Subscriptions and limits, cost by day, project, feature and model, for Claude Code, Gemini CLI and Codex |
| **Agent tracker** | Every pane with an agent shows its plan, limits, memory, cost and task list, for any agent |
| **Claude Code progress tracker** | Tasks and subagents with progress bars inside Claude Code, above its prompt |

Runs on macOS and Linux and needs Herdr 0.1.14 or newer. The AI usage panel also needs Node 20+.

## Workspace layout

- **Explorer:** a file tree with git marks and a VS Code-style right-click menu.
- **Source Control:** commit, switch branches, pull and push. Secrets are never committed or pushed.
- **Search and Quick Open:** search and replace across the folder (`cmd-shift-f`), or jump to a file by name (`cmd-p`).
- **Problems:** TypeScript, ESLint and Ruff results from the project's own tools, once you trust the folder.
- **Editor tabs:** code with syntax colors, Markdown, images, PDFs and Office documents, and diagrams (Mermaid, draw.io, Excalidraw, PlantUML).

![Source Control: changed files, commit, pull and push](docs/images/source-control.png)

![A Mermaid diagram from a README, drawn in its own tab](docs/images/diagram.png)

Every feature in detail: [docs/workspace.md](docs/workspace.md).

## AI usage panel

Open it with the gauge icon at the bottom of the rail.

<p>
  <img src="docs/images/ai-usage-overview.png" width="292" alt="AI usage: subscriptions, limits, cost, a 30-day chart, projects and models">
  &nbsp;
  <img src="docs/images/ai-usage-project.png" width="292" alt="A project: budget, cost, and a feature opened down to its models and subagents">
</p>

- **Subscriptions:** your Claude plan is detected, along with its 5-hour and weekly limits and when they reset. For Gemini and Codex you pick the plan yourself. Each card shows whether the plan beats paying per token.
- **Cost:** today, this week, this month, the month projected, and 30 days up to all time, with a chart by day and what the prompt cache saved. Amounts are at API list price, in dollars or euros (ECB rate).
- **Projects and features:** click a project to see its total so far, its git branches as features, and inside each feature its agents, models and subagents. You can set a monthly budget, which warns you at 80% and 100%, and export a CSV.
- **Models:** every model you use, compared side by side, from all agents.

Everything comes from each agent's own logs on your computer. Usage figures only, nothing is sent anywhere.

## Agent tracker

Every pane where Herdr recognizes an agent gets a header that tracks it. You don't set anything up:

```
◆ Codex · api-gateway · main                                                      ⤢
Plan ChatGPT Plus │ 5h ▬▬ 31% ↻18:40 │ Week ▬ 9% │ Mem ▬ 20% │ Cost ~$1.20
⠹ Tasks ▬▬▬ 1/3 · now: Add rate limiter
```

- **Claude Code, Codex and Gemini CLI:** their task lists (TaskCreate, `update_plan`, `write_todos`), memory, cost and plan, read live from their own session logs.
- **Plans and limits are detected:**
  - **Claude:** from its login.
  - **Codex:** the plan field of its login, and its 5-hour and weekly limits from its logs.
  - **Gemini:** run `/stats` in a Gemini pane and its plan and daily limit appear.
- **Click ⤢** to open a window with every task and subagent.
- **Other agents** keep Herdr's usual header for now, and plain shells keep it too.

## Claude Code progress tracker

A plugin for Claude Code. It draws a band above the prompt:

```
Tasks      ████████░░░░ 3 of 5 done · now: Running tests
Subagents  1 running · 1 done
           ⠹ Map the checkout flow (Explore)  steps ███░ 3/4  running 42s · 7 tool calls
╭─────────────────────────────────────────────────────────────────────────────────╮
│ Plan Max 5x │ 5-hour limit ▰▰▰▰▱▱▱▱▱▱ 42% · resets 21:54 │ Weekly limit ▰▰▱▱▱▱ 18% │
│ Memory ▰▰▰▰▱▱▱▱▱▱ 37% · 370k of 1.0M tokens │ Cost $18.40 at API price [ History ] │
╰─────────────────────────────────────────────────────────────────────────────────╯
```

The tracker writes a small snapshot per session, which the AI usage panel reads for live limits and subagents. Type `/tracker help` for its commands.

## Install

**Herdr: layout, panels and agent tracker.** One command:

```sh
git clone https://github.com/ivansolic/herdr-workspace-studio && cd herdr-workspace-studio && ./install.sh
```

The script does five things:
- copies the layout and both mods
- checks them in Herdr
- merges the keys below into yours (your own keys win)
- switches to the layout
- prints the Claude Code line below

Anything it replaces is kept in `~/.config/herdr-app/backups/`. `ctrl-shift-l` switches back to your previous layout. Source Control needs git 2.31 or newer.

**Claude Code: progress tracker.** Type this at the Claude Code prompt:

```
/plugin install progress-tracker --marketplace ivansolic/herdr-workspace-studio
```

## Keys

| Key | Action |
| --- | --- |
| `cmd-shift-e` | Explorer |
| `ctrl-shift-g` | Source Control |
| `cmd-shift-f` | Search |
| `cmd-shift-m` | Problems |
| `cmd-p` | Quick Open (Herdr's own picker moves to `cmd-k`) |
| `cmd-s` | Save, in an editor tab |

## Privacy and what it runs

Nothing leaves your computer, apart from one download of the ECB's public euro rate. The full list of the programs it runs and what it reads and writes is in [docs/security.md](docs/security.md).

## Develop

```sh
./scripts/dev-link.sh                     # copy mods/ and layouts/ into ~/.config/herdr-app
herdr-app check mods/vsc                  # check a mod after each change
npm test                                  # tests (Node 20+)
node scripts/ai-usage-demo.mjs            # AI usage with made-up data, for screenshots; --off to leave
claude plugin test claude-code/progress-tracker
```

Look and feel follow [DESIGN.md](DESIGN.md).

## License

MIT, see [LICENSE](LICENSE). Third-party code and icons: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
