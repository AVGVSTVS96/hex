import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { connect } from 'net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as grammy from 'grammy'
import { clients } from '../../hub/hub.ts'
import { connect as connectSession, noClaude } from '../../hub/testing.ts'
import { until } from '../../hub/until.ts'
import { open } from '../../hub/store.ts'

const CHANNEL = 'plugin:telegram@hex'
const OWNER = 2000
const FORUM = -1001234
const DESK = `${FORUM}:5`
const owner = { id: OWNER, is_bot: false, first_name: 'Bassim', username: 'bassim' }
const hex = { id: 1000, is_bot: true, first_name: 'hex', username: 'hex_bot' }
const forum = { id: FORUM, type: 'supergroup', title: 'hex', is_forum: true }
const TRANSCRIBER = 'http://transcriber/v1/audio/transcriptions'

type Call = { method: string; payload: Record<string, any>; result?: any }
const calls: Call[] = []
const captionOnly = new Set<number>()
// Messages whose next button edit reaches Telegram late, and each button edit in the order it landed.
const slow = new Set<number>()
const landed: Record<string, any>[] = []
let bot: grammy.Bot
let started: Record<string, any> = {}
let nextMessage = 100
let nextUpdate = 1
let throttled = 0

function answer(method: string, payload: Record<string, any>) {
  const message = () => ({ message_id: ++nextMessage, date: 0, chat: { id: payload.chat_id }, from: hex })
  switch (method) {
    case 'sendPoll': {
      const sent = message()
      return { ...sent, poll: { id: `poll-${sent.message_id}` } }
    }
    case 'forwardMessages': return payload.message_ids.map(() => ({ message_id: ++nextMessage }))
    case 'getForumTopicIconStickers': return [{ emoji: '🔥', custom_emoji_id: '111' }, { emoji: '❤️', custom_emoji_id: '222' }]
    case 'createForumTopic': return { message_thread_id: 9, name: payload.name, icon_color: 0 }
    case 'getChat': return forum
    case 'getChatMember': return { status: 'creator', user: payload.user_id === OWNER ? owner : hex }
    case 'getFile': return { file_id: payload.file_id, file_unique_id: payload.file_id, file_path: `photos/${payload.file_id}.jpg` }
    default: return method.startsWith('send') || method.startsWith('forward') ? message() : true
  }
}

// The real grammy Bot routes every update; only its calls to Telegram are faked.
class Bot extends grammy.Bot {
  constructor(token: string) {
    super(token, { botInfo: hex as any })
    bot = this
    this.api.config.use(async (_prev, method, payload: any) => {
      const call: Call = { method, payload }
      calls.push(call)
      if (method.startsWith('send') && throttled && throttled--) return { ok: false, error_code: 429, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } } as any
      if (method === 'editMessageReplyMarkup' && slow.delete(payload.message_id)) await Bun.sleep(200)
      if (method === 'editMessageReplyMarkup') landed.push(payload)
      if (method === 'editMessageText' && captionOnly.has(payload.message_id)) {
        return { ok: false, error_code: 400, description: 'Bad Request: there is no text in the message to edit' } as any
      }
      return { ok: true, result: (call.result = answer(method, payload)) } as any
    })
  }
  override async start(options: any) {
    started = options
    options.onStart?.(hex)
  }
}

mock.module('grammy', () => ({ ...grammy, Bot }))

const state = mkdtempSync(join(tmpdir(), 'telegram-'))

// Each open thread as the hub keeps it in hex.db, by its id.
const saved = (): Record<string, any> => Object.fromEntries(open(state).threads({ open: true }).map(thread => [thread.thread, thread]))
const outbox = mkdtempSync(join(tmpdir(), 'telegram-outbox-'))
afterAll(() => {
  rmSync(state, { recursive: true, force: true })
  rmSync(outbox, { recursive: true, force: true })
})
let received: any[] = []
let call: (tool: string, args: object) => Promise<any>
let ask: (request: object) => Promise<unknown>
let session: (payload: object) => void

const called = (method: string, match: (payload: Record<string, any>) => boolean = () => true) =>
  until(() => calls.find(c => c.method === method && match(c.payload))?.payload)
