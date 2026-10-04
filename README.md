<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-light.svg">
    <img src="assets/logo.svg" alt="hex" height="72">
  </picture>
</p>

<p align="center">Claude Code as your personal assistant. It runs on your own box, and you talk to it in Telegram.<br><a href="https://hex-sand.vercel.app">hex-sand.vercel.app</a></p>

---

> **9:28am** · I take a Waymo to the hackathon. The receipt goes to my email.
> **12:45pm** · hex, on its hourly check, without being asked: *"Saw a Waymo receipt from 9:28, so I'm guessing you made it to the hack. Submissions close at 4:30, about 3h45m from now. If you want help with research, building, or the 2-min pitch, just say so here and I'll get started."*

hex runs on your own always-on Linux box, with your own Claude subscription. It's a handful of plain files around Claude Code: no framework, no database. One small hub process holds the bot connection and starts a Claude Code session for each conversation.

## How it works

```
 your phone                     your Linux box
┌──────────────┐               ┌─────────────────────────────────────────────┐
│ Telegram     │               │  hex-hub  (one bot connection)              │
│ group        │◀─────────────▶│    │                                        │
│  ├ General   │               │    ├──▶ claude  "hex"      General          │
│  ├ research  │               │    ├──▶ claude  (bg)       research         │
│  └ trip      │               │    └──▶ claude  (bg)       trip             │
└──────────────┘               │                                             │
                               │  SOUL.md  MEMORY.md  AGENTS.md  log/        │
                               └─────────────────────────────────────────────┘
```

- **Every topic is its own Claude Code session.** General is the main assistant. When it starts work you'll want to follow, it opens a new topic with a fresh session working there, and closes the topic when the work is done. A session that sits idle for 30 minutes stops, and starts again with its conversation when you write.
- **It speaks up on its own, but only when it matters.** At :45 every hour it runs a heartbeat. It checks your email, the work it started, topics waiting on you, and anything it said it would follow up on. If nothing is worth your time, it stays quiet.
- **Schedules are a JSON file.** `schedules.json` maps a name to a cron line and a prompt. A small Claude Code mod reads it every minute and sends each job to the assistant when it's due.
- **Memory is files you can read.** `SOUL.md` is who it is, `MEMORY.md` is what it knows about you, `AGENTS.md` is how it works. hex edits them itself as it learns. `MEMORY.md` is created at install and git ignores it, so updates never touch what it knows about you. Every conversation is saved as markdown in `log/`, and each new General session starts with the end of the last one.
- **All your accounts, one sign-in.** If you use [Executor](https://executor.sh), add it once as a connector in your Claude account and hex can use everything you've connected there: GitHub, Slack, Linear and the rest. Anything Executor says needs approval, hex asks you about in Telegram first.
- **Voice notes** work with any OpenAI-compatible speech-to-text endpoint, hosted or local.

## Two front ends

hex has two front ends. They are two different ways of working, not copies of each other. One hub on your box serves both.

**Telegram: the assistant in your pocket.** Built and running today.
- A group with Topics turned on. General is the main assistant, and every topic is its own session.
- Short, phone-sized answers.
- It comes to you: the hourly heartbeat, and reminders about anything waiting on you.

**Discord: tag it and it gets to work.** In progress, not built yet.
- Tag the bot in any channel and it starts a thread on your message, with a fresh session working inside it. Inside a thread you just talk.
- Channels group work by area, like `#research` or `#dev`. Room for longer answers, code blocks and history.
- Each thread lives in one app. Say "take this to Discord" in a Telegram topic and the same session moves over with its memory. The Telegram topic posts a link to the new thread and closes.

## Install

You need an always-on Linux machine with systemd (a home server or a small cloud VM) and a Claude subscription. Paste this into Claude Code on that machine:

```
Set up hex for me: https://github.com/AVGVSTVS96/hex. Follow INSTALL.md in that repo.
```

Your agent does the setup. You only do the parts nobody else can: create a bot with @BotFather, make a Telegram group with Topics turned on, and say hi. The full steps are in [INSTALL.md](INSTALL.md).

## What's inside

```
hex/
├── SOUL.md  AGENTS.md              who it is, how it works
├── MEMORY.md                       what it knows about you (made at install, not in git)
├── schedules.json                  recurring jobs, heartbeat included
├── bin/
│   ├── hex                         starts General as a background session
│   ├── handoff                     hands General the end of its last conversation
│   ├── log                         saves each conversation to log/ as markdown
│   ├── transcribe                  voice notes → text
│   └── update                      pulls updates, verified before they go live
├── mods/scheduler/                 sends schedules.json jobs to the assistant
├── system/                         two systemd user services
└── channels/                       the Telegram channel and hub (submodule)
```

`channels/` is [a fork of Anthropic's official plugin marketplace](https://github.com/AVGVSTVS96/claude-plugins-official). Its patches add one bot connection that serves every forum topic, and a hub that gives each topic its own session. Every day a GitHub Actions pipeline re-applies the patches onto the latest upstream, Claude fixes any conflicts, and the result is only published once `scripts/verify` passes. `bin/update` pulls hex (your local edits are stashed and put back), then runs `scripts/verify` again before your hub restarts on the new channel.

## Principles

- **Don't interrupt.** Scheduled jobs wait their turn. The heartbeat only messages you when something needs you. Idle sessions stop and come back when you write.
- **Plain files over infrastructure.** Everything hex knows lives in markdown you can open, edit and grep.
- **Your machine, your account.** hex runs on your box with your Claude subscription. Its memory and logs are files on that box, and only you can talk to it.

## Next

The Discord front end and moving threads from Telegram to Discord, as described in [Two front ends](#two-front-ends).

## License

[MIT](LICENSE)
