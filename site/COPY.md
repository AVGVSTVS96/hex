# hex landing page copy

Final copy. Use it word for word. Text in `code` is shown as code. Notes in *(italics)* are for the designer, not the page.

## Page

- `<title>`: hex · Claude Code as your personal assistant
- Meta description: hex is a personal assistant built on Claude Code. It runs on your own always-on Linux box with your own Claude subscription, and you talk to it in a Telegram group where every topic is its own session.

## Hero

- Hero line: Claude Code as your personal assistant.
- Sub line: hex runs on your own always-on Linux box, with your own Claude subscription. You talk to it in a Telegram group. It works in the background and messages you only when something matters.
- Primary CTA: Install
- Secondary CTA: View on GitHub

## The real moment

*(A Telegram chat in the General topic. All three messages are real, from the author's own hex, today. Show them as written.)*

- 12:45 · hex: Saw a Waymo receipt from 9:28, so I'm guessing you made it to the hack. Submissions close at 4:30, about 3h45m from now. If you want help with research, building, or the 2-min pitch, just say so here and I'll get started.
- 1:35 · me: *(voice message)*
- 1:35 · hex: Here's the schedule:
  • 4:30 submissions close
  • 4:45 top 6 demo (2 min + 1 min Q&A)
  • 5:25 awards
  The demo is the part you need to be there for, so be back by 4:30 at the latest. *(The real reply goes on. End it here, after "at the latest.")*
- 2:45 · hex: ⏰ Hack check: it's 2:45. Submissions close at 4:30, and the top 6 demo is at 4:45. Leave home with enough time for the Waymo to get you to Terra Gallery by 4:30.

Caption: Nobody asked for the first message. hex saw the receipt during its hourly check.

## How it works

Section title: How it works

1. **Every topic is its own session**
   General is your main assistant. When it starts work you'll want to follow, it opens a new topic with a fresh Claude Code session working there, and closes the topic when the work is done. Idle sessions stop and pick up again when you write.

2. **It speaks up when it's worth it**
   Every hour it checks your email, the work it started, topics waiting on you, and anything it said it would follow up on. If nothing needs you, you hear nothing.

3. **Schedules are a plain JSON file**
   Each job is a name, a cron line and a prompt. The hourly check is just the first one.

4. **Its memory is files you can read**
   SOUL.md is who it is. MEMORY.md is what it knows about you. AGENTS.md is how it works. hex edits them itself as it learns. Every conversation is saved as markdown, and each new session picks up where the last one ended.

5. **Voice notes**
   Send one from wherever you are. It transcribes it and answers.

6. **Keeps itself current**
   Its Telegram channel is a fork of Anthropic's official Claude Code plugins. Every day a pipeline re-applies hex's patches onto the latest version, Claude fixes any conflicts, and nothing is published unless the checks pass. Your box checks again before it updates.

## Two front ends

Section title: Two ways to work with it

Intro: hex has two front ends. They are two different ways of working, not copies of each other. One hub on your box serves both.

**Telegram** · Built and running
Your assistant in your pocket.
- General is the main assistant. Every topic is its own session.
- Short, phone-sized answers.
- It comes to you with the hourly check and reminders.

**Discord** · In progress
Tag it and it gets to work.
- Tag the bot in any channel and it starts a thread on your message, with a fresh session inside.
- Inside a thread, just talk.
- Channels group work by area, like #research and #dev. Room for longer answers, code blocks and history.

Handoff line: Each thread lives in one app. Say "take this to Discord" and the same session moves over with its memory. The Telegram topic posts a link and closes. *(Mark this line as in progress too.)*

### Diagram labels

*(Both front ends feed one hub on your box. The hub starts one Claude Code session per thread. Draw the Discord side and the handoff arrow as dashed or muted.)*

- Left, top: Telegram
  - under it: in your pocket
- Left, bottom: Discord
  - under it: in progress
- Handoff arrow, Telegram to Discord: take this to Discord
- Middle box: hex hub
  - under it: one connection per app
- Right, stacked: Claude Code session (one per thread)
- Bottom of the right side: SOUL.md · MEMORY.md · AGENTS.md · log/
- Frame around hub, sessions and files: your box

## Install

Section title: Install with one prompt
Sub line: Paste this into Claude Code on your box. It does the setup and tells you when it needs you.

Code block: `Set up hex for me: https://github.com/AVGVSTVS96/hex. Follow INSTALL.md in that repo.`

Copy button: Copy · after click: Copied

**You'll need**
- An always-on Linux box with systemd, like a home server or a cloud VM
- A Claude subscription
- Telegram

**What you do yourself**
- Make a bot with @BotFather
- Make a Telegram group with Topics turned on, and add the bot as an admin
- Say hi

## Footer

- Open source under MIT.
- github.com/AVGVSTVS96/hex
