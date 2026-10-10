# hex landing page copy

Final copy. Use it word for word. Text in `code` is shown as code. Notes in *(italics)* are for the designer, not the page. Anything marked **coming** isn't built yet and has to look it on the page (dashed, muted, with a small "coming" tag).

Every section is one headline, one short line and a visual. Let the visuals explain; keep captions to one line.

## Page

- `<title>`: hex · The best personal assistant is already on your machine
- Meta description: Claude Code is the best personal assistant there is. It's just been busy writing code. hex is the thin layer that points it at your life: about 1,400 lines plus its connectors, on the Claude plan you already pay for.

## Hero

- Sticker: Built on Claude Code
- Hero line: The best personal assistant is already on your machine.
- Sub line: It's just been busy writing code.

*(The hero is one glance: sticker, three-line headline, one short sub line, two buttons. The stats right under it carry the price.)*
- Primary CTA: Install
- Secondary CTA: View on GitHub

*(Telegram phone mock, as Telegram looks on iOS 26: dark, with Liquid Glass header pills, topic bar and composer. "find 3 ramen spots open tonight near Terra Gallery, make a page comparing them and deploy it" → "On it. Opened #ramen-tonight." → "It's live." with a link preview of ramen-tonight.vercel.app.)*

## Stats

- ~1,400 · lines of hex, plus ~4,200 in connectors. Claude Code does the rest.
- $0 · extra, on the Claude plan you already pay for.
- Any · client: Telegram, Discord, Buzz, or one you build.
- 0 · frameworks, 0 databases. Just plain files you own.

## Link preview

