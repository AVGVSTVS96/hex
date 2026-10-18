> bootstrapped in 6 hours at the Personal Agents Hackathon because I wasn't happy with all the other options, this is _**my version**_ of the personal assistant
> 
> - as simple, elegant, portable, and modifiable as possible
> - more capable than any other assistant on the market (Dots, Grok Bot, Hermes, OpenClaw)
> - made of pluggable parts, modules that can be interchanged and swapped
> - swappable harness, hex wraps claude code currently, but hex will be portable and able to set itself up on any harness and system with ease
>
> collectively, we still have a lot of work to do before we figure out the "right" way to build these products. there are many opportunities to reduce friction and make the experience more seamless for end users.
>
> the most difficult part of building a proper personal assistant appears to be security, and user trust/sentiment. this is tricky, because you never solve it once. every update or improvement made needs to take security and trust implications into account.
>
> following security and trust, this is my read on the what the remaining challenges are:
> - memory and context management
> - instruction/skill management (huge potential for tech debt, and over-constraint; needs constant tuning)
> - harness state and persistent durable architecture
> - portability and modifiability that doesn't threaten the core
>
> hex will serve as my sandbox for ongoing experimentation and testing, but i've tried to package it as an easy install for anyone familiar with claude code
> 
> please join me in my quest to build the most minimal, capable, safe, and hackable personal assistant :)
> 
> -- bassim

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-light.svg">
    <img src="assets/logo.svg" alt="hex" height="72">
  </picture>
</p>

<p align="center">Claude Code as your personal assistant. It runs on your own machine, and you talk to it in Telegram, Discord, Buzz and T3 Code.<br><a href="https://hex-sand.vercel.app">hex-sand.vercel.app</a></p>

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
│ Discord      │               │    ├──▶ claude  (bg)       #dev › ci        │
│  └ #dev      │◀─────────────▶│    ├──▶ claude  (bg)       #ops › backups   │
│    └ ci      │               │    └──▶ claude  (bg)       ~/code/app       │
└──────────────┘               │                                             │
┌──────────────┐               │                                             │
│ Buzz         │               │                                             │
│  └ #ops      │◀─────────────▶│  SOUL.md  AGENTS.md  memory/  log/          │
│    └ backups │               │                                             │
└──────────────┘               │                                             │
┌──────────────┐               │                                             │
│ T3 Code      │               │                                             │
│  └ ~/code/app│◀─────────────▶│                                             │
└──────────────┘               └─────────────────────────────────────────────┘
```

- **Every topic is its own Claude Code session.** General is the main assistant. When it starts work you'll want to follow, it opens a new topic with a fresh session working there, and closes the topic when the work is done. A session that sits idle for 30 minutes stops, and starts again with its conversation when you write.
- **A DM is one chat that never ends.** Your DMs to hex work like Taelin's [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): every message is logged word for word in `chat/`, Haiku compresses the log into a tree of one-line summaries in the background, and each message starts a fresh session that sees those summaries instead of a history, opening any line back up to the words it came from. Nothing is compacted and nothing is lost. A message sent while hex is still working reaches that same session.
- **Your hex is your own folder.** `~/hex` holds everything that's yours: `SOUL.md` (who it is), your own rules in `AGENTS.md`, `schedules.json`, its memory and every conversation as markdown in `log/`. It's a private git repo, and hex commits its own edits. hex itself lives in `~/hex/.hex`, a clone of this repo that updates never mix with your files.
- **One memory, with a timeline.** Every session notes what it learns and what happened in [OptMem](https://github.com/VictorTaelin/OptMem): plain text files, read back at the start of each session, with older memories summarized on the spot and still searchable word for word. Your rules live in `AGENTS.md`; everything else hex knows is in OptMem.
- **Works with any Claude connector.** Every connector on your Claude account works in every hex session, with nothing to set up on the machine: Gmail, your calendar, [Executor](https://executor.sh) for many accounts behind one sign-in, [AgentMail](https://agentmail.to) for an inbox of its own. Sending, replying or deleting through any of them waits for your yes.
- **It speaks up when it matters.** Every hour while you're up it checks your mail, the work it started, threads waiting on you, and anything it said it would follow up on, and only messages you if something's worth it. Other jobs are lines in `schedules.json`, a cron line and a prompt each.
- **A computer of its own (optional).** A cloud desktop with Chrome that hex drives with [cua-driver](https://cua.ai), for anything that needs a real browser, on whatever provider you like. You can watch its screen. `computer/setup` builds one on a [Fly.io Sprite](https://sprites.dev) in one command.
- **A vault of its own.** When hex needs a password, it sends you a link. What you type there is encrypted in your browser and only hex can open it, so it never passes through chat or the model. hex signs in with it on its computer without ever seeing it.
- **Voice notes** work with any OpenAI-compatible speech-to-text endpoint, hosted or local.

## Works with your client

Pick a client that's ready, or tell your agent to build yours. Use one for everything, or one for work and another for the rest. One hub serves them all, and each is its own way of working, not a copy of the others.

**Telegram: topics and voice notes.** Built and running today.
- A group with Topics turned on. General is the main assistant, and every topic is its own session.
- Short, phone-sized answers.
- It comes to you: the hourly heartbeat, and reminders about anything waiting on you.

**Discord: tag it and it gets to work.** Built and running today.
- Tag the bot in any channel and it starts a thread on your message, with a fresh session working inside it. Inside a thread you just talk.
- Channels group work by area, like `#research` or `#dev`. Room for longer answers, code blocks and history.