const idOf = (payload: Record<string, any>) => calls.find(c => c.payload === payload)!.result.message_id
const inbound = (match: (line: any) => boolean) => until(() => received.find(line => line.type === 'inbound' && match(line)))

function message(fields: Record<string, any>) {
  return { message_id: ++nextMessage, date: 1760000000, chat: forum, from: owner, message_thread_id: 5, is_topic_message: true, ...fields }
}

async function update(fields: Record<string, any>) {
  await bot.handleUpdate({ update_id: nextUpdate++, ...fields } as any)
}

beforeAll(async () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)] }))
  open(state).keepThreads('telegram', { [DESK]: { name: 'desk' }, [String(OWNER)]: { name: 'Bassim' }, [`${FORUM}:6`]: { name: 'notes' }, 'stray-key': { name: 'stray' } })
  Object.assign(process.env, { PATH: noClaude(), TELEGRAM_STATE_DIR: state, TELEGRAM_BOT_TOKEN: 'token', HEX_LAUNCHER: 'false', HEX_MAIN_THREAD: String(FORUM), TRANSCRIBE_URL: TRANSCRIBER, TRANSCRIBE_MODEL: 'whisper' })
  const fetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://api.telegram.org/file/')) return new Response('jpeg')
    if (url !== TRANSCRIBER) return fetch(url, init)
    const form = init!.body as FormData
    return Response.json({ text: form.get('model') === 'whisper' ? ' anchors ship friday ' : 'wrong model' })
  }) as any
  await import('./bot.ts')
  const desk = await connectSession({ stateDir: state, path: '/telegram', channel: CHANNEL, thread: DESK })
  received = desk.received
  call = desk.call
  ask = desk.ask
  const hooks = connect(join(state, 'hub.sock'))
  await new Promise(resolve => hooks.on('connect', resolve))
  session = payload => hooks.write(JSON.stringify(payload) + '\n')
})

test("closing a thread list entry that isn't a topic forgets it, instead of failing", async () => {
  expect((await call('close_thread', { thread: 'stray-key' })).text).toBe('forgot "stray": it isn\'t a topic, so there was nothing to close in Telegram')
  await until(() => !('stray-key' in saved()))
})

test('the bot asks Telegram for reactions, button taps and poll votes', () => {
  expect(started.allowed_updates).toEqual(['message', 'edited_message', 'message_reaction', 'callback_query', 'poll_answer'])
})

test('a reaction reaches the thread of the message it is on, with that message\'s text and author', async () => {
  const sent = await call('reply', { text: 'deploy is green' })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  const react = (old_reaction: object[], new_reaction: object[]) =>
    update({ message_reaction: { chat: forum, message_id: id, user: owner, date: 1760000000, old_reaction, new_reaction } })
  const thumbs = { type: 'emoji', emoji: '👍' }

  await react([], [thumbs])
  expect((await inbound(line => line.meta.reaction === '👍' && !line.meta.reaction_removed)).meta).toMatchObject({
    reaction_to_message_id: String(id), reaction_to_user: 'hex_bot', reaction_to_text: 'deploy is green',
  })
  await react([thumbs], [])
  expect((await inbound(line => line.meta.reaction_removed === 'true')).content).toBe('(reaction removed: 👍)')
})

test('a reaction on a forum message the hub never saw is dropped, since Telegram names no topic', async () => {
  const before = received.length
  await update({ message_reaction: { chat: forum, message_id: 1, user: owner, date: 1760000000, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '🔥' }] } })
  await Bun.sleep(100)
  expect(received.slice(before).filter(line => line.type === 'inbound')).toEqual([])
})

test('buttons come back as a tap with the label, and the message keeps only the chosen one', async () => {
  const sent = await call('reply', { text: 'Ship it?', buttons: ['Yes', 'No'], silent: true })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  expect(await called('sendMessage', p => p.text === 'Ship it?')).toMatchObject({
    disable_notification: true,
    reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: '0' }, { text: 'No', callback_data: '1' }]] },
  })
  const markup = { inline_keyboard: [[{ text: 'Yes', callback_data: '0' }, { text: 'No', callback_data: '1' }]] }
  await update({ callback_query: { id: 'tap', from: owner, chat_instance: 'x', data: '0', message: message({ message_id: id, from: hex, text: 'Ship it?', reply_markup: markup }) } })
  expect(await called('answerCallbackQuery')).toMatchObject({ callback_query_id: 'tap' })
  expect(await called('editMessageReplyMarkup', p => p.message_id === id)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: '✓ Yes', disabled: {} }]] } })
  const tap = await inbound(line => line.meta.button === 'true')
  expect(tap.content).toBe('Yes')
  expect(tap.meta.button_message_id).toBe(String(id))
})

