> built in 6 hours at the Personal Agents Hackathon because I wasn't happy with all the other options, this is _**my version**_ of the personal assistant
> 
> - as simple, elegant, portable, and modifiable as humanly possible
> - more capable than any other assistant on the market (Dots, Instinct, Grok Bot, Hermes, OpenClaw)
> - clean and solid foundation to build on, claude code updates immediately benefit hex with no modification
> - relies on an [auto-maintained fork](https://github.com/AVGVSTVS96/claude-plugins-official) of Anthropic's telegram + discord connectors which support multiple threads per channel
>
> collectively, we still have a lot of work to do before we figure out the "right" way to build these products
> 
> while hex will serve as my sandbox for ongoing experimentation and testing, it's packaged as a complete product and can be installed and iterated on with ease
>
> please join me in my quest to build the perfect assistant with as few moving parts as possible!
>
> 
> -- bassim

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-light.svg">
    <img src="assets/logo.svg" alt="hex" height="72">
  </picture>
</p>

<p align="center">Claude Code as your personal assistant. It runs on your own machine, and you talk to it in Telegram, Discord and Buzz.<br><a href="https://hex-sand.vercel.app">hex-sand.vercel.app</a></p>

---

hex runs wherever Claude Code does, on a machine that stays on (a home server, a Mac that doesn't sleep, a cloud VM), with your own Claude subscription, and Opus 5.5 does the thinking. It's a handful of plain files around Claude Code: no framework, no database, no service manager required. One small hub process holds the bot connections and starts a Claude Code session for each conversation.

## How it works

```
 your apps                      your machine
┌──────────────┐               ┌─────────────────────────────────────────────┐
│ Telegram     │               │                                             │
│  ├ General   │◀─────────────▶│  hub  (one connection per app)              │
│  └ trip      │               │    │                                        │
└──────────────┘               │    ├──▶ claude  "hex"      General          │
┌──────────────┐               │    ├──▶ claude  (bg)       trip             │
│ Discord      │               │    ├──▶ claude  (bg)       #dev › fix ci    │
│  └ #dev      │◀─────────────▶│    └──▶ claude  (bg)       #ops › backups   │
│    └ fix ci  │               │                                             │
└──────────────┘               │                                             │
┌──────────────┐               │                                             │
│ Buzz         │               │                                             │
│  └ #ops      │◀─────────────▶│  SOUL.md  MEMORY.md  AGENTS.md  log/        │
│    └ backups │               │                                             │
└──────────────┘               └─────────────────────────────────────────────┘
```

- **Every topic is its own Claude Code session.** General is the main assistant. When it starts work you'll want to follow, it opens a new topic with a fresh session working there, and closes the topic when the work is done. A session that sits idle for 30 minutes stops, and starts again with its conversation when you write.
- **Your hex is your own folder.** `~/hex` holds everything that's yours: `SOUL.md` (who it is), `MEMORY.md` (what's true about you now), `schedules.json`, your own rules in `AGENTS.md`, its memory and every conversation as markdown in `log/`. It's a private git repo, and hex commits its own edits. hex itself lives in `~/hex/.hex`, a clone of this repo that updates never mix with your files.
- **Memory with a timeline.** Next to `MEMORY.md`, every session notes what happened in [OptMem](https://github.com/VictorTaelin/OptMem): plain text files, read back at the start of each session, with older memories summarized and still searchable word for word. Every night hex folds the day's notes into `MEMORY.md`.
- **Works with any Claude connector.** Every connector on your Claude account works in every hex session, with nothing to set up on the machine: Gmail, your calendar, [Executor](https://executor.sh) for many accounts behind one sign-in, [AgentMail](https://agentmail.to) for an inbox of its own. Sending, replying or deleting through any of them waits for your yes.
- **It speaks up when it matters.** Every hour while you're up it checks your mail, the work it started, threads waiting on you, and anything it said it would follow up on, and only messages you if something's worth it. Other jobs are lines in `schedules.json`, a cron line and a prompt each.
- **A computer of its own (optional).** A cloud desktop with Chrome that hex drives with [cua-driver](https://cua.ai), for anything that needs a real browser, on whatever provider you like. You can watch its screen. `computer/setup` builds one on a [Fly.io Sprite](https://sprites.dev) in one command.
- **Voice notes** work with any OpenAI-compatible speech-to-text endpoint, hosted or local.

## Three front ends

hex has three front ends. They are different ways of working, not copies of each other. One hub serves all three.

**Telegram: the assistant in your pocket.** Built and running today.
- A group with Topics turned on. General is the main assistant, and every topic is its own session.
- Short, phone-sized answers.
- It comes to you: the hourly heartbeat, and reminders about anything waiting on you.

**Discord: tag it and it gets to work.** Built and running today.
- Tag the bot in any channel and it starts a thread on your message, with a fresh session working inside it. Inside a thread you just talk.
- Channels group work by area, like `#research` or `#dev`. Room for longer answers, code blocks and history.

**Buzz: a workspace you share.** Built and running today.
- [Buzz](https://github.com/block/buzz) is a workspace where people and agents share channels. Tag hex in a channel and it starts a thread with its own session, or DM it.
- Buzz Desktop shows what hex is doing as it works, step by step.
- Its memory and the files you share from your folder show up in Buzz. Edit them there and hex commits the change.

Each thread lives in one app. Say "take this to Discord" or "take this to Buzz" and the same session moves over with its memory. The old thread posts a link to the new one and closes.

## Install

You need a machine that stays on and runs Claude Code, and a Claude subscription. Paste this into Claude Code on that machine:

```
Set up hex for me: https://github.com/AVGVSTVS96/hex. Follow INSTALL.md in that repo.
```

Your agent does the setup. You only do the parts nobody else can: create a bot with @BotFather, make a Telegram group with Topics turned on, and say hi. The full steps are in [INSTALL.md](INSTALL.md).

## What's inside

```
~/hex/                              yours: a private git repo
├── AGENTS.md                       your rules; imports SOUL, MEMORY and .hex/HEX.md
├── SOUL.md  MEMORY.md              who it is, what's true about you now
├── schedules.json                  recurring jobs, the hourly check included
├── memory/  log/                   its OptMem memory, every conversation as markdown
├── .env  state/                    bot tokens, thread lists (never committed)
└── .hex/                           hex itself: this repo
    ├── HEX.md                      how it works
    ├── bin/
    │   ├── hex                     init, start, stop, restart, status; run keeps the hub up
    │   ├── session                 how the hub starts each session
    │   ├── log                     saves each conversation to log/ as markdown
    │   ├── compacted               puts memory and the last turns back after a compaction
    │   ├── send-gate               holds sends and deletes until you say yes
    │   ├── transcribe              voice notes → text
    │   └── update                  pulls updates, verified before they go live
    ├── plugin/                     the hooks every session loads
    ├── mods/scheduler/             sends schedules.json jobs to General
    ├── computer/setup              turns a Sprite into its computer
    ├── defaults/                   what `hex init` starts your folder with
    └── channels/                   the Telegram, Discord and Buzz channels and hub (submodule)
```

hex doesn't need systemd or any service manager. `hex start` runs the hub in the background, and the hub keeps General running. To have it come back after a reboot, point whatever your machine uses at `hex run`: a systemd user service, a launchd agent, a Sprite service, or an `@reboot` cron line.

`channels/` is [a fork of Anthropic's official plugin marketplace](https://github.com/AVGVSTVS96/claude-plugins-official). Its patches add one bot connection per app, serving every Telegram topic and Discord thread, a Buzz channel built the same way, and a hub that gives each thread its own session. Every day a GitHub Actions pipeline re-applies the patches onto the latest upstream, Claude fixes any conflicts, and the result is only published once `scripts/verify` passes. Every morning `bin/update` pulls hex and runs `scripts/verify` again before your hub restarts on the new channel.

## What's next

- **iMessage**, as a fourth front end.
- **Check on any thread from any app**, and keep it going from your phone.
- **A vault of its own** for the logins it uses on its computer.
- **More modular, more portable.**

hex is my sandbox. Fork it, try your ideas, and send back what works.

## Known issues

- **A project's own instructions don't load on their own.** Every hex session starts in `~/hex`, because that's what makes it hex: AGENTS.md, SOUL.md, MEMORY.md and the hooks all load from there. Claude Code only picks up a CLAUDE.md or AGENTS.md on its own inside the folder a session starts in, so when hex works in a repo somewhere else, like `~/Projects/foo`, that repo's rules go unread unless hex opens them itself. A fix is planned soon. Until then, ask hex to read the repo's AGENTS.md or CLAUDE.md before it starts.

## Principles

- **Don't interrupt.** Scheduled jobs wait their turn. The heartbeat only messages you when something needs you. Idle sessions stop and come back when you write.
- **Plain files over infrastructure.** Everything hex knows lives in markdown you can open, edit and grep.
- **Your machine, your account.** hex runs on your machine with your Claude subscription. Its memory and logs are files in your folder, and only you can talk to it.

## License

[MIT](LICENSE)
