import { readFileSync } from 'fs'

export type SDKBridge = { enabled?: boolean; proxy: string; prefix: string; threads?: string[]; models: Record<string, string>; env: Record<string, string> }

export function bridgeFile(app: string, thread: string): string | undefined {
  const file = process.env.HEX_AGENT_SDK
  if (!file || app !== 'telegram') return
  const config: SDKBridge = JSON.parse(readFileSync(file, 'utf8'))
  return config.enabled !== false && (!config.threads || config.threads.includes(thread)) ? file : undefined
}

export async function runtime(config: SDKBridge): Promise<'sdk' | 'interactive'> {
  const key = config.env.ANTHROPIC_API_KEY
  if (!key || !config.prefix) throw new Error('SDK bridge needs an explicit API key and model prefix')
  const url = new URL('/v1/claude/runtime', config.proxy)
  url.searchParams.set('prefix', config.prefix)
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`SDK bridge routing failed: HTTP ${response.status}`)
  const decision = await response.json() as { runtime: string }
  if (decision.runtime !== 'sdk' && decision.runtime !== 'interactive') throw new Error('SDK bridge got an invalid runtime decision')
  return decision.runtime
}
