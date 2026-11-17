import { expect, test } from 'claude-code/testing'

const SETUP = JSON.stringify({ url: 'http://quota.test:8318/quota', keyFile: '/keys/claudepro.key' })

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

function fakeFiles(on: On, files: Record<string, string>) {
  on('fs.read', ($, e) => {
    const hit = Object.entries(files).find(([suffix]) => e.path.endsWith(suffix))
    if (!hit) throw new Error(`ENOENT: ${e.path}`)
    return { value: hit[1] }
  })
}

test('/quota prints the server table, sending the key from keyFile', async ($, on) => {
  fakeFiles(on, { '/quota.json': SETUP, '/keys/claudepro.key': 'sk-test\n' })
  const seen: { url: string; auth?: string }[] = []
  on('http.fetch', ($, e) => {
    seen.push({ url: e.url, auth: e.init?.headers?.Authorization })
    return { value: { status: 200, ok: true, headers: {}, text: 'Quota on test\nClaude  a@b  5-hour 10%' } }
  })
  const { text } = await $.command.run({ command: 'quota' } as never)
  expect(text).toBe('Quota on test\nClaude  a@b  5-hour 10%')
  expect(seen).toEqual([{ url: 'http://quota.test:8318/quota', auth: 'Bearer sk-test' }])
})

test('/quota shows the HTTP status when the server refuses the key', async ($, on) => {
  fakeFiles(on, { '/quota.json': SETUP, '/keys/claudepro.key': 'sk-old' })
  on('http.fetch', () => ({ value: { status: 401, ok: false, headers: {}, text: 'invalid key' } }))
  const { text } = await $.command.run({ command: 'quota' } as never)
  expect(text).toBe('quota: the server answered HTTP 401: invalid key')
})

test('/quota says to rerun the installer when quota.json is missing', async ($, on) => {
  fakeFiles(on, {})
  const { text } = await $.command.run({ command: 'quota' } as never)
  expect(text).toMatch(/^quota: cannot read the claudepro setup .*run the claudepro installer again$/)
})

test('/quota names the URL when the server is unreachable', async ($, on) => {
  fakeFiles(on, { '/quota.json': SETUP, '/keys/claudepro.key': 'sk-test' })
  on('http.fetch', () => ({ deny: 'connect ETIMEDOUT' }))
  const { text } = await $.command.run({ command: 'quota' } as never)
  expect(text).toMatch(/^quota: cannot reach http:\/\/quota\.test:8318\/quota \(/)
})

test('/contribute starts a login and puts its address on the clipboard', async ($, on) => {
  fakeFiles(on, { '/quota.json': SETUP, '/keys/claudepro.key': 'sk-test' })
  const seen: { url: string; body?: unknown }[] = []
  on('http.fetch', ($, e) => {
    seen.push({ url: e.url, body: JSON.parse(String(e.init?.body)) })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ provider: 'claude', url: 'https://claude.ai/oauth/authorize?state=s1', state: 's1' }) } }
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  const { text } = await $.command.run({ command: 'contribute', args: '' } as never)
  expect(seen).toEqual([{ url: 'http://quota.test:8318/contribute/start', body: { provider: 'claude' } }])
  expect(text).toContain('https://claude.ai/oauth/authorize?state=s1')
  expect(text).toContain('(it is on the clipboard)')
  expect(text).toContain('localhost:54545')
})

test('/contribute <address> finishes the login', async ($, on) => {
  fakeFiles(on, { '/quota.json': SETUP, '/keys/claudepro.key': 'sk-test' })
  const seen: unknown[] = []
  on('http.fetch', ($, e) => {
    seen.push(JSON.parse(String(e.init?.body)))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ status: 'ok', provider: 'claude', accounts: ['new@x.y'] }) } }
  })
  const address = 'http://localhost:54545/callback?code=abc&state=s1'
  const { text } = await $.command.run({ command: 'contribute', args: address } as never)
  expect(seen).toEqual([{ redirect_url: address }])
  expect(text).toBe('Added new@x.y to the claudepro proxy. /quota lists it within a minute.')
})

test('/contribute shows what the server refused', async ($, on) => {
  fakeFiles(on, { '/quota.json': SETUP, '/keys/claudepro.key': 'sk-test' })
  on('http.fetch', () => ({ value: { status: 400, ok: false, headers: {}, text: JSON.stringify({ error: 'paste the whole address' }) } }))
  const { text } = await $.command.run({ command: 'contribute', args: 'http://localhost:54545/callback' } as never)
  expect(text).toBe('contribute: paste the whole address')
})

test('/login and /logout are hidden; /login shows the /contribute steps', async ($, on) => {
  on('command.describe', (_, e) => ({ description: e.description, isHidden: e.isHidden }))
  for (const command of ['login', 'logout']) {
    const listed = await $.command.describe({ command, description: 'x', isHidden: false, immediate: false, provider: { plugin: 'engine', tier: 'core' } } as never)
    expect(listed.isHidden).toBe(true)
  }
  expect((await $.command.run({ command: 'login', args: '' } as never)).text).toContain('Run /contribute <that address>.')
  expect((await $.command.run({ command: 'logout', args: '' } as never)).text).toContain('nothing to log out of')
  const other = await $.command.describe({ command: 'help', description: 'x', isHidden: false, immediate: false, provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(other.isHidden).toBe(false)
})
