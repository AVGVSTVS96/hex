# hex landing page copy

The page's copy of record. `index.html` uses it word for word. Text in `code` shows as code. Notes in *(italics)* are for whoever designs the page, not for the page.

The page explains itself with pictures: every section is a headline, at most one short line, and visuals that show the real thing (app mocks that match the real apps, diagrams drawn from how hex works). Captions stay one or two short lines. No em dashes. App mocks follow the system's light or dark theme.

## Page

- `<title>`: hex · The best personal assistant is already on your machine
- Meta description: hex turns Claude Code into your personal assistant, on your own machine and the Claude plan you already pay for.
- Link preview (`og.html`, rendered to `og.png` at 1200×630): the wordmark, the hero line, "It's just been busy writing code. hex makes Claude Code your personal assistant." and the Telegram mock from the hero.

## Nav

How it works · Clients · Voice · Inside · Yours · GitHub icon · Install

## Hero

- Pill: Built on Claude Code
- Headline: The best personal assistant is already on your machine.
- Line: **It's just been busy writing code.** hex makes Claude Code your personal assistant, on the Claude plan you already pay for.
- Buttons: Install hex · View on GitHub
- Under the buttons: Telegram · Discord · Buzz · T3 Code · iikb · Voice

*(Telegram on iOS 26, matched to the real app: back pill with an unread count, the group's name pill, the group's avatar, a "Today" date pill, hex's name and admin tag on the first message of each run and its avatar on the last, bubble tails, the topic tab bar (All · General, open · ramen, which slides in with an unread badge · clips · leisure) and the composer with its / commands button. The chat: a voice note, "Done. Your 9am is at 10 now.", then "find 3 ramen spots open tonight near me, make a page comparing them and deploy it" → "On it. Opened #ramen." → "It's live." with a preview of ramen-tonight.vercel.app.)*

## Stats

- ~17,500 · lines in hex's core
- 6 · clients ready to use
- $0 · extra on your plan

## A note from bassim

*(The note from the top of the README, in his words exactly: lowercase, his spelling, plain "-" list markers. Handwritten on a plain card that follows the theme; "my version" bold italic with a marker swipe.)*

Label: a note from bassim

bootstrapped in 6 hours at the Personal Agents Hackathon because I wasn't happy with all the other options, this is ***my version*** of the personal assistant

- as simple, elegant, portable, and modifiable as possible
- more capable than any other assistant on the market (Dots, Grok Bot, Hermes, OpenClaw)
- made of pluggable parts, modules that can be interchanged and swapped
- swappable harness, hex wraps claude code currently, but hex will be portable and able to set itself up on any harness and system with ease

collectively, we still have a lot of work to do before we figure out the "right" way to build these products. there are many opportunities to reduce friction and make the experience more seamless for end users.

the most difficult part of building a proper personal assistant appears to be security, and user trust/sentiment. this is tricky, because you never solve it once. every update or improvement made needs to take security and trust implications into account.

following security and trust, this is my read on the what the remaining challenges are:
- memory and context management
- instruction/skill management (huge potential for tech debt, and over-constraint; needs constant tuning)
- harness state and persistent durable architecture
- portability and modifiability that doesn't threaten the core

hex will serve as my sandbox for ongoing experimentation and testing, but i've tried to package it as an easy install for anyone familiar with claude code

please join me in my quest to build the most minimal, capable, safe, and hackable personal assistant :)

-- bassim

## How it works

- Label: how it works
- Headline: One assistant. A session for every thread.
- Line: Every topic and thread is its own Claude Code session, with one shared memory.

