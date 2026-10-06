# hex landing page copy

Final copy. Use it word for word. Text in `code` is shown as code. Notes in *(italics)* are for the designer, not the page. Anything marked **coming** isn't built yet and has to look it on the page (dashed, muted, with a small "coming" tag).

Every section is one headline, one short line and a visual. Let the visuals explain; keep captions to one line.

## Page

- `<title>`: hex · The best personal assistant is already on your machine
- Meta description: Claude Code is the best personal assistant there is. It's just been busy writing code. hex is the thin layer that points it at your life: about 3,800 lines, on the Claude plan you already pay for.

## Hero

- Sticker: Built on Claude Code
- Hero line: The best personal assistant is already on your machine.
- Sub line: It's just been busy writing code.

*(The hero is one glance: sticker, three-line headline, one short sub line, two buttons. The stats right under it carry the price.)*
- Primary CTA: Install
- Secondary CTA: View on GitHub

*(Telegram phone mock: "find 3 ramen spots open tonight near Terra Gallery, make a page comparing them and deploy it" → "On it. Opened #ramen-tonight." → "Live: ramen-tonight.vercel.app".)*

## Stats

- ~3,800 · lines of hex. Claude Code does the rest.
- $0 · extra, on the Claude plan you already pay for.
- 3 · front ends: Telegram, Discord and Buzz.
- 0 · frameworks, 0 databases. Just plain files.

## The bet

Section title: Everyone's building an agent. We plugged into the best one.
Line: Claude Code is the most capable agent around. hex points it at your life.

### Size strip

Label: Lines of source

*(Bars on one linear scale. hex's bar is a sliver.)*

- OpenClaw · 4 million+
- Hermes Agent · 1.5 million
- NanoClaw (the minimal one) · 68,000
- hex · ~3,800

Fine print: Tests and generated code excluded. Counted Oct 2026. Even the minimal one is 17x bigger.

*(hex counts what it runs, without tests or this site: the scripts and TS in bin/, plugin/, mods/ and computer/, the JSON in defaults/, the hub, and every TS file of the Telegram, Discord and Buzz channels. 3,728 lines on Oct 6 2026 after Buzz landed (Buzz alone is 1,648), rounded up. NanoClaw: 68,000 / 3,800 = 17x.)*

### Layer stack

*(Three stacked layers: a thin one on top, a thick one in the middle, the model at the bottom. Three points beside it.)*

- hex · ~3,800 lines · phone · computer · memory · hub
- Claude Code · the best agent harness · reasoning, tools, MCP, skills, subagents, computer use
- Opus 5.5 · the best agent model

Points:
- Why rebuild what Anthropic ships every week?
- Telegram channel: 714 lines. Upstream's: 1,045.
- Super minimal, super light, super snappy.

*(714 is the fork's telegram bot.ts + server.ts; 1,045 is upstream's one server.ts.)*

Band: Claude models are the best personal assistant models, period. Everything else is cope.

## One bot, a whole crew

Section title: One bot. A whole crew.
Line: Anthropic's own channel plugins, forked so every topic and thread gets its own session. Buzz is built the same way.

### Diagram labels

- Telegram · your pocket
- Discord · your desk
- Buzz · your workspace
- Arrows between neighbouring apps: hand off
- hex hub · one bot, many sessions
- Claude Code × 3 · ramen-tonight, Theo clips, #dev › fix ci
- SOUL.md · MEMORY.md · AGENTS.md · log/
- Frame: your box

### Features

1. **A crew, not a chatbot**: Every topic works in parallel, with its own context.
2. **It still writes code**: Ask for a page from your phone. Get a live link back.
3. **Rebuilds itself daily**: On Anthropic's latest code. Claude fixes its own patches.

## Its own machine

Section title: It doesn't live in a chat window.
Line: It lives on your box, with your whole network, a memory of its own and, if you want, a computer too.

- **Its own computer**: Optional: a cloud desktop with Chrome, on any provider you like. *(computer/setup builds one on a Fly.io Sprite. Don't name the provider on the page.)*
- **Your whole network**: Every machine you can ssh into.
- **Every connector**: Whatever your Claude account has. *(Mock: "your Claude account" over Gmail, Executor, AgentMail, Calendar. They're examples, not hex features.)*
- **Memory with a timeline**: OptMem, folded into MEMORY.md every night. *(Terminal mock: today / this week / earlier, then nightly → MEMORY.md.)*

## Front ends

Section title: Different rooms, same house.
Line: Each app does what it's best at. hex connects them.

**Telegram** · Your pocket.
- Every topic is its own session
- Voice notes in, short answers out
- It speaks up when something needs you

Bridge: take this to Discord

Bridge, above Buzz: take this to Buzz

**Discord** · Your desk.
- Tag it, and it opens a thread
- Room for code, logs and long answers
- Channels group work by area

**Buzz** · Your workspace. *(Full-width row under the other two, on their columns. Mock: a thread on the left, Buzz Desktop's Activity / Memory / Files panel on the right.)*
- Watch it work, step by step
- Edit its memory and files
- Shared with people and agents

Strip, **coming**: iMessage, and checking on any thread from any app.

## Basics

Table stakes too: an hourly check that stays quiet unless something needs you, schedules in one JSON file, voice notes.

## Closer

- We didn't build a personal assistant. We found one inside Claude Code and gave it a phone, a computer and a memory.
- Every Claude Code upgrade is a hex upgrade the same day.

## Install

Section title: Install with one prompt
Line: Paste this into Claude Code on your box. It asks when it needs you.

Code block: `Set up hex for me: https://github.com/AVGVSTVS96/hex. Follow INSTALL.md in that repo.`

Copy button: Copy · after click: Copied

**You'll need**
- A machine that stays on: a home server, a Mac that doesn't sleep, a cloud VM
- A Claude subscription
- Telegram, Discord, Buzz, or any mix

**You do**
- Make a bot
- Add it to your group or server
- Say hi

## Build

Section title: hex is my sandbox. Come build it with me.
Line: Fork it. Try your ideas. Send back what works. Let's make it the best assistant in the world. — bassim
Button: Fork on GitHub

Strip, **next**: A vault for its logins. More modular. More portable.

## Footer

- Open source under MIT.
- github.com/AVGVSTVS96/hex