test('a permission prompt asks in its own topic, and the owner\'s tap answers the session instead of reaching it as a message', async () => {
  void ask({ request_id: 'abcde', tool_name: 'Bash', description: 'Delete the build folder', input_preview: '{"command":"rm -rf build","description":"Delete the build folder"}' })
  const prompt = await called('sendMessage', p => p.text?.startsWith('🔐'))
  const markup = { inline_keyboard: [[{ text: 'Allow', callback_data: 'perm:allow:abcde' }, { text: 'Deny', callback_data: 'perm:deny:abcde' }]] }
  expect(prompt).toMatchObject({ chat_id: String(FORUM), message_thread_id: 5, text: '🔐 Bash: Delete the build folder\n\ncommand: rm -rf build', reply_markup: markup })
  const id = idOf(prompt)
  const tap = (from: object) => update({ callback_query: { id: 'perm', from, chat_instance: 'x', data: 'perm:deny:abcde', message: message({ message_id: id, from: hex, text: prompt.text, reply_markup: markup }) } })

  await tap({ id: 3000, is_bot: false, first_name: 'Someone' })
  await Bun.sleep(100)
  expect(received.find(line => line.type === 'permission')).toBeUndefined()

  const before = received.length
  await tap(owner)
  expect(await until(() => received.find(line => line.type === 'permission'))).toEqual({ type: 'permission', request_id: 'abcde', behavior: 'deny' })
  expect(await called('editMessageReplyMarkup', p => p.message_id === id)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: '✓ Deny', disabled: {} }]] } })
  await Bun.sleep(100)
  expect(received.slice(before).filter(line => line.type === 'inbound')).toEqual([])
})

test('a prompt still open when the turn ends, answered in the session itself, stops offering its buttons', async () => {
  void ask({ request_id: 'fghij', tool_name: 'Write', description: 'Write notes.md', input_preview: '{"file_path":"/tmp/notes.md","content":"hi"}' })
  const prompt = await called('sendMessage', p => p.text?.startsWith('🔐 Write'))
  expect(prompt.text).toBe('🔐 Write: Write notes.md\n\nfile_path: /tmp/notes.md\ncontent: hi')
  const id = idOf(prompt)
  session({ type: 'state', thread: DESK, busy: true })
  session({ type: 'state', thread: DESK, busy: false })
  expect(await called('editMessageReplyMarkup', p => p.message_id === id)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: 'No longer waiting', disabled: {} }]] } })
})

test('forward sends a message into another topic, found by its name', async () => {
  expect((await call('forward', { message_id: '7', thread: 'notes' })).text).toMatch(/^forwarded to "notes"/)
  expect(await called('forwardMessage')).toMatchObject({ chat_id: String(FORUM), from_chat_id: String(FORUM), message_id: 7, message_thread_id: 6 })
})

test('a poll goes out with named votes, and each vote comes back as the chosen options', async () => {
  const sent = await call('poll', { question: 'Lunch?', options: ['tacos', 'pho', 'salad'], multiple: true })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  expect(await called('sendPoll')).toMatchObject({ question: 'Lunch?', options: [{ text: 'tacos' }, { text: 'pho' }, { text: 'salad' }], is_anonymous: false, allows_multiple_answers: true })
  await update({ poll_answer: { poll_id: `poll-${id}`, user: owner, option_ids: [0, 2] } })
  const vote = await inbound(line => line.meta.vote)
  expect(vote.content).toBe('(vote: tacos; salad)')
  expect(vote.meta).toMatchObject({ vote: 'tacos; salad', poll_message_id: String(id), poll: 'Lunch?' })
  await update({ poll_answer: { poll_id: `poll-${id}`, user: owner, option_ids: [] } })
  expect((await inbound(line => line.meta.vote_removed === 'true')).content).toBe('(vote removed)')
})