**Buzz: watch it work.** Built and running today.
- [Buzz](https://github.com/block/buzz) is a workspace where people and agents share channels. Tag hex in a channel and it starts a thread with its own session, or DM it.
- Buzz Desktop shows what hex is doing as it works, step by step.
- Its memory shows up in Buzz. Browsing and editing its files there is coming soon.

**T3 Code: hex in any project.** Built and running today.
- [T3 Code](https://github.com/pingdotgg/t3code) runs coding agents, and hex is one of them: pick hex in any project and that thread is a hex session working in that project's folder, with its memory, rules and tools, T3's own included.
- T3 shows its work as it happens: every command, edit and answer, with T3's own diffs and checkpoints.
- hex reaches T3 over [ACP](https://agentclientprotocol.com): `hex acp` connects T3 to the hex that's already running.

**Your own: tell your agent.** Buzz was built this way. Swap in any app:

```
Build me a Slack channel on your hub, modeled on your Discord one, so every Slack thread is its own session.
```

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
├── AGENTS.md                       your rules; imports SOUL.md and .hex/HEX.md
├── SOUL.md                         who it is
├── schedules.json                  recurring jobs, the hourly check included
├── memory/  log/                   its OptMem memory, every conversation as markdown
├── chat/                           each DM's chat that never ends: its log, summary tree and view
├── vault/                          its saved secrets, encrypted
├── .env  state/                    bot tokens, thread lists, the vault key (never committed)
└── .hex/                           hex itself: this repo
    ├── HEX.md                      how it works
    ├── bin/
    │   ├── hex                     init, start, stop, restart, status; run keeps the hub up; acp connects T3 Code
    │   ├── session                 how the hub starts each session
    │   ├── log                     saves each conversation to log/ as markdown
    │   ├── chat                        logs a DM, compresses it, and builds what its next session sees
    │   ├── wake                    loads its memory as each session starts
    │   ├── live-status             shows its branches, upcoming jobs, sessions and each active thread's last message as each session starts
    │   ├── compacted               puts memory and the last turns back after a compaction
    │   ├── send-gate               holds sends and deletes until you say yes
    │   ├── transcribe              voice notes → text
    │   ├── vault                   asks you for secrets by link, signs in with them
    │   └── update                  pulls updates, verified before they go live
    ├── chat/prompt.md              Taelin's OptChat prompt, for DM sessions and their compactions
    ├── plugin/                     the hooks every session loads
    ├── mods/scheduler/             sends schedules.json jobs to General
    ├── computer/setup              turns a Sprite into its computer
    ├── vault/                      the vault's relay, page and default store
    ├── defaults/                   what `hex init` starts your folder with
    ├── hub/                        gives every thread its own session
    └── channels/                   the Telegram, Discord, Buzz, T3 Code and voice channels
```

hex doesn't need systemd or any service manager. `hex start` runs the hub in the background, and the hub keeps General running. To have it come back after a reboot, point whatever your machine uses at `hex run`: a systemd user service, a launchd agent, a Sprite service, or an `@reboot` cron line.

`channels/` is hex's own plugin marketplace: one bot connection per app, serving every Telegram topic, Discord thread and Buzz thread, plus T3 Code and voice calls, all through the hub in `hub/`, which gives each thread its own session. Telegram and Discord began as [Anthropic's official plugins](https://github.com/anthropics/claude-plugins-official) and were kept in step by [an auto-maintained fork](https://github.com/AVGVSTVS96/claude-plugins-official), which still has their history; they live here now, and upstream fixes come in by hand. Every morning `bin/update` pulls hex and runs `bin/check` before your hub restarts on it.

## Fork it

hex is a testbed. Let's make it better together: fork it, do what you want with it, and send back what works.

```
            pull what's new              every morning's update
this repo ─────────────────▶ your fork ───────────────────────▶ your hex
    ▲                          │    ▲
    └────── pull request ──────┘    └── your changes
```

1. **Install your fork.** Paste the prompt from [Install](#install) with your fork's URL. Your hex is a clone of the repo it was installed from, so its updates come from your fork.
2. **Change anything,** by hand or with any coding agent (`AGENTS.md` shows it around). Push to your fork, and your hex picks it up on its next update.
3. **Pull in what's new here** whenever you want: **Sync fork** on your fork's GitHub page, or `git pull https://github.com/AVGVSTVS96/hex main` and push.
4. **Send back what works.** Open a pull request that says what it does and the decisions it makes, with screenshots if it shows anything.

## What's next

- **A ready-made iMessage client.**
- **Check on any thread from any app**, and keep it going from your phone.
- **More modular, more portable.**

## Known issues

- **A project's own instructions don't load on their own.** Every hex session starts in `~/hex`, because that's what makes it hex: AGENTS.md, SOUL.md and the hooks all load from there. Claude Code only picks up a CLAUDE.md or AGENTS.md on its own inside the folder a session starts in, so when hex works in a repo somewhere else, like `~/Projects/foo`, that repo's rules go unread unless hex opens them itself. A fix is planned soon. Until then, ask hex to read the repo's AGENTS.md or CLAUDE.md before it starts.

## Principles

- **Don't interrupt.** Scheduled jobs wait their turn. The heartbeat only messages you when something needs you. Idle sessions stop and come back when you write.
- **Plain files over infrastructure.** Everything hex knows lives in markdown you can open, edit and grep.
- **Your machine, your account.** hex runs on your machine with your Claude subscription. Its memory and logs are files in your folder, and only you can talk to it.
- **Yours to change.** About 1,400 lines you can read in an afternoon. Ask hex to change itself, add any skill, MCP server or plugin Claude Code can load, have your agent build your own client, or fork the whole thing.

## License

[MIT](LICENSE)
