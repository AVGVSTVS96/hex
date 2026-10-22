import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nightly } from './backup.ts'
import { clients, free, listen, up } from './hub.ts'
import { hexDir, stateDir } from './store.ts'

// Before the clients load: Telegram's bot module awaits its polling loop, which never ends.
// A restart (HUP) and a stop (TERM, INT) end the hub alike: live calls hang up, the clients sign
// off, a call that came in while they did hangs up too, and it exits for bin/hex to start the next
// one, so two never run at once. A stop also ends a hub still waiting for the port.
let stopping: Promise<void> | undefined
const stop = () => (stopping ??= free().then(() => Promise.allSettled([...clients.values()].map(client => client.close?.()))).then(free).then(() => process.exit(0)))
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.on(signal, () => void stop())
await listen()

// Once General connects, hex works on the commit this hub runs, and bin/hex rolls a later one that
// can't start back to it. General then hears about a rollback that brought this hub up, and this
// hub backs up hex.db each night (backup.ts).
const hex = join(import.meta.dir, '..')
const commit = Bun.spawnSync(['git', '-C', hex, 'rev-parse', '-q', '--verify', 'HEAD']).stdout.toString().trim()
const home = hexDir()
const state = stateDir()
const rollback = join(state, 'rollback')
void up.then(general => {
  if (commit) writeFileSync(join(state, 'good'), commit + '\n')
  nightly(state, home, general.main!)
  if (!existsSync(rollback)) return
  general.deliver(general.main!, general.name(general.main!) ?? 'hex', { content: readFileSync(rollback, 'utf8').trim(), author: 'prompt', meta: { user: 'hex' } })
  rmSync(rollback)
})

await Promise.all([
  import('../channels/telegram/bot.ts'),
  import('../channels/discord/bot.ts'),
  import('../channels/buzz/bot.ts'),
  import('../channels/t3/bot.ts'),
  import('../channels/voice/bot.ts'),
])