test('edit_message changes a file\'s caption when it has no text, and replaces the file itself', async () => {
  captionOnly.add(42)
  await call('edit_message', { message_id: '42', text: 'new caption' })
  expect(await called('editMessageCaption')).toMatchObject({ message_id: 42, caption: 'new caption' })
  const file = join(outbox, `chart-${Date.now()}.png`)
  writeFileSync(file, 'png')
  await call('edit_message', { message_id: '43', file })
  expect((await called('editMessageMedia')).media).toMatchObject({ type: 'photo' })
})

test('markdown goes out as Telegram\'s own rich markdown, and a code block cut between chunks stays a code block', async () => {
  await call('reply', { text: 'look:\n```\n┌─┐\n└─┘\n```', format: 'markdown' })
  expect(await called('sendRichMessage')).toMatchObject({ rich_message: { markdown: 'look:\n```\n┌─┐\n└─┘\n```' }, message_thread_id: 5 })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)], textChunkLimit: 40 }))
  await call('reply', { text: '```ts\n' + 'const a = 1\n'.repeat(5) + '```', format: 'markdown' })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)] }))
  const parts = calls.filter(c => c.method === 'sendRichMessage').slice(1).map(c => c.payload.rich_message.markdown)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) expect(part.match(/```/g)!.length % 2).toBe(0)
})

test('a newline in markdown stays a new line, where Telegram would join it into the paragraph, and code blocks go as written', async () => {
  const text = [
    '**Status**', '• one', '• two', 'ends in a break\\', 'next', '',
    '- a list', '- runs on', '## Heading', 'under it', '> quoted', '',
    '```', 'code', 'as is', '```', 'after',
  ].join('\n')
  await call('reply', { text, format: 'markdown' })
  expect((await called('sendRichMessage', p => p.rich_message.markdown.startsWith('**Status**'))).rich_message.markdown).toBe([
    '**Status**  ', '• one  ', '• two  ', 'ends in a break\\', 'next', '',
    '- a list', '- runs on', '## Heading  ', 'under it', '> quoted', '',
    '```', 'code', 'as is', '```', 'after',
  ].join('\n'))

  await call('edit_message', { message_id: '44', text: 'Done:\n• shipped\n~~~\ntildes\n```\nstill code\n~~~\nafter\nend', format: 'markdown' })
  expect((await called('editMessageText', p => p.message_id === 44)).rich_message).toEqual({ markdown: 'Done:  \n• shipped\n~~~\ntildes\n```\nstill code\n~~~\nafter  \nend' })

  await clients.get('telegram')!.backfill!(`${FORUM}:9`, [{ from: 'hex', text: 'Backfilled:\n• kept' }])
  expect((await called('sendRichMessage', p => p.rich_message.markdown.startsWith('Backfilled'))).rich_message).toEqual({ markdown: 'Backfilled:  \n• kept' })
})

test('files go without an empty message, short text rides as the caption, and a photo over 10MB goes as a document', async () => {
  const small = join(outbox, `small-${Date.now()}.jpg`)
  const big = join(outbox, `big-${Date.now()}.jpg`)
  writeFileSync(small, 'jpg')
  writeFileSync(big, Buffer.alloc(11 * 1024 * 1024))
  const before = calls.length
  await call('reply', { text: 'two shots', files: [small, big] })
  const sent = calls.slice(before)
  expect(sent.map(c => c.method)).toEqual(['sendPhoto', 'sendDocument'])
  expect(sent[0]!.payload.caption).toBe('two shots')
  expect(sent[1]!.payload.caption).toBeUndefined()
})

