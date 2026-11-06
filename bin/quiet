#!/usr/bin/env bun
// quiet: returns once no hex session has been mid-turn for a few seconds, so an update lands between
// turns. hex starts every session in the background, so it waits on each Claude Code calls busy,
// unless hex's own record says its turn ended since Claude Code's last status change (Claude Code
// keeps a session busy while its background agents or shells run). Each session bin/update lists in
// state/update-askers as <session id>@<ms> asked for an update at that time: it's left out for the
// turn it asked from, which waits on the update, and counts again from its next turn on.
import { mkdirSync, readFileSync, watch } from "node:fs"
import { join } from "node:path"
import { CLAUDE, running, type Session } from "../hub/running.ts"
import { open, stateDir } from "../hub/store.ts"

const store = open(stateDir())
const sessions = join(CLAUDE, "sessions")
const settle = Number(process.env.HEX_QUIET_MS ?? 10_000)
const askers = join(stateDir(), "update-askers")
const asked = () => {
  try {
    return readFileSync(askers, "utf8").split("\n").map((line) => line.split(" ")[0]!.split("@"))
  } catch {
    return []
  }
}
const ended = (session: Session) => !!session.ended && Date.parse(session.ended) >= (session.updated ?? Infinity)
mkdirSync(sessions, { recursive: true })

function busy() {
  const asking = asked()
  const waiting = (session: Session) => asking.some(([id, at]) => id === session.id && (session.began ? Date.parse(session.began) : (session.updated ?? Infinity)) <= Number(at))
  return [...running(store).values()]
    .filter((session) => session.kind === "bg" && session.status === "busy" && !ended(session) && !waiting(session))
    .map((session) => session.name ?? session.id)
    .sort()
    .join(", ")
}

await new Promise<void>((done) => {
  let told = ""
  let timer: Timer | undefined
  const look = () => {
    const now = busy()
    if (now && now !== told) console.log(`waiting on: ${now}`)
    told = now
    if (now) {
      clearTimeout(timer)
      timer = undefined
    } else timer ??= setTimeout(() => {
      timer = undefined
      if (busy()) look()
      else done()
    }, settle)
  }
  watch(sessions, look)
  watch(stateDir(), (_, file) => file === "update-askers" && look())
  store.watch(look)
  look()
})
process.exit(0)