*(og.html beside og.png, 1200×630, rendered with brand-it's shoot.mjs. The hero as on the page, then four stat blocks. No competitor names here.)*

- ~1,400 · lines of hex itself
- $0 · extra on your Claude plan
- Any · client, or build yours
- 0 · frameworks, plain files

## A note from bassim

*(Bassim's handwritten note from the top of the README, in his words: lowercase, as written. A ruled paper card in Caveat with a pink "a note from bassim" sticker, a strip of tape, a slight tilt and the hard shadow. The paper stays paper in dark mode. "my version" is bold italic with a yellow marker swipe; "auto-maintained fork" links to https://github.com/AVGVSTVS96/claude-plugins-official.)*

Sticker: a note from bassim

built in 6 hours at the Personal Agents Hackathon because I wasn't happy with all the other options, this is ***my version*** of the personal assistant

- as simple, elegant, portable, and modifiable as humanly possible
- more capable than any other assistant on the market (Dots, Instinct, Grok Bot, Hermes, OpenClaw)
- clean and solid foundation to build on, claude code updates immediately benefit hex with no modification
- relies on an [auto-maintained fork](https://github.com/AVGVSTVS96/claude-plugins-official) of Anthropic's telegram + discord connectors which support multiple threads per channel

collectively, we still have a lot of work to do before we figure out the "right" way to build these products

while hex will serve as my sandbox for ongoing experimentation and testing, it's packaged as a complete product and can be installed and iterated on with ease

please join me in my quest to build the perfect assistant with as few moving parts as possible!

— bassim

## The bet

Section title: Everyone's building an agent. We plugged into the best one.
Line: Claude Code is the most capable agent around. hex points it at your life.

### Size strip

Label: Lines of source

*(Bars on one linear scale. hex's bar is a sliver.)*

- OpenClaw · 4 million+
- Hermes Agent · 1.5 million
- NanoClaw (the minimal one) · 47,000
- hex · ~1,400*

Fine print: * Plus ~4,200 lines of connectors for Telegram, Discord and Buzz, left out like NanoClaw's chat adapters. Tests, docs and generated code excluded. Counted Oct 2026. Even the minimal one is 33x bigger.

*(Both are counted the same way: every line (`wc -l`, comments and blanks included) of what it runs, without tests, Markdown, lockfiles or this site. hex is the files in bin/, plugin/, mods/, computer/ and vault/, the JSON in defaults/, and the hub; on Oct 10 2026 (main at ffccf30, channels at 5db7131) that's 1,394: 707 in bin/plugin/mods/computer/defaults, 327 in vault/, 360 in the hub. Its connectors are the Telegram, Discord and Buzz TS files: 4,165 (Telegram 1,123, Discord 982, Buzz 2,060). NanoClaw is src/ and container/ at commit af699e7 (Oct 9): 47,198 lines in 313 files. Its chat adapters copy in from a separate `channels` branch and its setup/ wizard (19,495) isn't counted either, so its number is rounded down and generous. hex's is rounded up. 47,000 / 1,400 = 33.6, shown as 33x. Bar widths keep the old scale (a full bar is 4.39 million lines). OpenClaw and Hermes weren't recounted.)*

### Next to the minimal one

*(A plain three-column ledger under the size strip, aligned to the bars: row label, NanoClaw muted, hex in ink. Same state, like for like.)*

- Runs Claude · through the Agent SDK, each agent in its own container · as Claude Code itself, the one you already use
- Keeps state · in a SQLite database · in plain files, in a git repo you own
- Guardrails · a wall: every agent in a container · at the edges: who can reach it, what it can send, secrets it never sees

*(NanoClaw: README "runs agents securely in their own containers", better-sqlite3 in src/db, @anthropic-ai/claude-agent-sdk in container/agent-runner. hex: only you can message the bot, send-gate holds sends and deletes until your yes, the vault keeps secrets out of chat and the model.)*

### Layer stack

*(Three stacked layers: a thin one on top, a thick one in the middle, the model at the bottom. Three points beside it.)*

- hex · ~1,400 lines · phone · computer · memory · vault · hub
- Claude Code · the best agent harness · reasoning, tools, MCP, skills, subagents, computer use
- Opus 5.5 · the best agent model

Points:
*(One point per layer, top to bottom: hex, Claude Code, the model.)*

- Super minimal, super light, super snappy.
- Why rebuild what Anthropic ships every week?
- Claude models are the best personal assistant models, period. Everything else is cope.

Band, in Bassim's words: The very best personal assistant is the one that does the very least while adding the very most capability. *("while adding the very most capability." in yellow.)*

## One bot, a whole crew

Section title: One bot. A whole crew.
Line: Every topic and thread gets its own Claude Code session, all on one hub built on Anthropic's own channel plugins.

### Diagram labels

- Telegram · your pocket
- Discord · your desk
- Buzz · your workspace
- Your own · your agent builds it *(dashed box and dashed wire: optional, yours to add)*
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

## Clients

*(Bassim: "works with your client. pick a client, couple prebuilt connectors, or tell your agent to build your own. offer prompts." Never frame these as "three front ends".)*

Section title: Works with your client.
Line: Pick a ready one, or tell your agent to build yours. hex connects them all.

**Telegram** · Your pocket.
- Every topic is its own session
- Voice notes in, short answers out
- It speaks up when something needs you

Bridge: take this to Discord or Buzz

**Discord** · Your desk.
- Tag it, and it opens a thread
- Room for code, logs and long answers
- Channels group work by area

**Buzz** · Your workspace. *(Next to Discord: the two desk apps sit side by side under Telegram's full-width row and the bridge. Mock: a thread on the left, Buzz Desktop's Activity / Memory / Files panel on the right.)*
- Watch it work, step by step
- Edit its memory and files
- Shared with people and agents

**Your own** · Tell your agent. *(Full-width row under Discord and Buzz on a dot grid, dashed tag. Chips pick the app and swap it into the prompt; Copy copies it.)*
- Same hub, same sessions, same memory
- Pick an app, paste the prompt
- Buzz was built this way

Chips: Slack (thread) · WhatsApp (chat) · Signal (chat) · Matrix (room)

Prompt: `Build me a Slack channel on your hub, modeled on your Discord one, so every Slack thread is its own session.`

Strip, **coming**: A ready-made iMessage client, and checking on any thread from any app.

## Basics

Table stakes too: an hourly check that stays quiet unless something needs you, schedules in one JSON file, voice notes.

## Yours

*(The theme of the page: hex is modifiable, extensible and yours, the way pi is the coding agent that's yours.)*

Section title: There are many assistants. This one is yours. *("yours." highlighted)*
Line: About 1,400 lines you can read in an afternoon, in a folder you own. Change it, extend it, fork it.

1. **Ask it to change itself**: It edits its own rules, schedules and memory, and commits every change. *(Terminal: you "no check-ins on weekends" → hex "edited schedules.json" → committed ✓)*
2. **Extend it with anything**: Whatever Claude Code can load, hex can use. *(Chips: skills, MCP, plugins, hooks, channels, + yours dashed)*
3. **A folder you own**: Plain files in your own repo. Updates never touch them. *(Terminal: ~/hex/ your git repo · SOUL.md who it is · MEMORY.md what it knows · .hex/ hex, updated)*

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
Line: Fork it. Try your ideas. Send back what works. *(Short on purpose: the note up top already says the rest and carries his signature.)*
Button: Fork on GitHub

Strip, **next**: More modular. More portable. *(The vault shipped Oct 8.)*

## Footer

- Open source under MIT. Yours to fork.
- github.com/AVGVSTVS96/hex