test('new_thread opens a topic with a random icon and only the prompt, forwarding nothing; rename_thread renames it and changes its icon', async () => {
  const asked = message({ text: 'open a topic for the desk anchors' })
  await update({ message: asked })
  await inbound(line => line.meta.message_id === String(asked.message_id))
  session({ type: 'state', thread: DESK, busy: true })
  await until(() => calls.find(c => c.method === 'sendChatAction'))
  await call('reply', { text: 'on it' })
  expect((await call('new_thread', { title: 'Desk', prompt: 'research desk anchors' })).text).toMatch(/^started thread "Desk" in telegram/)
  expect((await called('createForumTopic')).icon_custom_emoji_id).toMatch(/^(111|222)$/)
  expect(calls.find(c => c.method === 'forwardMessages')).toBeUndefined()
  session({ type: 'state', thread: DESK, busy: false })

  await call('rename_thread', { title: 'Anchors', icon: '❤' })
  expect(await called('editForumTopic')).toMatchObject({ message_thread_id: 5, name: 'Anchors', icon_custom_emoji_id: '222' })
  expect((await call('rename_thread', { title: 'Desk anchors' })).error).toBe('title must be one word, got "Desk anchors"')
  expect((await call('rename_thread', { icon: '🦄' })).error).toBe('Telegram has no topic icon 🦄; pick one of 🔥 ❤️')
})

test('an album arrives as one message with every photo and the caption', async () => {
  const photo = (id: string) => [{ file_id: `${id}-small`, file_unique_id: `${id}-small`, width: 90, height: 90 }, { file_id: id, file_unique_id: id, width: 900, height: 900 }]
  const first = message({ media_group_id: 'g1', photo: photo('one'), caption: 'the anchors' })
  await update({ message: first })
  await update({ message: message({ media_group_id: 'g1', photo: photo('two') }) })
  const album = await inbound(line => line.meta.message_id === String(first.message_id))
  expect(album.content).toBe('the anchors')
  expect(album.meta.image_path.split('; ').map((path: string) => path.replace(/.*\d-/, ''))).toEqual(['one.jpg', 'two.jpg'])
})

test('a voice message arrives as its transcript, with the recording still attached', async () => {
  const voice = { file_id: 'v1', file_unique_id: 'v1', duration: 3, mime_type: 'audio/ogg' }
  const plain = message({ voice })
  const captioned = message({ voice, caption: 'for the desk' })
  await update({ message: plain })
  await update({ message: captioned })
  expect(await inbound(line => line.meta.message_id === String(plain.message_id))).toMatchObject({ content: '(voice message) anchors ship friday', meta: { attachment_kind: 'voice', attachment_file_id: 'v1' } })
  expect((await inbound(line => line.meta.message_id === String(captioned.message_id))).content).toBe('for the desk\n\n(voice message) anchors ship friday')
})

test('a reply to a message in another topic keeps the quote and what the hub knows of it', async () => {
  const sent = await call('reply', { text: 'anchors ship friday', thread: 'notes' })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  const reply = message({
    text: 'still true?',
    external_reply: { origin: { type: 'user', date: 0, sender_user: hex }, chat: forum, message_id: id },
    quote: { text: 'friday', position: 0 },
  })
  await update({ message: reply })
  expect((await inbound(line => line.meta.message_id === String(reply.message_id))).meta).toMatchObject({
    reply_to_message_id: String(id), reply_to_user: 'hex_bot', reply_to_text: 'anchors ship friday', reply_to_quote: 'friday',
  })
})

test('the got-it reaction lands on each message when access.json sets one', async () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)], ackReaction: '👀' }))
  const seen = message({ text: 'ping' })
  await update({ message: seen })
  expect(await called('setMessageReaction', p => p.message_id === seen.message_id)).toMatchObject({ reaction: [{ type: 'emoji', emoji: '👀' }] })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: [String(OWNER)] }))
})

test('a DM is its own thread: it reaches the DM session, not the group, and replies go back to the DM', async () => {
  const dm = await connectSession({ stateDir: state, path: '/telegram', channel: CHANNEL, thread: String(OWNER) })
  const lines = dm.received
  const forwards = calls.filter(c => c.method === 'forwardMessage').length

  await update({ message: { message_id: ++nextMessage, date: 1760000000, chat: { id: OWNER, type: 'private', first_name: 'Bassim' }, from: owner, text: 'quick one' } })
  const got = await until(() => lines.find(line => line.type === 'inbound' && line.content === 'quick one'))
  expect(got.meta.chat_id).toBe(String(OWNER))
  expect(calls.filter(c => c.method === 'forwardMessage').length).toBe(forwards)

  await dm.call('reply', { text: 'on it, from the DM' })
  expect(await called('sendMessage', p => p.text === 'on it, from the DM')).toMatchObject({ chat_id: String(OWNER) })
  dm.close()
})

