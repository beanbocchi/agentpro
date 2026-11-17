import type { EngineInterface, Register } from 'claude-code'

import { readSetup } from './setup'
import { startPolling, tokens } from './tokens'

// Under claudepro, Claude Code signs in to the proxy with a gateway key. /login
// would put a personal login in its place, and /logout can revoke the token of
// an account the proxy shares. Both are hidden from the menu; typed, /login
// prints the /contribute steps and /logout says there is nothing to log out of.
const REPLACED = ['login', 'logout']

async function post($: EngineInterface, path: string, body: object): Promise<{ error?: string; [k: string]: unknown }> {
  const s = await readSetup($)
  if (typeof s === 'string') return { error: s }
  try {
    const res = await $.http.fetch(`${s.base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    try {
      return JSON.parse(res.text)
    } catch {
      return { error: `the server answered HTTP ${res.status}: ${res.text}` }
    }
  } catch (error) {
    return { error: `cannot reach ${s.base} (${String(error)})` }
  }
}

export const register: Register = on => {
  tokens(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quota',
      description: "Plan limits of the claudepro server's accounts",
      immediate: true,
    })
    await $.command.register({
      name: 'contribute',
      description: 'Log in to a Claude or ChatGPT account and add it to the claudepro proxy',
      argumentHint: '[claude|codex] | <address the browser landed on>',
    })
    startPolling($)
    return next(e)
  })

  on('command.describe', ($, e, next) => (REPLACED.includes(e.command) ? next({ ...e, isHidden: true }) : next(e)))

  on('command.run', async ($, e, next) => {
    if (e.command === 'logout') {
      return { text: "There is nothing to log out of: this session signs in with the claudepro server's key, not with an account of yours." }
    }
    if (e.command !== 'login') return next(e)
    return {
      text: [
        '/login is turned off under claudepro. To add an account to the proxy, use /contribute:',
        '1. Run /contribute for a Claude account, or /contribute codex for a ChatGPT account.',
        '2. Open the address it prints and log in with that account.',
        '3. The browser then shows a connection error on a localhost page. Copy that page\'s address.',
        '4. Run /contribute <that address>.',
      ].join('\n'),
    }
  })

  on('command.run', { command: 'quota' }, async $ => {
    const s = await readSetup($)
    if (typeof s === 'string') return { text: `quota: ${s}` }
    const url = `${s.base}/quota`
    try {
      const res = await $.http.fetch(url, { headers: { Authorization: `Bearer ${s.key}` } })
      return { text: res.ok ? res.text : `quota: the server answered HTTP ${res.status}: ${res.text}` }
    } catch (error) {
      return { text: `quota: cannot reach ${url} (${String(error)})` }
    }
  })

  on('command.run', { command: 'contribute' }, async ($, e) => {
    const arg = e.args.trim()
    if (/^https?:\/\//.test(arg)) {
      const out = await post($, '/contribute/finish', { redirect_url: arg })
      if (out.error) return { text: `contribute: ${out.error}` }
      const accounts = (out.accounts as string[] | undefined) ?? []
      return {
        text: accounts.length
          ? `Added ${accounts.join(', ')} to the claudepro proxy. /quota lists it within a minute.`
          : 'The proxy took the login, but no account file changed. /quota shows the accounts it has.',
      }
    }
    const provider = arg === '' ? 'claude' : arg.toLowerCase()
    if (provider !== 'claude' && provider !== 'codex') {
      return { text: 'usage: /contribute [claude|codex], then /contribute <address the browser landed on>' }
    }
    const out = await post($, '/contribute/start', { provider })
    if (out.error) return { text: `contribute: ${out.error}` }
    const url = String(out.url)
    const copied = await $.ui.copy({ text: url }).catch(() => ({ isCopied: false }))
    const port = provider === 'claude' ? '54545' : '1455'
    return {
      text: [
        `1. Open this address in a browser${copied.isCopied ? ' (it is on the clipboard)' : ''}:`,
        `   ${url}`,
        `2. Log in with the ${provider === 'claude' ? 'Claude' : 'ChatGPT'} account you are adding.`,
        `3. The browser then goes to localhost:${port} and shows a connection error. Copy that page's address.`,
        '4. Run /contribute <that address> within 15 minutes.',
      ].join('\n'),
    }
  })
}
