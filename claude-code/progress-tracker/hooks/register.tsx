import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FinishedList, History, ModelTokens, Plan, Settings, Subagent, Task, TaskBoard, TaskStatus, Tokens, Usage } from '../types'

// Bump a shape tag when that value's fields change: old stored values are declined.
const tasks = atom({ plugin: 'progress-tracker', key: 'tasks' } as const, {} as TaskBoard, { shape: 'tasks-1' })
const agents = atom({ plugin: 'progress-tracker', key: 'agents' } as const, [] as Subagent[], { shape: 'agents-2' })
const history = atom({ plugin: 'progress-tracker', key: 'history' } as const, { agents: [], lists: [] } as History, {
  shape: 'history-1',
})
const mainTokens = atom({ plugin: 'progress-tracker', key: 'mainTokens' } as const, emptyTokens(), { shape: 'tokens-1' })
const modelTokens = atom({ plugin: 'progress-tracker', key: 'modelTokens' } as const, {} as ModelTokens, { shape: 'models-1' })
const usage = atom({ plugin: 'progress-tracker', key: 'usage' } as const, { limits: [] } as Usage, { shape: 'usage-2' })
const settings = atom({ plugin: 'progress-tracker', key: 'settings' } as const, defaultSettings(), { shape: 'settings-1' })
const plan = atom({ plugin: 'progress-tracker', key: 'plan' } as const, null as Plan | null, { shape: 'plan-1' })
const counted = atom({ plugin: 'progress-tracker', key: 'counted' } as const, 0)
const warned = atom({ plugin: 'progress-tracker', key: 'warned' } as const, [] as string[])
const isHidden = atom({ plugin: 'progress-tracker', key: 'isHidden' } as const, false)
// Written once a second while something runs, so the band redraws its spinner and elapsed time.
const tick = atom({ plugin: 'progress-tracker', key: 'tick' } as const, 0)

// Accent colors fixed to Claude Code's light theme, so the band looks the same in light and dark themes.
// Plain text keeps the theme's own colors (dimColor, 'text'), which stay readable on either background.
const ACCENT = {
  claude: '#D77757',
  suggestion: '#5769F7',
  success: '#2C7A39',
  warning: '#966C1E',
  error: '#AB2B3F',
  // Labels and the border of the always-on usage line: the brown of Claude's light theme ("auto mode on").
  brown: '#966C1E',
} as const

const MAIN = 'main'
const PANE = 'progress-history'
const PROGRESS_TOOL = 'mcp__progress-tracker__progress'
const BAR_WIDTH = 16
const HIDE_AFTER_MS = 15000
const FOLD_OVER = 3
const WARN_AT = [80, 95]
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'Week', spend_limit: 'Spend' }

const SUBAGENT_HINT =
  '\n\n(Progress reporting: if the tool mcp__progress-tracker__progress is available, call it once you know your ' +
  'steps, with done=0 and total=<number of steps>, and again after each step with the new done count and a short ' +
  'step label. It only updates a progress bar for the user; never let it change your work.)'

function emptyTokens(): Tokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function defaultSettings(): Settings {
  return { mode: 'auto', budgetDay: 10, budgetMonth: 200, days: {} }
}

type RawUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const addTokens = (a: Tokens, u: RawUsage): Tokens => ({
  input: a.input + u.input_tokens,
  output: a.output + u.output_tokens,
  cacheRead: a.cacheRead + u.cache_read_input_tokens,
  cacheWrite: a.cacheWrite + u.cache_creation_input_tokens,
})

const totalTokens = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite

// Relative price weight of each token kind (input = 1), as the API prices them.
const weighted = (t: Tokens) => t.input + t.output * 5 + t.cacheRead * 0.1 + t.cacheWrite * 1.25

