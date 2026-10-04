<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-light.svg">
    <img src="assets/logo.svg" alt="hex" height="72">
  </picture>
</p>

<p align="center">A personal assistant that lives in your Telegram, built on Claude Code.<br><a href="https://hex-sand.vercel.app">hex-sand.vercel.app</a></p>

---

> **9:28am** · a Waymo receipt lands in my inbox.
> **12:45pm** · hex, unprompted: *"Saw a Waymo receipt from 9:28, so I'm guessing you made it to the hack. Submissions close at 4:30, about 3h45m from now. If you want help, just say so."*

hex runs on your own always-on Linux box, with your own Claude subscription. It's a handful of plain files around Claude Code: no framework, no database, and no server of its own beyond one Telegram connection.

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

- **Every topic is its own Claude Code session.** General is the main assistant. When it starts something you'll want to follow, it opens a new topic with a fresh session working on it, and closes the topic when the work is done. Idle sessions stop and come back when you write.
- **It speaks up on its own, but only when it matters.** Every hour it runs a heartbeat: your email, the work it started, threads waiting on you, things it promised to follow up on. If nothing's worth your time, it stays quiet.
- **Schedules are a JSON file.** `schedules.json` maps names to a cron line and a prompt. A small Claude Code mod fires them, and only while the assistant is idle.
- **Memory is files you can read.** `SOUL.md` is who it is, `MEMORY.md` is what it knows about you, `AGENTS.md` is how it works. hex edits them itself as it learns. Every conversation is saved as markdown in `log/`, and General picks up each new session where the last one ended.
- **Voice notes** work with any OpenAI-compatible speech-to-text endpoint, hosted or local.

## Install

You need an always-on Linux machine with systemd (a home server or a small cloud VM) and a Claude subscription. Paste this into Claude Code on that machine:

```
Set up hex for me: https://github.com/AVGVSTVS96/hex. Follow INSTALL.md in that repo.
```

Your agent does the setup. You only do the parts nobody else can: create a bot with @BotFather, make a Telegram group with Topics turned on, and say hi. The full steps are in [INSTALL.md](INSTALL.md).

## What's inside

```
hex/
├── SOUL.md  MEMORY.md  AGENTS.md   who it is, what it knows, how it works
├── schedules.json                  recurring jobs, heartbeat included
├── bin/
│   ├── hex                         starts General as a background session
│   ├── handoff                     hands General the end of its last conversation
│   ├── log                         saves each conversation to log/ as markdown
│   ├── transcribe                  voice notes → text
│   └── update                      pulls updates, verified before they go live
├── mods/scheduler/                 fires schedules.json while the session is idle
├── system/                         two systemd user services
└── channels/                       the Telegram channel and hub (submodule)
```

`channels/` is [a fork of Anthropic's official plugin marketplace](https://github.com/AVGVSTVS96/claude-plugins-official). Its patches add one bot connection that serves every forum topic, and a hub that gives each topic its own session. The fork maintains itself. Every day a pipeline re-applies the patches onto the latest upstream, Claude fixes any conflicts, and the result is only published once `scripts/verify` passes. `bin/update` checks it again before your hub restarts on it.

## Principles

- **Real events, not timers.** Schedules wait until the assistant is idle. Sessions stop when the hub sees them go idle and start again when you write.
- **Plain files over infrastructure.** Everything hex knows lives in markdown you can open, edit and grep.
- **Your machine, your account.** Nothing runs anywhere you don't control.

## Next

Discord, as its own surface. Telegram is the assistant in your pocket; Discord is a teammate in shared channels, with its own sessions and its own context.

## License

[MIT](LICENSE)
