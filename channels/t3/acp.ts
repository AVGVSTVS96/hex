#!/usr/bin/env bun
import { connect, type Socket } from 'net'
import { createInterface } from 'readline'

// T3 Code starts this as its ACP agent; the agent itself runs in the hub service. A hub restart
// closes the socket, which T3 would take as its agent dying, so this connects again and opens the
// new hub the way T3 opened the old one: initialize, then each session T3 started or resumed, with
// what T3 picked for it. Every request T3 still waits on is asked again; a prompt asks its thread to
// rejoin the turn (bot.ts), which streams it again from when T3 sent it, and the updates T3 already
// has are dropped.
const path = process.argv[2]
if (!path) {
  process.stderr.write('usage: acp.ts <path to the t3 hub acp.sock>\n')
  process.exit(2)
}

// Longer than any hub restart, which reinstalls the channels' packages before it starts again.
const DOWN = 120_000
// Ids of the requests this sends itself, whose answers T3 never asked for.
const OWN = 'hex-acp:'

type Request = { jsonrpc: '2.0'; id: string | number; method: string; params: any }
type Waiting = { line: string; request: Request; at: number }
type Counts = Map<number | bigint, number>

let socket: Socket | undefined
let ending = false
let downSince = 0
let initialize: unknown
const held: string[] = []
const sessions = new Map<string, { cwd: string; mcpServers: unknown[] }>()
// What T3 picked in each session: a thread hex hasn't kept yet loses it with the old hub.
const picked = new Map<string, Map<string, unknown>>()
const waiting = new Map<string | number, Waiting>()
// Each update T3 has been shown of a turn it waits on, and what a rejoined turn still has to skip.
const shown = new Map<string, Counts>()
const skip = new Map<string, Counts>()

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', fromT3)
  .on('close', () => {
    ending = true
    if (socket) socket.end()
    else process.exit(0)
  })
reach()

function reach(again = false) {
  const next = connect(path)
  next.on('connect', () => {
    socket = next
    createInterface({ input: next, crlfDelay: Infinity }).on('line', fromHex)
    if (again) reopen(next)
    for (const line of held.splice(0)) fromT3(line)
  })
  next.on('error', error => {
    if (again) return
    process.stderr.write(`hex acp: can't reach hex at ${path} (${error.message}). Is hex running?\n`)
    process.exit(1)
  })
  next.on('close', () => {
    if (ending) process.exit(0)
    if (socket === next) {
      socket = undefined
      downSince = Date.now()
    } else if (!again) return
    if (Date.now() - downSince > DOWN) {
      process.stderr.write(`hex acp: hex at ${path} has been gone for ${DOWN / 1000}s\n`)
      process.exit(1)
    }
    setTimeout(reach, 250, true)
  })
}

function fromT3(line: string) {
  if (!socket) return void held.push(line)
  const message = parse(line)
  if (message?.method && message.id != null) {
    const { method, params } = message
    waiting.set(message.id, { line, request: message, at: Date.now() })
    if (method === 'initialize') initialize = params
    if (method === 'session/resume' || method === 'session/load') sessions.set(params.sessionId, { cwd: params.cwd, mcpServers: params.mcpServers })
    if (method === 'session/prompt') shown.set(params.sessionId, new Map())
  }
  socket.write(`${line}\n`)
}

function fromHex(line: string) {
  const message = parse(line)
  if (typeof message?.id === 'string' && message.id.startsWith(OWN)) return
  if (message?.id != null && !message.method) answered(message)
  if (message?.method === 'session/update' && !fresh(message.params.sessionId, Bun.hash(line))) return
  process.stdout.write(`${line}\n`)
}

function answered(response: { id: string | number; result?: any }) {
  const asked = waiting.get(response.id)?.request
  waiting.delete(response.id)
  if (asked?.method === 'session/new' && response.result?.sessionId) sessions.set(response.result.sessionId, { cwd: asked.params.cwd, mcpServers: asked.params.mcpServers })
  if (asked?.method === 'session/set_config_option' && response.result) {
    const { sessionId, configId, value } = asked.params
    picked.set(sessionId, (picked.get(sessionId) ?? new Map()).set(configId, value))
  }
  if (asked?.method === 'session/prompt') {
    shown.delete(asked.params.sessionId)
    skip.delete(asked.params.sessionId)
  }
}

// An update T3 hasn't been shown yet, counted as shown.
function fresh(sessionId: string, hash: number | bigint) {
  const skipping = skip.get(sessionId)
  const left = skipping?.get(hash)
  if (left) {
    skipping!.set(hash, left - 1)
    return false
  }
  const counts = shown.get(sessionId)
  counts?.set(hash, (counts.get(hash) ?? 0) + 1)
  return true
}

function reopen(next: Socket) {
  const send = (message: object) => next.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  if (initialize) send({ id: `${OWN}initialize`, method: 'initialize', params: initialize })
  for (const [sessionId, { cwd, mcpServers }] of sessions) {
    send({ id: `${OWN}${sessionId}`, method: 'session/resume', params: { sessionId, cwd, mcpServers } })
    for (const [configId, value] of picked.get(sessionId) ?? []) send({ id: `${OWN}${sessionId}:${configId}`, method: 'session/set_config_option', params: { sessionId, configId, value } })
  }
  for (const [id, { line, request, at }] of waiting) {
    if (request.method !== 'session/prompt') {
      next.write(`${line}\n`)
      continue
    }
    skip.set(request.params.sessionId, new Map(shown.get(request.params.sessionId)))
    send({ id, method: '_hex/rejoin', params: { ...request.params, since: at } })
  }
}

function parse(line: string): Request | undefined {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
