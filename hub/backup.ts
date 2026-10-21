import { $ } from 'bun'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { zoneOf } from './schedule.ts'
import { open } from './store.ts'

// Each night at 3:00 on the owner's clock, while hex is quietest.
const HOUR = 3
const KEEP = 7

// The day's copy of hex.db, made with VACUUM INTO and checked by SQLite, goes to state/backups and,
// when hex has a computer (a Sprite), to ~/hex-backups there, off this machine's disk. Each place
// keeps the last seven. The computer reads back the copy's hash, so a copy that arrived broken fails.
export async function backup(storeDir: string, day: string, computer?: string) {
  const dir = join(storeDir, 'backups')
  const name = `hex-${day}.db`
  const part = join(dir, `${name}.part`)
  mkdirSync(dir, { recursive: true })
  rmSync(part, { force: true })
  open(storeDir).db.run('vacuum into ?', [part])
  const copy = new Database(part, { readonly: true })
  const { quick_check } = copy.query('pragma quick_check').get() as { quick_check: string }
  copy.close()
  if (quick_check !== 'ok') throw new Error(`its copy fails SQLite's check: ${quick_check}`)
  renameSync(part, join(dir, name))
  for (const old of readdirSync(dir).filter(file => /^hex-.*\.db$/.test(file)).sort().slice(0, -KEEP)) rmSync(join(dir, old))
  if (!computer) return
  const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(join(dir, name)).arrayBuffer()).digest('hex')
  const keep = `set -e; mkdir -p ~/hex-backups; cd ~/hex-backups; cat > "$1.part"; mv "$1.part" "$1"; ls hex-*.db | head -n -${KEEP} | xargs -r rm --; sha256sum "$1"`
  const sent = await $`sprite exec -s ${computer} -- sh -c ${keep} sh ${name} < ${join(dir, name)}`.quiet().nothrow()
  if (sent.exitCode !== 0) throw new Error(`${computer} didn't take it: ${sent.stderr.toString().trim() || `exit ${sent.exitCode}`}`)
  if (!sent.stdout.toString().startsWith(hash)) throw new Error(`the copy on ${computer} doesn't match hex.db's`)
}

// The hub that serves General backs up each night, and at its start when the last 3:00 passed
// without one, so a night the hub was down is made up. A backup that fails tells the main thread;
// its copy stays in state/backups when only the computer failed.
export function nightly(storeDir: string, hexDir: string, main: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const run = async () => {
    const now = Temporal.Now.zonedDateTimeISO(zoneOf(hexDir) ?? Temporal.Now.timeZoneId())
    const today = now.round({ smallestUnit: 'hour', roundingMode: 'floor' }).with({ hour: HOUR })
    const passed = Temporal.ZonedDateTime.compare(today, now) <= 0
    const day = (passed ? today : today.subtract({ days: 1 })).toPlainDate().toString()
    if (!existsSync(join(storeDir, 'backups', `hex-${day}.db`))) {
      try {
        await backup(storeDir, day, process.env.HEX_COMPUTER || undefined)
      } catch (error) {
        const body = `[backup] hex couldn't back up state/hex.db for ${day}: ${(error as Error).message}. The next try is at 3:00.`
        open(storeDir).deliver({ key: `backup:failed@${day}`, to: main, from: 'backup', author: 'prompt', body, meta: { user: 'backup' } })
      }
    }
    if (!stopped) timer = setTimeout(run, (passed ? today.add({ days: 1 }) : today).epochMilliseconds - Date.now())
  }
  void run()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
