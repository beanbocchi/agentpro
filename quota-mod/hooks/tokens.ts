import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Pool, Tokens } from '../types'
import { readSetup } from './setup'

// The quota server caches its report for 60 seconds.
const POLL_MS = 60_000

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
const session = atom({ plugin: 'claudepro-quota', key: 'session' } as const, ZERO, { shape: 'tokens-1' })
const today = atom({ plugin: 'claudepro-quota', key: 'today' } as const, ZERO, { shape: 'tokens-1' })
const pools = atom({ plugin: 'claudepro-quota', key: 'pools' } as const, [] as Pool[], { shape: 'pools-1' })

type Window = { name: string; used: number }
type Account = { provider: string; health: string; windows: Window[] }
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const GONE = new Set(['dead', 'disabled', 'unavailable'])

let lastPoll = 0

function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `tokens-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function add(t: Tokens, u: Usage): Tokens {
  return {
    input: t.input + u.input_tokens,
    output: t.output + u.output_tokens,
    cacheRead: t.cacheRead + u.cache_read_input_tokens,
    cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
    requests: t.requests + 1,
  }
}

function total(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

// An account that is dead, disabled or reports no windows counts for nothing.
// A live one counts what its tightest window has left: the 5-hour, the weekly,
// or a model's own weekly limit.
export function sumPools(accounts: Account[]): Pool[] {
  const by = new Map<string, Pool>()
  for (const a of accounts) {
    const pool = by.get(a.provider) ?? { provider: a.provider, live: 0, left: 0 }
    by.set(a.provider, pool)
    if (GONE.has(a.health) || a.windows.length === 0) continue
    pool.live++
    pool.left += Math.min(...a.windows.map(w => Math.max(0, 100 - w.used) / 100))
  }
  return [...by.values()].sort((x, y) => x.provider.localeCompare(y.provider))
}

export function hint(s: Tokens, d: Tokens, ps: Pool[]): string {
  const parts = [`${fmt(total(s))} tok · today ${fmt(total(d))}`]
  for (const p of ps) parts.push(`${p.provider} ${meter(p.left, p.live)} ${p.left.toFixed(1)}/${p.live}`)
  return parts.join(' │ ')
}

function meter(part: number, whole: number, cells = 6): string {
  const full = whole > 0 ? Math.round((Math.min(part, whole) / whole) * cells) : 0
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

async function poll($: EngineInterface) {
  lastPoll = await $.clock.now()
  // Other sessions on this machine add to the same day's total.
  const stored = (await $.store.get(dayKey(lastPoll))) as Tokens | undefined
  if (stored) await update($, today, () => stored)
  const s = await readSetup($)
  if (typeof s === 'string') return
  try {
    const res = await $.http.fetch(`${s.base}/quota.json`, { headers: { Authorization: `Bearer ${s.key}` } })
    if (!res.ok) return
    const data = JSON.parse(res.text) as { accounts: Account[] }
    await update($, pools, () => sumPools(data.accounts))
  } catch {
    // The line keeps the last figures until the server answers again.
  }
}

// Called from the module's session.start hook.
export function startPolling($: EngineInterface) {
  void poll($)
  $.clock.every(POLL_MS, () => void poll($))
}

export function tokens(on: On) {
  // Each model request, the main thread's and the subagents', as the API counted it.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage) {
      await update($, session, t => add(t, usage))
      const key = dayKey(await $.clock.now())
      const day = add(((await $.store.get(key)) as Tokens | undefined) ?? ZERO, usage)
      await $.store.set(key, day)
      await update($, today, () => day)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if ((await $.clock.now()) - lastPoll > 15_000) void poll($)
    return r
  })

  // The dim hint line under the prompt carries the figures at its end.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const mine = hint(await read($, session), await read($, today), await read($, pools))
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${mine}` : mine } })
  })
}