const ledger = () => ({ pins: Object.fromEntries(open(state).pins({ app: 'telegram' }).map(pin => [pin.thread, pin])) })
const asked = (id: number) => open(state).question('telegram', DESK, id)!

test('a question with buttons goes in the ledger, and a tap there answers it', async () => {
  const sent = await call('reply', { text: 'Deploy now?', buttons: ['Deploy', 'Wait'] })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  expect(asked(id)).toMatchObject({ thread: DESK, message: id, text: 'Deploy now?', options: ['Deploy', 'Wait'] })
  const markup = { inline_keyboard: [[{ text: 'Deploy', callback_data: '0' }, { text: 'Wait', callback_data: '1' }]] }
  await update({ callback_query: { id: 'deploy', from: owner, chat_instance: 'x', data: '1', message: message({ message_id: id, from: hex, text: 'Deploy now?', reply_markup: markup }) } })
  expect(await until(() => asked(id).answer)).toMatchObject({ label: 'Wait', via: 'telegram' })
})

test('a question answered in the app reaches its thread like a tap, says so on its buttons, and can be taken back', async () => {
  const sent = await call('reply', { text: 'Which color?', buttons: ['Mint', 'Coral'] })
  const id = Number(sent.text.match(/id: (\d+)/)[1])
  session({ type: 'answer', thread: DESK, message: id, label: 'Coral', via: 'app' })
  expect(await called('editMessageReplyMarkup', p => p.message_id === id)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: '✓ Answered in the app: Coral', disabled: {} }]] } })
  const tap = await inbound(line => line.meta.button_message_id === String(id))
  expect(tap.content).toBe('Coral')
  expect(tap.meta).toMatchObject({ button: 'true', user: 'hex app', answered_in: 'in the app' })
  expect(asked(id).answer).toMatchObject({ label: 'Coral', via: 'app' })

  session({ type: 'reopen', thread: DESK, message: id, via: 'app' })
  expect(await called('editMessageReplyMarkup', p => p.message_id === id && p.reply_markup.inline_keyboard[0].length === 2)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: 'Mint', callback_data: '0' }, { text: 'Coral', callback_data: '1' }]] } })
  expect((await inbound(line => line.meta.took_back === 'Coral')).content).toBe('(took back: Coral)')
  expect(asked(id).answer).toBeUndefined()
})

