import { expect, test } from 'claude-code/testing'

import { hint, sumPools } from '../hooks/tokens'

declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

const QUOTA = {
  accounts: [
    { provider: 'claude', health: 'ok', windows: [{ name: '5-hour', used: 20 }, { name: 'weekly', used: 90 }] },
    { provider: 'claude', health: 'ok', windows: [{ name: '5-hour', used: 50 }, { name: 'weekly', used: 10 }] },
    { provider: 'claude', health: 'dead', windows: [] },
    { provider: 'codex', health: 'limit reached', windows: [{ name: '5-hour', used: 100 }, { name: 'weekly', used: 40 }] },
  ],
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }

test('each live account counts what its tightest window has left', () => {
  // 0.10 (weekly is tighter) + 0.50 (5-hour is tighter); the dead account counts for nothing.
  expect(sumPools(QUOTA.accounts)).toEqual([
    { provider: 'claude', live: 2, left: 0.6 },
    { provider: 'codex', live: 1, left: 0 },
  ])
})

test('the line formats tokens and a meter per provider', () => {
  const s = { input: 1200, output: 34_000, cacheRead: 1_200_000, cacheWrite: 0, requests: 3 }
  expect(hint(s, ZERO, [{ provider: 'claude', live: 3, left: 1.5 }])).toBe('1.24M tok · today 0 │ claude ▰▰▰▱▱▱ 1.5/3')
})

test('the hint line under the prompt carries the figures', async ($, on) => {
  on('clock.now', () => ({ value: 1794925001000 }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('quota.json') ? JSON.stringify({ url: 'http://x:8318/quota', keyFile: '/k' }) : 'key' }))
  on('http.fetch', (_, e) => {
    expect(e.url).toBe('http://x:8318/quota.json')
    return { value: { ok: true, status: 200, text: JSON.stringify(QUOTA), headers: {} } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let tail: string | undefined
  on('ui.render', ($, e) => {
    tail = (e.props as { tail?: string }).tail
    const { Text } = $.ui.resolve(e)
    return <Text>hint</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))
  const ui = await $.ui.mount({ plugin: 'claudepro-quota', component: 'PromptHint', surface: 'terminal', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })
  expect(tail).toBe('0 tok · today 0 │ claude ▰▰▱▱▱▱ 0.6/2 │ codex ▱▱▱▱▱▱ 0.0/1')
  await ui.unmount()
})