const bar = (done: number, total: number, width = BAR_WIDTH) => {
  const filled = total === 0 ? 0 : Math.min(width, Math.round((done / total) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// Segmented gauge for the usage line, 0-100.
const gauge = (percent: number, width = 10) => {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

const levelColor = (percent: number) => (percent >= 90 ? ACCENT.error : percent >= 70 ? ACCENT.warning : ACCENT.success)

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const money = (usd: number) => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`)

const pad2 = (n: number) => String(n).padStart(2, '0')

const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const monthKey = (ms: number) => dayKey(ms).slice(0, 7)

// "15:40 (2h10m)" within a day, else "Mon 09:00".
const resetLabel = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const d = new Date(at)
  return at - now < 24 * 3600 * 1000 ? `${hhmm(d)} (${elapsed(at - now)})` : `${WEEKDAYS[d.getDay()]} ${hhmm(d)}`
}

const spentToday = (s: Settings, now: number) => s.days[dayKey(now)] ?? 0

const spentMonth = (s: Settings, now: number) => {
  const month = monthKey(now)
  return Object.entries(s.days).reduce((sum, [day, usd]) => (day.startsWith(month) ? sum + usd : sum), 0)
}

const isSubscription = (s: Settings, u: Usage) => s.mode === 'subscription' || (s.mode === 'auto' && u.limits.length > 0)

// A subagent's share of the session cost, by price-weighted tokens: an estimate.
const agentUsd = (a: Subagent, all: Subagent[], main: Tokens, u: Usage) => {
  if (u.usd === undefined) return undefined
  const sum = weighted(main) + all.reduce((s, x) => s + weighted(x.tokens), 0)
  return sum === 0 ? undefined : (u.usd * weighted(a.tokens)) / sum
}

const setTasks = (board: TaskBoard, loop: string, fn: (list: Task[]) => Task[]): TaskBoard => {
  const list = fn(board[loop] ?? [])
  const next = { ...board }
  if (list.length === 0) delete next[loop]
  else next[loop] = list
  return next
}

const isFinished = (list: Task[] | undefined) => !!list && list.length > 0 && list.every(t => t.status === 'completed')

// Seat list prices per month (monthly billing, annual billing), from claude.com pricing.
const SEAT_PRICES: Record<string, [string, number, number]> = {
  team_standard: ['Team · Standard seat', 25, 20],
  team_premium: ['Team · Premium seat', 125, 100],
}

// Reads the plan from the login Claude Code keeps; only the plan fields are used.
const detectPlan = async ($: EngineInterface): Promise<Plan | null> => {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME'))
  if (!dir) return null
  let account: Record<string, unknown>
  try {
    const config = JSON.parse(await $.fs.read(`${dir}/.claude.json`)) as { oauthAccount?: Record<string, unknown> }
    if (!config.oauthAccount) return null
    account = config.oauthAccount
  } catch {
    return null
  }
  const orgType = String(account.organizationType ?? '')
  const seat = String(account.seatTier ?? '')
  const tier = String(account.userRateLimitTier ?? account.organizationRateLimitTier ?? '')
  const extraUsage = account.hasExtraUsageEnabled === true
  const seatPrice = SEAT_PRICES[seat]
  if (seatPrice) return { name: seatPrice[0], listUsd: seatPrice[1], annualUsd: seatPrice[2], extraUsage }
  if (orgType.includes('enterprise')) return { name: 'Enterprise', extraUsage }
  if (tier.includes('max_20x')) return { name: 'Max 20x', listUsd: 200, extraUsage }
  if (tier.includes('max_5x') || orgType.includes('max')) return { name: 'Max 5x', listUsd: 100, extraUsage }
  if (orgType.includes('pro')) return { name: 'Pro', listUsd: 20, annualUsd: 17, extraUsage }
  if (orgType.includes('team')) return { name: 'Team', extraUsage }
  return null
}

const saveSettings = async ($: EngineInterface, fn: (s: Settings) => Settings) => {
  const next = await update($, settings, fn)
  await $.store.set('settings', next)
  return next
}

// Toasts once per threshold per window (limits) or per day/month (budgets).
const warn = async ($: EngineInterface, label: string, percent: number, scope: string) => {
  const crossed = WARN_AT.filter(t => percent >= t).pop()
  if (crossed === undefined) return
  const id = `${label}:${crossed}:${scope}`
  const seen = await read($, warned)
  if (seen.includes(id)) return
  await update($, warned, list => [...list, id].slice(-50))
  $.ui.toast(`${label} at ${Math.round(percent)}%`)
}

const refreshUsage = async ($: EngineInterface) => {
  const now = await $.session.usage()
  const at = await $.clock.now()
  const next: Usage = {
    usd: now.cost?.usd,
    contextPercent: now.context.percent,
    contextTokens: now.context.tokens,
    contextWindow: now.context.window,
    limits: now.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  }
  await update($, usage, () => next)

  // Add what the session cost since the last reading to today's ledger.
  if (next.usd !== undefined) {
    const before = await read($, counted)
    const delta = next.usd - before
    if (delta > 0) {
      const today = dayKey(at)
      await update($, counted, () => next.usd!)
      await saveSettings($, s => {
        const days = { ...s.days, [today]: (s.days[today] ?? 0) + delta }
        // Keep about two months of days.
        const keep = Object.keys(days).sort().slice(-62)
        return { ...s, days: Object.fromEntries(keep.map(k => [k, days[k]!])) }
      })
    }
  }

  const s = await read($, settings)
  for (const l of next.limits) await warn($, `${LIMIT_LABEL[l.kind] ?? l.kind} limit`, l.percentUsed, l.resetsAt ?? '')
  if (!isSubscription(s, next)) {
    await warn($, 'Daily budget', (spentToday(s, at) / s.budgetDay) * 100, dayKey(at))
    await warn($, 'Monthly budget', (spentMonth(s, at) / s.budgetMonth) * 100, monthKey(at))
  }
  if (next.contextPercent !== undefined) await warn($, 'Memory', next.contextPercent, String(next.contextWindow))
}

// Moves finished work out of the band into the history, once nothing runs.
const archive = async ($: EngineInterface, now: number) => {
  const list = await read($, agents)
  const board = await read($, tasks)
  const main = board[MAIN]
  const done = list.filter(a => a.status !== 'running')
  const finishedList: FinishedList | undefined = isFinished(main)
    ? { at: now, done: main!.length, total: main!.length, subjects: main!.map(t => t.subject) }
    : undefined
  if (done.length === 0 && !finishedList) return
  await update($, history, past => ({
    agents: [...past.agents, ...done].slice(-100),
    lists: finishedList ? [...past.lists, finishedList].slice(-30) : past.lists,
  }))
  await update($, agents, l => l.filter(a => a.status === 'running'))
  await update($, tasks, b => {
    let next = b
    for (const a of done) next = setTasks(next, a.id, () => [])
    return finishedList ? setTasks(next, MAIN, () => []) : next
  })
}

const openHistory = ($: EngineInterface) =>
  $.ui.open({ id: PANE, title: 'Progress & usage', closeOnEscape: true })

const parseUsd = (text: string | undefined) => {
  const n = Number((text ?? '').replace(/^\$/, ''))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// Snapshots for other apps (the herdr Claude usage panel): one file per session, local only.
// They hold usage figures, project folder names and task labels; no prompts, no file contents.
const EXPORT_DIR = '.claude/progress-tracker'
const EXPORT_EVERY_MS = 5000

const exportSnapshot = async ($: EngineInterface, session: { id: string; cwd: string; startedAt: number; home: string }) => {
  const [s, u, detected, models, live, past, board] = await Promise.all([
    read($, settings),
    read($, usage),
    read($, plan),
    read($, modelTokens),
    read($, agents),
    read($, history),
    read($, tasks),
  ])
  const main = board[MAIN] ?? []
  const snapshot = {
    version: 1,
    sessionId: session.id,
    project: session.cwd.split('/').filter(Boolean).pop() ?? session.cwd,
    cwd: session.cwd,
    startedAt: session.startedAt,
    updatedAt: await $.clock.now(),
    plan: detected,
    mode: s.mode,
    planUsd: s.planUsd ?? null,
    budget: { day: s.budgetDay, month: s.budgetMonth },
    usage: u,
    models,
    tasks: {
      done: main.filter(t => t.status === 'completed').length,
      total: main.length,
      active: main.find(t => t.status === 'in_progress')?.activeForm ?? null,
    },
    agents: [...past.agents, ...live].slice(-50).map(a => ({
      id: a.id,
      description: a.description,
      type: a.type,
      model: a.model,
      status: a.status,
      startedAt: a.startedAt,
      endedAt: a.endedAt ?? null,
      tools: a.tools,
      tokens: a.tokens,
      steps: a.reported ? { done: a.reported.done, total: a.reported.total } : null,
    })),
    lists: past.lists.slice(-20),
  }
  const dir = `${session.home}/${EXPORT_DIR}`
  await $.fs.write(`${dir}/sessions/${session.id}.json`, JSON.stringify(snapshot))
  await $.fs.write(`${dir}/ledger.json`, JSON.stringify({ version: 1, days: s.days }))
}

const HELP =
  '/tracker                       show or hide the band\n' +
  '/tracker history               open progress & usage\n' +
  '/tracker mode auto|api|subscription\n' +
  '/tracker budget day 10         daily API budget in $\n' +
  '/tracker budget month 200      monthly API budget in $\n' +
  '/tracker plan 25 | auto         your subscription price per month in $ (auto: from your plan)'

export const register: Register = on => {
  // Set when something worth exporting changed since the last snapshot.
  let dirty = false
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tracker', description: 'Progress & usage tracker: history, mode, budget, plan, help' })
    await $.tool.register({
      name: 'progress',
      description:
        "Report your progress on the current task to the user's progress bar. Call with done=0 and total=<steps> " +
        'once you know your steps, then after each step. Purely informational; it changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far' },
          total: { type: 'integer', minimum: 1, description: 'Total number of steps' },
          step: { type: 'string', description: 'Short label of the step now running' },
        },
        required: ['done', 'total'],
      },
      isDeferred: false,
    })

    const saved = (await $.store.get('settings')) as Partial<Settings> | undefined
    if (saved && typeof saved === 'object') await update($, settings, s => ({ ...s, ...saved, days: saved.days ?? s.days }))
    const detected = await detectPlan($)
    await update($, plan, () => detected)
    await refreshUsage($)

    const home = await $.env.get('HOME')
    const session = home ? { id: await $.session.id(), cwd: e.cwd, startedAt: await $.clock.now(), home } : null
    let lastExport = 0
    const exportNow = async (now: number) => {
      if (!session) return
      lastExport = now
      dirty = false
      try {
        await exportSnapshot($, session)
      } catch (err) {
        $.ui.log(`progress-tracker: could not write the usage snapshot: ${String(err)}`)
      }
    }
    await exportNow(0)


    let seconds = 0
    // When everything was first seen finished; the band keeps it HIDE_AFTER_MS from then.
    let idleSince = 0
    $.clock.every(1000, async () => {
      seconds += 1
      const list = await read($, agents)
      const board = await read($, tasks)
      const now = await $.clock.now()
      const isRunning = list.some(a => a.status === 'running') || (board[MAIN] ?? []).some(t => t.status !== 'completed')
      if ((isRunning || dirty) && now - lastExport >= EXPORT_EVERY_MS) await exportNow(now)
      if (isRunning) {
        idleSince = 0
        if (seconds % 5 === 0) await refreshUsage($)
        await update($, tick, n => n + 1)
        return
      }
      // Idle: redraw once a minute so reset countdowns stay current.
      if (seconds % 60 === 0) await update($, tick, n => n + 1)
      const hasFinished = list.length > 0 || isFinished(board[MAIN])
      if (!hasFinished) return
      if (idleSince === 0) idleSince = Math.max(now, ...list.map(a => a.endedAt ?? 0))
      if (now - idleSince >= HIDE_AFTER_MS) {
        idleSince = 0
        await archive($, now)
      }
    })
    return next(e)
  })

  on('command.run', { command: 'tracker' }, async ($, e) => {
    const [sub, a1, a2] = e.args.trim().split(/\s+/)
    if (sub === 'history') {
      const opened = await openHistory($)
      return { text: opened.isPlaced ? 'Progress & usage opened.' : 'The terminal is too narrow for the pane.' }
    }
    if (sub === 'mode') {
      if (a1 !== 'api' && a1 !== 'subscription' && a1 !== 'auto') {
        return { text: `Mode is ${(await read($, settings)).mode}. Use: /tracker mode auto|api|subscription` }
      }
      await saveSettings($, s => ({ ...s, mode: a1 }))
      return { text: `Tracker mode: ${a1}.` }
    }
    if (sub === 'budget') {
      const usd = parseUsd(a2)
      if ((a1 !== 'day' && a1 !== 'month') || usd === undefined) return { text: 'Use: /tracker budget day 10  or  /tracker budget month 200' }
      await saveSettings($, s => (a1 === 'day' ? { ...s, budgetDay: usd } : { ...s, budgetMonth: usd }))
      return { text: `${a1 === 'day' ? 'Daily' : 'Monthly'} budget: ${money(usd)}.` }
    }
    if (sub === 'plan') {
      const usd = parseUsd(a1)
      if (a1 === 'auto') {
        await saveSettings($, s => ({ ...s, planUsd: undefined }))
        return { text: 'Subscription price: detected from your plan.' }
      }
      if (usd === undefined) return { text: 'Use: /tracker plan 25  (your price per month in $)  or  /tracker plan auto' }
      await saveSettings($, s => ({ ...s, planUsd: usd }))
      return { text: `Subscription price: ${money(usd)}/month.` }
    }
    if (sub === 'help') return { text: HELP }
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? 'Tracker hidden.' : 'Tracker shown.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e.resume ? e : { ...e, prompt: e.prompt + SUBAGENT_HINT })
    if (started.deny !== undefined || !started.agentId) return started
    const agent: Subagent = {
      id: started.agentId,
      description: e.description || e.subagentType,
      type: e.subagentType,
      model: started.model,
      startedAt: await $.clock.now(),
      status: 'running',
      tools: 0,
      tokens: emptyTokens(),
    }
    await update($, agents, list => [...list.filter(a => a.id !== agent.id), agent].slice(-20))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const used = e.usage
    if (e.agentId) {
      const id = e.agentId
      const now = await $.clock.now()
      const status = e.reason === 'answer' ? 'done' : 'failed'
      await update($, agents, list =>
        list.map(a =>
          a.id === id
            ? {
                ...a,
                tokens: used ? addTokens(a.tokens, used) : a.tokens,
                ...(a.status === 'running' ? { status, endedAt: now } : {}),
              }
            : a,
        ),
      )
    } else if (used) {
      await update($, mainTokens, t => addTokens(t, used))
    }
    if (used) await update($, modelTokens, m => ({ ...m, [used.model]: addTokens(m[used.model] ?? emptyTokens(), used) }))
    await refreshUsage($)
    dirty = true
    return next(e)
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; step?: string; agentId?: string }
    const total = Math.max(1, Math.floor(Number(input.total) || 1))
    const done = Math.min(total, Math.max(0, Math.floor(Number(input.done) || 0)))
    const step = typeof input.step === 'string' ? input.step.slice(0, 80) : undefined
    if (input.agentId) {
      const id = input.agentId
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, reported: { done, total, step } } : a)))
    }
    return { result: `Progress recorded: ${done}/${total}.` }
  })

  on('tool.call', async ($, e, next) => {
    const loop = e.agentId ?? MAIN

    if (e.agentId) {
      const id = e.agentId
      const tool = e.tool
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, tools: a.tools + 1, lastTool: tool } : a)))
    }

    if (e.tool === 'TodoWrite') {
      const todos = e.todos
      await update($, tasks, board =>
        setTasks(board, loop, () =>
          todos.map((t, i) => ({ id: String(i), subject: t.content, status: t.status, activeForm: t.activeForm })),
        ),
      )
      return next(e)
    }

    if (e.tool === 'TaskCreate') {
      const { subject, activeForm } = e
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError && ran.result) {
        const id = ran.result.task.id
        await update($, tasks, board => setTasks(board, loop, list => [...list, { id, subject, activeForm, status: 'pending' }]))
      }
      return ran
    }

    if (e.tool === 'TaskUpdate') {
      const { taskId, status, subject, activeForm } = e
      const ran = await next(e)
      if (ran.deny === undefined && !ran.isError) {
        await update($, tasks, board =>
          setTasks(board, loop, list =>
            status === 'deleted'
              ? list.filter(t => t.id !== taskId)
              : list.map(t =>
                  t.id === taskId
                    ? {
                        ...t,
                        status: (status as TaskStatus | undefined) ?? t.status,
                        subject: subject ?? t.subject,
                        activeForm: activeForm ?? t.activeForm,
                      }
                    : t,
                ),
          ),
        )
      }
      return ran
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const board = await read($, tasks)
    const list = await read($, agents)
    const main = board[MAIN] ?? []
    await read($, tick)
    const s = await read($, settings)
    const u = await read($, usage)
    const detected = await read($, plan)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const frame = SPINNER[Math.floor(now / 1000) % SPINNER.length]
    const LABEL = 11

    // Usage line: always on, every figure named, wraps by itself on a narrow terminal.
    const sub = isSubscription(s, u)
    const segments: [string, JSX.Element][] = []
    const meter = (key: string, label: string, percent: number, after: string) =>
      segments.push([
        key,
        <Text>
          <Text bold color={ACCENT.brown}>{label} </Text>
          <Text color={levelColor(percent)}>{gauge(percent)}</Text>
          <Text> {Math.round(percent)}%</Text>
          {after ? <Text dimColor> · {after}</Text> : null}
        </Text>,
      ])
    segments.push([
      'plan',
      <Text>
        <Text bold color={ACCENT.brown}>Plan </Text>
        <Text color={sub ? ACCENT.suggestion : ACCENT.claude}>{sub ? detected?.name ?? 'Subscription' : 'API (pay per token)'}</Text>
      </Text>,
    ])
    if (sub) {
      for (const l of u.limits) {
        const name = l.kind === 'five_hour' ? '5-hour limit' : l.kind === 'seven_day' ? 'Weekly limit' : `${LIMIT_LABEL[l.kind] ?? l.kind} limit`
        const reset = l.resetsAt ? resetLabel(l.resetsAt, now) : ''
        meter(l.kind, name, l.percentUsed, reset ? `resets ${reset.replace(/\((.*)\)/, '(in $1)')}` : '')
      }
      if (u.limits.length === 0) segments.push(['nolimits', <Text dimColor>Limits: shown after the first reply</Text>])
    } else {
      const today = spentToday(s, now)
      const month = spentMonth(s, now)
      meter('day', "Today's spend", (today / s.budgetDay) * 100, `${money(today)} of ${money(s.budgetDay)} budget`)
      meter('month', "Month's spend", (month / s.budgetMonth) * 100, `${money(month)} of ${money(s.budgetMonth)} budget`)
    }
    if (u.contextPercent !== undefined) {
      const of = u.contextTokens !== undefined ? `${kTokens(u.contextTokens)} of ${kTokens(u.contextWindow ?? 0)} tokens` : ''
      meter('mem', 'Memory', u.contextPercent, of)
    }
    if (u.usd !== undefined) {
      segments.push([
        'cost',
        <Text>
          <Text bold color={ACCENT.brown}>{sub ? 'Cost ' : 'Session cost '}</Text>
          {money(u.usd)}
          {sub ? <Text dimColor> at API price</Text> : null}
        </Text>,
      ])
    }

    // The always-on bar: no heading of its own, last in the band so work rows sit above it.
    const usageLine = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} borderStyle="round" borderColor={ACCENT.brown} paddingX={1}>
        {segments.map(([key, el], i) => (
          <Box key={key} flexDirection="row">
            {i > 0 ? <Text dimColor>│ </Text> : null}
            {el}
          </Box>
        ))}
        <Button key="history" label="History" hotkey="h" onPress={() => void openHistory($)} />
      </Box>
    )

    if (main.length === 0 && list.length === 0) return usageLine

    const heading = (label: string) => (
      <Box width={LABEL} flexShrink={0}>
        <Text bold color={ACCENT.claude}>{label}</Text>
      </Box>
    )

    // Main task list.
    const mainDone = main.filter(t => t.status === 'completed').length
    const active = main.find(t => t.status === 'in_progress')
    const tasksRow =
      main.length > 0 ? (
        <Box flexDirection="row">
          {heading('Tasks')}
          <Text>
            <Text color={mainDone === main.length ? ACCENT.success : ACCENT.claude}>{bar(mainDone, main.length, 12)}</Text>
            <Text> {mainDone} of {main.length} done</Text>
            {active ? <Text dimColor> · now: {active.activeForm || active.subject}</Text> : null}
          </Text>
        </Box>
      ) : null

    // Subagents: a heading with counts, then one row each (or one summary row past FOLD_OVER).
    const running = list.filter(a => a.status === 'running')
    const failed = list.filter(a => a.status === 'failed').length
    const agentsDone = list.length - running.length - failed
    const counts = [
      running.length > 0 ? `${running.length} running` : '',
      agentsDone > 0 ? `${agentsDone} done` : '',
      failed > 0 ? `${failed} failed` : '',
    ].filter(Boolean)

    const row = (a: Subagent) => {
      const own = board[a.id] ?? []
      const progress = a.reported ?? (own.length > 0 ? { done: own.filter(t => t.status === 'completed').length, total: own.length } : undefined)
      const icon = a.status === 'running' ? frame : a.status === 'done' ? '✓' : '✗'
      const iconColor = a.status === 'running' ? ACCENT.claude : a.status === 'done' ? ACCENT.success : ACCENT.error
      const tok = totalTokens(a.tokens)
      const time = elapsed((a.endedAt ?? now) - a.startedAt)
      const nowDoing = a.status === 'running' ? a.reported?.step || (a.lastTool ? `using ${a.lastTool}` : '') : ''
      const facts = [
        nowDoing ? `now: ${nowDoing}` : '',
        a.status === 'running' ? `running ${time}` : a.status === 'done' ? `finished in ${time}` : `failed after ${time}`,
        `${a.tools} tool calls`,
        tok > 0 ? `${kTokens(tok)} tokens` : '',
      ].filter(Boolean)
      return (
        <Box key={a.id} flexDirection="row">
          <Box width={LABEL} flexShrink={0} />
          <Text>
            <Text color={iconColor}>{icon} </Text>
            <Text bold={a.status === 'running'} dimColor={a.status !== 'running'}>{a.description}</Text>
            <Text dimColor> ({a.type})</Text>
            {progress ? (
              <Text>
                <Text dimColor>  steps </Text>
                <Text color={progress.done === progress.total ? ACCENT.success : ACCENT.suggestion}>{bar(progress.done, progress.total, 8)}</Text>
                <Text> {progress.done}/{progress.total}</Text>
              </Text>
            ) : null}
            <Text dimColor>  {facts.join(' · ')}</Text>
          </Text>
        </Box>
      )
    }

    const subagents =
      list.length === 0 ? null : (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {heading('Subagents')}
            <Text>
              {list.length > FOLD_OVER ? (
                <Text>
                  <Text color={running.length === 0 ? ACCENT.success : ACCENT.suggestion}>{bar(list.length - running.length, list.length, 12)}</Text>{' '}
                </Text>
              ) : null}
              <Text>{counts.join(' · ')}</Text>
              {list.length > FOLD_OVER ? (
                <Text dimColor>
                  {' '}
                  · {list.reduce((n, a) => n + a.tools, 0)} tool calls · {kTokens(list.reduce((n, a) => n + totalTokens(a.tokens), 0))} tokens · details in History
                </Text>
              ) : null}
            </Text>
          </Box>
          {list.length > FOLD_OVER ? null : list.map(row)}
        </Box>
      )

    return (
      <Box flexDirection="column">
        {tasksRow}
        {subagents}
        {usageLine}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const past = await read($, history)
    const live = await read($, agents)
    const main = await read($, mainTokens)
    const s = await read($, settings)
    const u = await read($, usage)
    const detected = await read($, plan)
    await read($, tick)
    const now = await $.clock.now()
    const all = [...past.agents, ...live]
    const sub = isSubscription(s, u)
    const width = Math.max(30, (e.props.bodyColumns ?? 60) - 2)
    const barWidth = Math.min(28, Math.max(12, width - 34))

    const level = (percent: number) => (percent >= 90 ? ACCENT.error : percent >= 70 ? ACCENT.warning : ACCENT.claude)

    // Section headings, thin dividers and bars in the person's own Claude Code theme colors.
    const heading = (title: string, detail?: string) => (
      <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
        <Text color={'subtle'}>{title}</Text>
        {detail ? <Text color={'inactive'}>{detail}</Text> : null}
      </Box>
    )
    const divider = <Text color={'subtle'}>{'─'.repeat(width)}</Text>
    const thinBar = (percent: number, color: string) => {
      const filled = Math.min(barWidth, Math.max(0, Math.round((percent / 100) * barWidth)))
      return (
        <Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color={'subtle'}>{'━'.repeat(barWidth - filled)}</Text>
        </Text>
      )
    }
    const meter = (label: string, percent: number, detail: string) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={'text'}>{label}</Text>
          <Text color={level(percent)} bold>
            {Math.round(percent)}%
          </Text>
        </Box>
        {thinBar(percent, level(percent))}
        {detail ? <Text color={'inactive'}>{detail}</Text> : null}
      </Box>
    )
    const fact = (label: string, value: string, note?: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={'inactive'}>{label}</Text>
        <Text color={'text'}>
          {value}
          {note ? <Text color={'inactive'}> {note}</Text> : null}
        </Text>
      </Box>
    )

    // API vs subscription, from the API-price ledger of every session with the mod on.
    const today = spentToday(s, now)
    const month = spentMonth(s, now)
    const d = new Date(now)
    const daysIn = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    const projected = (month / d.getDate()) * daysIn
    const planUsd = s.planUsd ?? detected?.listUsd
    const planSource = s.planUsd !== undefined ? 'set by you' : 'list price'
    const isSubCheaper = planUsd !== undefined && projected > planUsd
    const verdict =
      planUsd === undefined
        ? 'Your plan has no list price. Set it with /tracker plan <$/month>.'
        : isSubCheaper
          ? `Subscription is cheaper by ~${money(projected - planUsd)} this month`
          : `API would be cheaper by ~${money(planUsd - projected)} this month`

    const sumTok = totalTokens(main) + all.reduce((n, a) => n + totalTokens(a.tokens), 0)
    const sumTools = all.reduce((n, a) => n + a.tools, 0)

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* Plan. */}
        <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
          <Text>
            <Text color={ACCENT.claude} bold>
              {' '}
              {sub ? '◆' : '$'}{' '}
            </Text>
            <Text color={'text'} bold>
              {' '}
              {sub ? detected?.name ?? 'Subscription' : 'API (pay per token)'}
            </Text>
          </Text>
          <Text color={'inactive'}>mode {s.mode}</Text>
        </Box>
        {detected?.extraUsage ? <Text color={'inactive'}>Extra usage on · past your limits you pay API price</Text> : null}

        {heading('Usage')}
        {u.limits.map(l =>
          meter(
            l.kind === 'five_hour' ? '5-hour limit' : l.kind === 'seven_day' ? 'Weekly limit' : `${LIMIT_LABEL[l.kind] ?? l.kind} limit`,
            l.percentUsed,
            l.resetsAt ? `resets ${resetLabel(l.resetsAt, now).replace(/\((.*)\)/, '· in $1')}` : '',
          ),
        )}
        {sub ? null : meter("Today's spend", (today / s.budgetDay) * 100, `${money(today)} of ${money(s.budgetDay)} budget`)}
        {sub ? null : meter("Month's spend", (month / s.budgetMonth) * 100, `${money(month)} of ${money(s.budgetMonth)} budget`)}
        {u.contextPercent !== undefined
          ? meter('Memory', u.contextPercent, `${kTokens(u.contextTokens ?? 0)} of ${kTokens(u.contextWindow ?? 0)} tokens · compacts near 100%`)
          : null}
        <Text color={'inactive'}>Memory is how much of this conversation Claude holds right now.</Text>
        {divider}

        {heading('Cost', 'at API price')}
        {fact('This session', u.usd !== undefined ? money(u.usd) : '–')}
        {fact('Today', money(today))}
        {fact('This month', money(month))}
        {fact('Month projected', money(projected))}
        {planUsd !== undefined ? fact('Your plan', `${money(planUsd)}/month`, `(${planSource})`) : null}
        {s.planUsd === undefined && detected?.annualUsd !== undefined ? fact('Billed annually', `${money(detected.annualUsd)}/month`) : null}
        <Box marginTop={1}>
          <Text color={planUsd === undefined ? 'inactive' : isSubCheaper ? ACCENT.claude : ACCENT.warning}>● {verdict}</Text>
        </Box>
        <Text color={'inactive'}>Counts Claude Code sessions with this tracker on; list prices.</Text>
        {divider}

        {heading('Subagents', all.length > 0 ? `${all.length}` : undefined)}
        {all.length === 0 ? (
          <Text color={'inactive'}>No subagents yet. They show up here when Claude starts one.</Text>
        ) : (
          all
            .slice()
            .reverse()
            .map(a => {
              const usd = agentUsd(a, all, main, u)
              const icon = a.status === 'running' ? '◌' : a.status === 'done' ? '✓' : '✗'
              const color = a.status === 'failed' ? ACCENT.error : a.status === 'done' ? ACCENT.claude : ACCENT.warning
              const steps = a.reported ? `${a.reported.done}/${a.reported.total} steps · ` : ''
              return (
                <Box key={a.id} flexDirection="column" marginBottom={1}>
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text>
                      <Text color={color}>{icon} </Text>
                      <Text color={'text'}>{a.description}</Text>
                    </Text>
                    <Text color={'inactive'}>
                      {hhmm(new Date(a.startedAt))} · {elapsed((a.endedAt ?? now) - a.startedAt)}
                    </Text>
                  </Box>
                  <Text color={'inactive'}>
                    {'  '}
                    {a.type} · {steps}
                    {a.tools} tool calls · {kTokens(totalTokens(a.tokens))} tokens
                    {usd !== undefined ? ` · ~${money(usd)}` : ''}
                  </Text>
                </Box>
              )
            })
        )}
        {divider}

        {heading('Finished task lists', past.lists.length > 0 ? `${past.lists.length}` : undefined)}
        {past.lists.length === 0 ? (
          <Text color={'inactive'}>None yet.</Text>
        ) : (
          past.lists
            .slice()
            .reverse()
            .map(l => (
              <Box flexDirection="column" marginBottom={1}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Text>
                    <Text color={ACCENT.claude}>✓ </Text>
                    <Text color={'text'}>
                      {l.done} of {l.total} done
                    </Text>
                  </Text>
                  <Text color={'inactive'}>{hhmm(new Date(l.at))}</Text>
                </Box>
                <Text color={'inactive'}>
                  {'  '}
                  {l.subjects.join(' · ').slice(0, width - 2)}
                </Text>
              </Box>
            ))
        )}
        {divider}

        {/* Footer. */}
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={'inactive'}>
            ⚙ {all.length} subagents · {sumTools} tool calls · {kTokens(sumTok)} tokens
          </Text>
          <Text color={'inactive'}>/tracker help</Text>
        </Box>
      </Box>
    )
  })
}
