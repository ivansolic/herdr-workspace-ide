import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'progress-tracker',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, scroll: { offset: 0, bodyRows: 10 } },
} as const

test('tasks and a subagent show with progress bars', async ($, on) => {
  on('tool.call', (_, e) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: e.subject === 'A' ? '1' : '2', subject: e.subject } } } : { result: {} },
  )
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'sub1' }))
  on('clock.now', () => ({ value: 1000 }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'A', description: 'a' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'B', description: 'b' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Doing B' })

  await $.agent.spawn({ prompt: 'look', description: 'Find auth code', subagentType: 'Explore' })
  await $.tool.call({ tool: 'TodoWrite', agentId: 'sub1', todos: [
    { content: 'x', status: 'completed', activeForm: 'x' },
    { content: 'y', status: 'pending', activeForm: 'y' },
  ] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const tasksRow = await ui.find({ type: 'Text', text: /of 2 done/ })
    expect(tasksRow?.text).toContain('1 of 2 done')
    expect(tasksRow?.text).toContain('now: Doing B')
    expect((await ui.find({ type: 'Text', text: /^Subagents$/ }))?.text).toBe('Subagents')
    const agentRow = await ui.find({ type: 'Text', text: /Find auth code/ })
    expect(agentRow?.text).toContain('Explore')
    expect(agentRow?.text).toContain('1/2')
    expect(agentRow?.text).toContain('steps')
    expect(agentRow?.text).toContain('1 tool calls')
    await ui.unmount()
  }
})

test('with nothing running only the usage line shows', async ($, on) => {
  on('clock.now', () => ({ value: 1000 }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Usage$/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /API \(pay per token\)/ }))?.text).toBe('Plan API (pay per token)')
  expect(await ui.find({ type: 'Button', key: 'history' })).toBeTruthy()
  await ui.unmount()
})

test('a subscription shows limits with resets, memory and the pane compares', async ($, on) => {
  const now = Date.parse('2026-11-12T10:00:00')
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('command.register', () => ({ value: { command: 'tracker' } }))
  on('tool.register', () => ({ value: {} }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('fs.read', () => ({
    value: JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z', organizationType: 'claude_team', seatTier: 'team_standard', hasExtraUsageEnabled: true } }),
  }))
  on('session.usage', () => ({
    value: {
      startedAt: now,
      context: { tokens: 82000, window: 200000, percent: 41 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 52, resetsAt: '2026-11-12T12:10:00' },
        { kind: 'seven_day', percentUsed: 18, resetsAt: '2026-11-16T09:00:00' },
      ],
      cost: { usd: 0.84 },
      changed: ['context'],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /^Plan / }))?.text).toBe('Plan Team · Standard seat')
  const five = await band.find({ type: 'Text', text: /^5-hour limit / })
  expect(five?.text).toContain('52%')
  expect(five?.text).toContain('resets 12:10 (in 2h10m)')
  expect((await band.find({ type: 'Text', text: /^Weekly limit / }))?.text).toContain('resets Mon 09:00')
  expect((await band.find({ type: 'Text', text: /^Memory / }))?.text).toContain('82k of 200k tokens')
  expect((await band.find({ type: 'Text', text: /at API price/ }))?.text).toContain('$0.84')
  await band.unmount()

  const pane = await $.ui.mount({
    plugin: 'progress-tracker',
    component: 'Pane',
    requestId: 'progress-history',
    surface: 'terminal',
    props: { title: 'Progress & usage', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect((await pane.find({ type: 'Text', text: /resets 12:10/ }))?.text).toBe('resets 12:10 · in 2h10m')
  expect(await pane.find({ type: 'Text', text: /Team · Standard seat/ })).toBeTruthy()
  expect((await pane.find({ type: 'Text', text: /^Your plan$/ }))?.text).toBe('Your plan')
  expect(await pane.find({ type: 'Text', text: /Extra usage on/ })).toBeTruthy()
  await pane.unmount()
})


test('the band steps aside while a slash command or a mention is typed', async ($, on) => {
  on('clock.now', () => ({ value: 1000 }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  const shown = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const found = await ui.find({ type: 'Button', key: 'history' })
    await ui.unmount()
    return Boolean(found)
  }
  expect(await shown()).toBe(true)
  await $.prompt.change({ text: '/compa', cursor: 6, origin: { kind: 'edit' } })
  expect(await shown()).toBe(false)
  await $.prompt.change({ text: 'look at @src/ma', cursor: 15, origin: { kind: 'edit' } })
  expect(await shown()).toBe(false)
  await $.prompt.change({ text: 'look at @src/main.ts and fix it', cursor: 31, origin: { kind: 'edit' } })
  expect(await shown()).toBe(true)
})
