export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }

// One provider's accounts: `left` sums what each live account has left in its
// tightest window, in accounts (1 = one account's full window).
export type Pool = { provider: string; live: number; left: number }

declare module 'claude-code' {
  interface PluginState {
    'claudepro-quota': {
      session: Shaped<Tokens>
      today: Shaped<Tokens>
      pools: Shaped<Pool[]>
    }
  }
}