test('an answer taken back right away gets its buttons back, even when the answer\'s own edit lands late', async () => {
  const id = Number((await call('reply', { text: 'Which day?', buttons: ['Mon', 'Tue'] })).text.match(/id: (\d+)/)[1])
  slow.add(id)
  session({ type: 'answer', thread: DESK, message: id, label: 'Tue', via: 'app' })
  await inbound(line => line.meta.button_message_id === String(id) && line.content === 'Tue')
  session({ type: 'reopen', thread: DESK, message: id, via: 'app' })
  await inbound(line => line.meta.took_back === 'Tue')
  await until(() => landed.filter(edit => edit.message_id === id).length === 2)
  expect(landed.findLast(edit => edit.message_id === id)!.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Mon', callback_data: '0' }, { text: 'Tue', callback_data: '1' }]] })
})

test('of two taps on one question only the first counts: the thread hears it once, and the later tap\'s buttons go back to it', async () => {
  const id = Number((await call('reply', { text: 'Ship tonight?', buttons: ['Ship', 'Hold'] })).text.match(/id: (\d+)/)[1])
  const markup = { inline_keyboard: [[{ text: 'Ship', callback_data: '0' }, { text: 'Hold', callback_data: '1' }]] }
  const tap = (callback: string, data: string) =>
    update({ callback_query: { id: callback, from: owner, chat_instance: 'x', data, message: message({ message_id: id, from: hex, text: 'Ship tonight?', reply_markup: markup }) } })
  await Promise.all([tap('ship', '0'), tap('hold', '1')])
  const { label } = asked(id).answer!
  const shown = () => calls.findLast(c => c.method === 'editMessageReplyMarkup' && c.payload.message_id === id)?.payload.reply_markup.inline_keyboard[0][0].text
  await until(() => shown() === `✓ ${label}`)
  await inbound(line => line.meta.button_message_id === String(id))
  expect(received.filter(line => line.type === 'inbound' && line.meta.button_message_id === String(id)).map(line => line.content)).toEqual([label])
  expect(open(state).db.query("select count(*) as n from messages where json_extract(meta, '$.button_message_id') = ?").get(String(id))).toEqual({ n: 1 })
})

test('a settled question loses its buttons without reaching its thread, and an edit keeps a question open with its buttons until it says it settled', async () => {
  const first = Number((await call('reply', { text: 'Buy the domain?', buttons: ['Buy', 'Skip'] })).text.match(/id: (\d+)/)[1])
  const before = received.length
  session({ type: 'settle', thread: DESK, message: first, note: 'Settled: bought on Oct 12' })
  expect(await called('editMessageReplyMarkup', p => p.message_id === first)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: 'Settled: bought on Oct 12', disabled: {} }]] } })
  expect(await until(() => asked(first).settled)).toMatchObject({ note: 'Settled: bought on Oct 12' })
  expect(received.slice(before).filter(line => line.type === 'inbound')).toEqual([])

  const second = Number((await call('reply', { text: 'Rename it?', buttons: ['Yes', 'No'] })).text.match(/id: (\d+)/)[1])
  await call('edit_message', { message_id: String(second), text: 'Rename it? It reads better.' })
  expect(await called('editMessageText', p => p.message_id === second)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: '0' }, { text: 'No', callback_data: '1' }]] } })
  expect(asked(second).settled).toBeUndefined()
  await call('edit_message', { message_id: String(second), text: 'Renamed, as you said in the call.', settled: true })
  expect(await called('editMessageText', p => p.message_id === second && p.text === 'Renamed, as you said in the call.')).not.toHaveProperty('reply_markup')
  expect(await called('editMessageReplyMarkup', p => p.message_id === second)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: '✓ Settled', disabled: {} }]] } })
  expect(asked(second).settled).toMatchObject({ note: '✓ Settled' })

  const third = Number((await call('reply', { text: 'Keep the old name?', buttons: ['Yes', 'No'] })).text.match(/id: (\d+)/)[1])
  await call('edit_message', { message_id: String(third), settled: true })
  expect(await called('editMessageReplyMarkup', p => p.message_id === third)).toMatchObject({ reply_markup: { inline_keyboard: [[{ text: '✓ Settled', disabled: {} }]] } })
  expect(asked(third)).toMatchObject({ text: 'Keep the old name?', settled: { note: '✓ Settled' } })
  expect((await call('edit_message', { message_id: String(third) })).error).toBe('edit_message needs text, a file, or settled')
})

test('a poll answered in the app closes, and its vote reaches the thread', async () => {
  const id = Number((await call('poll', { question: 'Which take?', options: ['A', 'B'] })).text.match(/id: (\d+)/)[1])
  expect(asked(id)).toMatchObject({ options: ['A', 'B'], poll: `poll-${id}` })
  session({ type: 'answer', thread: DESK, message: id, label: 'B', via: 'call' })
  expect(await called('stopPoll', p => p.message_id === id)).toBeTruthy()
  expect((await inbound(line => line.meta.poll_message_id === String(id) && line.meta.answered_in)).meta).toMatchObject({ vote: 'B', answered_in: 'on a call', user: 'hex call' })
})

test('a message edited before it is forwarded goes with its new text', async () => {
  const id = Number((await call('reply', { text: 'Status: drafting' })).text.match(/id: (\d+)/)[1])
  await call('edit_message', { message_id: String(id), text: 'Status: live' })
  const forwarded = Number((await call('forward', { message_id: String(id), thread: 'notes' })).text.match(/id: (\d+)/)[1])
  expect(open(state).message(`telegram:${FORUM}:${forwarded}`)?.body).toBe('Status: live')
})

