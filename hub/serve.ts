import { PORT, free, route } from './hub.ts'

// Before the clients load: Telegram's bot module awaits its polling loop, which never ends.
process.on('SIGHUP', () => void free().then(() => process.exit(0)))
Bun.serve({ hostname: '127.0.0.1', port: PORT, idleTimeout: 0, fetch: route })

await Promise.all([
  import('../channels/telegram/bot.ts'),
  import('../channels/discord/bot.ts'),
  import('../channels/buzz/bot.ts'),
  import('../channels/t3/bot.ts'),
  import('../channels/voice/bot.ts'),
])
