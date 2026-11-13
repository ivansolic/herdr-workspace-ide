export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = { id: string; subject: string; status: TaskStatus; activeForm?: string }

// Tasks per loop: 'main' for the main conversation, else the subagent's id.
export type TaskBoard = Record<string, Task[]>

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

// What a subagent reported through the mod's progress tool.
export type Reported = { done: number; total: number; step?: string }

export type Subagent = {
  id: string
  description: string
  type: string
  model: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'failed'
  tools: number
  lastTool?: string
  reported?: Reported
  tokens: Tokens
}

// Tokens per model id, main loop and subagents together.
export type ModelTokens = Record<string, Tokens>

export type FinishedList = { at: number; done: number; total: number; subjects: string[] }

export type History = { agents: Subagent[]; lists: FinishedList[] }

export type Mode = 'auto' | 'api' | 'subscription'

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  usd?: number
  contextPercent?: number
  contextTokens?: number
  contextWindow?: number
  limits: Limit[]
}

// Settings and spending kept across sessions in $.store, mirrored here so drawings redraw.
export type Settings = {
  mode: Mode
  budgetDay: number
  budgetMonth: number
  // Monthly subscription price, for the API vs subscription comparison; unset until given.
  planUsd?: number
  // API-price spending per local day (YYYY-MM-DD), every session with the mod on.
  days: Record<string, number>
}

// The plan read from the login in ~/.claude.json; only these fields are kept, never the email or name.
export type Plan = {
  name: string
  // List price per seat per month billed monthly, and billed annually; absent where it is by contract.
  listUsd?: number
  annualUsd?: number
  extraUsage: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'progress-tracker': {
      tasks: TaskBoard
      agents: Subagent[]
      history: History
      mainTokens: Tokens
      modelTokens: ModelTokens
      usage: Usage
      settings: Settings
      plan: Plan | null
      // Session cost already added to the day ledger, and warnings already shown.
      counted: number
      warned: string[]
      isHidden: boolean
      isComposing: boolean
      tick: number
    }
  }
}