test("a status post is the session's note over lines hex keeps current from the thread's questions and tasks", async () => {
  const id = Number((await call('pin', { note: 'Site: example.com' })).text.match(/id: (\d+)/)[1])
  const sent = await called('sendRichMessage', p => p.rich_message.markdown.startsWith('Site: example.com'))
  expect(sent.rich_message.markdown).toStartWith('Site: example.com\n\n**🔴 Blocked on you')
  expect(await called('pinChatMessage', p => p.message_id === id)).toBeTruthy()
  expect(ledger().pins[DESK]).toMatchObject({ message: id, note: 'Site: example.com' })

  const edits = () => calls.filter(c => c.method === 'editMessageText' && c.payload.message_id === id).map(c => c.payload.rich_message.markdown as string)
  await call('reply', { text: 'Rename the site?', buttons: ['Yes', 'No'] })
  await until(() => /\n- \[Rename the site\?\]\(https:\/\/t\.me\/c\/\d+\/\d+\/\d+\)/.test(edits().at(-1) ?? ''))

  const count = edits().length
  expect((await call('edit_message', { message_id: String(id), text: 'Site: example.org' })).text).toStartWith("edited the status post's note")
  expect(edits()).toHaveLength(count + 1)
  expect(edits().at(-1)).toStartWith('Site: example.org\n\n**🔴 Blocked on you**')
  expect(edits().at(-1)).toContain('[Rename the site?]')
  expect(ledger().pins[DESK]).toMatchObject({ message: id, note: 'Site: example.org' })
  expect((await call('edit_message', { message_id: String(id), text: 'Site', file: join(state, 'access.json') })).error).toBe('a status post is text: send the file in its own message')

  const next = Number((await call('pin', { note: 'Site: v2' })).text.match(/id: (\d+)/)[1])
  expect(await called('unpinChatMessage', p => p.message_id === id)).toBeTruthy()
  expect(ledger().pins[DESK]).toMatchObject({ message: next, note: 'Site: v2' })
  await call('pin', { message_id: String(next), unpin: true })
  expect(ledger().pins[DESK]).toBeUndefined()
})

test("a thread's link is where Telegram opens it: a topic, General, or for a DM, the bot", () => {
  expect(saved()[DESK]?.link).toBe('https://t.me/c/1234/5')
  expect(saved()[String(OWNER)]).toMatchObject({ link: 'https://t.me/hex_bot' })
})

test('a backfill quotes the owner under their name and posts hex as itself, silently, split to fit and waiting out the rate limit', async () => {
  const from = calls.length
  throttled = 1
  await clients.get('telegram')!.backfill!(`${FORUM}:9`, [{ from: 'me', text: 'how full is your context?' }, { from: 'hex', text: '**Roomy.**' }, { from: 'me', text: 'a'.repeat(5000) }])
  const sent = calls.slice(from).filter(c => c.method.startsWith('send'))
  expect(sent.map(c => [c.method, c.payload.message_thread_id, c.payload.disable_notification])).toEqual([
    ['sendMessage', 9, true],
    ['sendMessage', 9, true],
    ['sendRichMessage', 9, true],
    ['sendMessage', 9, true],
    ['sendMessage', 9, true],
  ])
  expect(sent[1]!.payload).toMatchObject({ text: 'Bassim\nhow full is your context?', entities: [{ type: 'bold', offset: 0, length: 6 }, { type: 'blockquote', offset: 7, length: 25 }] })
  expect(sent[2]!.payload.rich_message).toEqual({ markdown: '**Roomy.**' })
  expect(sent.slice(3).map(c => c.payload.text.length)).toEqual([4096, 5000 - 4089 + 7])
})

test('/effort and /model set what the thread\'s next message starts with, and never reach its session, unlike a path', async () => {
  const before = received.length
  await update({ message: message({ text: '/tmp/cache is full' }) })
  await inbound(line => line.content === '/tmp/cache is full')
  await update({ message: message({ text: '/model@other_bot opus' }) })
  await inbound(line => line.content === '/model@other_bot opus')
  await update({ message: message({ text: '/Model@hex_bot gpt' }) })
  await called('sendMessage', p => p.text === '/model takes one of: opus, sonnet, haiku, fable')
  await update({ message: message({ text: '/effort high' }) })
  expect(await called('sendMessage', p => p.text === "Effort: High, from this thread's next message.")).toMatchObject({ message_thread_id: 5 })
  expect(saved()[DESK].effort).toBe('high')
  expect(received.slice(before).filter(line => line.type === 'inbound').map(line => line.content)).toEqual(['/tmp/cache is full', '/model@other_bot opus'])
})