*(Diagram, drawn live: clients on the left (Telegram · topics, Discord · threads, Buzz · threads, T3 Code · projects, iikb · keyboard, Voice · calls, and a dashed "Yours · build it"), wired into the hub ("hex hub · a session per thread") with `~/hex` under it (AGENTS.md, SOUL.md, memory/, hex.db), wired out to Claude Code sessions: General, #ramen-tonight, #dev › ci (idle), ~/code/app, voice (on a call). Small dots run along the wires. On phones it stacks top to bottom.)*

Three tiles under it, each a small picture and a caption:

1. **Threads run side by side.** *(Three lanes over time: working, stopped when idle, working again.)*
2. **A DM never forgets.** *(A small tree: words at the bottom, summaries above, the newest leaf highlighted.)*
3. **Threads move with you.** *(Telegram #ramen-tonight → "take this to Discord" → Discord #ramen-tonight, "same session, same history".)*

## Clients

- Label: clients
- Headline: Works with your client.

*(No client gets a role like "for work". Each card shows the real app.)*

- **Telegram**: A topic for each thing you're doing. Voice notes too. *(Telegram's topic list: General, ramen with an unread badge, clips with "hex is typing", leisure, taxes.)*
- **Discord**: Tag it and it opens a thread. Room for code and long answers. *(Discord's window: Discord home and server rail with the hex server picked, the channel list with #dev open and your user panel, "@hex why is CI red on main?" with its thread card ("3 Messages" and hex's last reply "A flaky clock in auth.spec. Fixed in PR #214."), the message box, and "hex is typing…" under it.)*
- **Buzz**: A workspace for people and agents. Watch each step as it runs. *(Buzz Desktop's window, after its own screenshots: the sidebar with channels, a DM with hex and your profile, #ops with "back up the NAS before tonight's update" → "On it. Disk checked, copying to offsite now.", the message box, and "hex: Working" under it.)*
- **T3 Code**: Pick hex as the agent in any project, memory and all. *(T3 Code's window: its thread list (one working, one done), a thread "Fix login redirect" in the app project, hex's answer with the file it edited, and the composer with hex picked as the agent.)*
- **iikb**: An iOS keyboard with your hex chats, in any app. *(iikb's Chats in its glass design, after its own screenshots: the menu button, the topic tabs, the dictation button, a short chat with tails, the message box, and the globe and mic under it.)*
- **Your own**: Ask hex to build one. Its Buzz client was built this way.
  - Chips: Slack (thread) · WhatsApp (chat) · Signal (chat) · Matrix (room). The pick swaps into the prompt.
  - Prompt: `Build me a Slack client on your hub, modeled on your Discord one, so every Slack thread is its own session.`
  - Button: Copy · after click: Copied

## Widgets

- Label: widgets
- Headline: Apps inside a message.
- Line: Live in Telegram. Tap them, they're real.

*(Three cards. Each shows one widget in an incoming Telegram bubble on the chat wallpaper, with its caption and time below it, in the chat's light or dark colors. The widgets are real widget documents, each under Telegram's size limits; the page stands in for Telegram and hex, so taps work.)*

- **A list you tick.** Tick one, and hex knows it's done.
  *(Widget: "Waiting on you", a big count, a red striped bar per open task that turns green when done, four made-up tasks. Caption: "Three things need you today.")*
- **A chart that stays current.** It updates in place, with no new message.
  *(Widget: share of the week used, sessions, a stacked bar per day by topic, a legend. Caption: "Your week so far.")*
- **A game against hex.** hex plays back in the same message.
  *(Widget: tic-tac-toe with a running score. Caption: "Tic-tac-toe. You play ×.")*

## Voice

- Label: voice
- Headline: Call it.
- Line: Talk to hex live, and it can call you too. Calls need an OpenAI key.

*(Left: how a call works, top to bottom.)*
- You · talk, interrupt, change your mind
- Voice model · talks back in real time
- Claude Code · does the work
- Chips: Browser · hex voice for iPhone · Phone calls, both ways · Discord voice

*(Right: the Tasks list in hex voice during a call on the open iPhone Duo, redrawn from the app's code (All tab, colored Needs you, Working and Done heads, a colored mark and count per row, "Go through them with hex") with made-up projects, and the call controls down the right side.)*
- **A Tasks board** of what waits on you, per project
- **Answer in place** polls and questions, without opening the thread
- **Lock Screen and Dynamic Island** the call stays one tap away
- Link: hex voice on GitHub → github.com/AVGVSTVS96/hex-voice

## Inside

- Label: inside
- Headline: It remembers, keeps track, and asks first.

- **Memory with a timeline**: It remembers what happened and when, and finds any of it word for word. *(Summaries narrowing down to one remembered line, found by `memo recall 'timer'`.)*
- **Tasks and questions**: What you ask for is kept in your words and closed with proof. Missed questions come back. *(A task card: your words quoted, done when, agents, proof link.)*
- **Agents do what you asked**: A brief that drifts from your words goes back. *("you asked" next to a brief that adds a booking; verdict "sent back · it adds a booking you didn't ask for".)*
- **Asks before it sends**: Nothing is sent or deleted without your yes. Passwords never go through chat. *(A "Send this reply?" card with Yes and No, and "Password, by link · encrypted in your browser, never in chat".)*
- **Keeps itself up to date**: Every morning, never mid-task. *(Pull · every morning → Test · 840+ tests → Wait · until no session is busy → Ship · restarts itself, and Roll back · if it won't start. The steps light up in turn.)*
- Also: **Ideas** researched on a schedule, back only with news · **Schedules** prompts that run on time · **Jobs** long work that reports back · **Holds** pause threads until a time · **Connectors** every one on your Claude account · **A computer** optional cloud desktop with Chrome · **Any Claude model** pick one per role · **`hex doctor`** checks your setup, says how to fix it · **Backups** every night

*(Don't name the computer's provider.)*

## Yours

- Label: yours
- Headline: Small enough to read. Yours to change.

*(Bars on one linear scale, so hex is a sliver, then the small end zoomed in.)*

- Label: lines of source
- OpenClaw · 5.3 million
- Hermes Agent · 1.6 million
- NanoClaw · 49,940
- hex · 17,567
- Zoomed in: NanoClaw · 49,940 / hex · 17,567 + 23,730 in clients *(clients hatched)*
- Fine print: Lines of code that runs, without tests or docs, counted Oct and Nov 2026. Like NanoClaw's, hex's count leaves out its chat clients.

*(How it's counted: `wc -l` of every file that runs, comments and blanks included, without tests, Markdown, lockfiles or the site. hex at e7fa099 (Nov 12 2026): bin 4,516, hub `*.ts` 12,814, plugin hooks 138, computer 68, defaults JSON 31, so 17,567. Its clients in channels/, `*.ts` only, so 23,730. NanoClaw is src/ and container/ at 0ede4cf (Nov 12 2026): 49,940. NanoClaw's count leaves out its chat adapters, so hex's leaves out its clients. OpenClaw (5,300,069 at e09de504) and Hermes Agent (1,597,845 at f925b017) were counted the same way in October 2026.)*

Three tiles:

1. **A folder you own.** *(Tree of ~/hex/, "yours, a private git repo": AGENTS.md your rules · SOUL.md who it is · PROACTIVE.md what it brings up on its own · schedules.json recurring jobs · memory/ what it knows · state/hex.db every message and task · .hex/ hex itself, updated every morning.)*
2. **Ask it to change itself.** *(You: "no check-ins on weekends" → schedules.json, the cron line gains `1-5` → committed.)*
3. **Fork it.** *(hex → pull → your fork → update → your hex, with a dashed pull request back.)*

Chips, under "extend it with": skills · MCP servers · plugins · hooks · connectors · clients · + yours

## Install

- Label: install
- Headline: Install with one prompt.
- Line: Paste this into Claude Code.
- Prompt: `Set up hex for me: https://github.com/AVGVSTVS96/hex. Follow INSTALL.md in that repo.`
- Button: Copy · after click: Copied
- Steps: 1 **Make a bot** with @BotFather · 2 **Make a group** with Topics turned on · 3 **Say hi** hex takes it from there
- Under: You need a machine that stays on, Claude Code and a Claude subscription.

## Footer

- Line: hex is a sandbox. Come build it.
- Button: Fork on GitHub
- *(The hex wordmark drawn from small hexagon cells on a tray. Cells light up in a sweep when it comes into view, and under the pointer.)*
- MIT · built on Claude Code · github.com/AVGVSTVS96/hex
