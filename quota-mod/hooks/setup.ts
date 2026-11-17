import type { EngineInterface } from 'claude-code'

// quota.json, beside .claude-plugin/, is written by the claudepro installer:
// { "url": "http://host:8318/quota", "keyFile": "<absolute path of the API key>" }
type Setup = { url: string; keyFile: string }

export async function readSetup($: EngineInterface): Promise<{ base: string; key: string } | string> {
  try {
    const s: Setup = JSON.parse(await $.fs.read(`${$.plugin.root}/quota.json`))
    const key = (await $.fs.read(s.keyFile)).trim()
    return { base: s.url.replace(/\/quota$/, ''), key }
  } catch (error) {
    return `cannot read the claudepro setup (${String(error)}); run the claudepro installer again`
  }
}
