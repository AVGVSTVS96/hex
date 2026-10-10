# Installing hex

These steps are written for a coding agent (Claude Code, Codex, …) setting hex up for its user. Follow them in order. Steps marked **(you)** need the person: tell them exactly what to do, then wait for them to confirm.

hex runs wherever Claude Code does, on a machine that stays on: a home server, a Mac that doesn't sleep, a cloud VM. Run everything below on that machine, as the user hex will run as.

## 1. Check what's there

`git`, `curl`, `jq`, `python3`, `bun` and `claude` must be on the `PATH`.

- Missing `bun`: install it from https://bun.sh.
- Missing `jq` or `python3`: install it with the system package manager, after asking.
- Missing `claude`: install Claude Code from https://claude.com/claude-code. The person signs in by running `claude` once **(you)**.

## 2. Make their hex

A person's hex is a folder of their own, `~/hex` unless they want another place. hex itself lives inside it, in `.hex/`: a clone of the repo they pointed you to, this one or their fork, and updates pull from there. If the folder already exists, stop and ask.

```sh
git clone --recurse-submodules https://github.com/AVGVSTVS96/hex ~/hex/.hex   # or their fork
~/hex/.hex/bin/hex init
```

`init` writes their `SOUL.md`, `MEMORY.md`, `schedules.json`, `AGENTS.md`, `.env` and `.claude/settings.json`, sets up their memory in `memory/` with [OptMem](https://github.com/VictorTaelin/OptMem), and makes the folder a private git repo. Updates only ever touch `.hex/`.

## 3. Make the Telegram bot and group (you)

1. In Telegram, open **@BotFather**, send `/newbot`, and copy the token it gives you.
2. Create a new group, open its settings, and turn on **Topics**.
3. Add the bot to the group and make it an admin with **Manage Topics**. hex opens a topic for each piece of work it starts.
4. Send any message in the group's **General** topic.

## 4. Connect hex to the group

Write the token to `TELEGRAM_BOT_TOKEN` in `~/hex/.env`.

Find the group and the person with the bot's recent updates. hex isn't running yet, so nothing else is reading them:

```sh
. ~/hex/.env
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
  | jq '.result[].message | select(.chat.is_forum) | { chat: .chat.id, title: .chat.title, from: .from.id, name: .from.first_name }'
```

- Set `HEX_MAIN_THREAD` in `.env` to the group's `chat` id. It starts with `-100`.
- Only the person may talk to hex. Write their `from` id to `~/hex/state/telegram/access.json` as `{ "allowFrom": ["<from id>"] }`.

If nothing shows up, the bot isn't an admin yet or the message was sent before it joined. Ask them to send another one.

## 5. Install the channels

The Telegram, Discord and Buzz channels come from hex's own plugin marketplace:

```sh
claude plugin marketplace add ~/hex/.hex/channels
claude plugin install telegram@hex
claude plugin disable telegram@hex
```

Disabling it keeps the channel out of their other Claude Code sessions; hex turns it on for its own.

Claude Code only runs a channel from a marketplace other than Anthropic's when the machine's managed settings allow it. Add this to the managed settings file, merging with what's there: `/etc/claude-code/managed-settings.json` on Linux, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS. Writing it needs `sudo`; ask first.

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "plugin": "telegram", "marketplace": "hex" },
    { "plugin": "discord", "marketplace": "hex" },
    { "plugin": "buzz", "marketplace": "hex" }
  ]
}
```

## 6. Trust the folder (you)

hex's sessions run in `~/hex`, and Claude Code only runs there once the folder is trusted. Ask the person to run `cd ~/hex && claude`, choose **Yes, I trust this folder**, then quit with `/exit`.

## 7. Start it

```sh
~/hex/.hex/bin/hex start
~/hex/.hex/bin/hex status
```

`status` should show the hub running and a session named `hex`. The hub keeps General running and starts a session for every other thread when it's needed.

To start hex when the machine boots, have the machine run `~/hex/.hex/bin/hex run` (it stays in the foreground) with whatever it uses for that: a systemd user service with `Restart=always` plus `loginctl enable-linger "$USER"` (may need `sudo`; ask first), a launchd agent with `KeepAlive` on macOS, a Sprite service on a Fly.io Sprite, or a crontab line `@reboot ~/hex/.hex/bin/hex start`.

## 8. Make it theirs

- Ask their name, what they do, and anything they want hex to know from day one, and write it under `## Me` in `~/hex/MEMORY.md`, one fact per line.
- Ask what time zone they're in. If `date` here shows another one, set `env.TZ` in `~/hex/.claude/settings.json` to theirs (like `America/New_York`), so schedules fire on their clock. The hourly check runs from 8:45 to 22:45; if they keep other hours, change the heartbeat's `cron` in `~/hex/schedules.json`.
- **Voice notes (optional):** `.hex/bin/transcribe` works with any OpenAI-compatible `/v1/audio/transcriptions` endpoint: a hosted API, or a local speech-to-text server. Search the web for the current best option, suggest one, and if they agree, set `TRANSCRIBE_URL` (the full endpoint URL), `TRANSCRIBE_MODEL` and, if needed, `TRANSCRIBE_API_KEY` in `.env`.
- **Connectors (optional):** every connector on their Claude account works in every hex session, nothing to set up on this machine. They add them at claude.ai → Settings → Connectors **(you)**. Mail lets the hourly check read their inbox. Some that suit hex: [Executor](https://executor.sh) puts many accounts behind one connector (`https://executor.sh/mcp`), and [AgentMail](https://agentmail.to) gives hex an inbox of its own (`https://mcp.agentmail.to/mcp`).
- **A computer of its own (optional):** a [Fly.io Sprite](https://sprites.dev) with a desktop and Chrome, for anything that needs a real browser. Install the `sprite` CLI (`curl -fsSL https://sprites.dev/install.sh | sh`) and ask them to run `sprite login` **(you)**. Then:

  ```sh
  sprite create hex-computer
  sprite file push -s hex-computer ~/hex/.hex/computer/setup /home/sprite/setup
  sprite exec -s hex-computer -- sh -c '~/setup > ~/setup.log 2>&1; tail -n 8 ~/setup.log'
  ```

  It ends with `cua-driver doctor`, which should be all `[ok  ]`. If the push fails right after `create`, run it again. Write `- Agent computer: Sprite hex-computer` under `## Machines` in `~/hex/MEMORY.md`, and set `HEX_COMPUTER=hex-computer` in `~/hex/.env` so hex can sign in there with its vault. They can watch its screen from a machine with the `sprite` CLI: `sprite proxy -s hex-computer 6080`, then http://localhost:6080/vnc.html.
- **The vault** works with nothing to set up: hex sends a link, they fill it in, and it's saved encrypted in `~/hex/vault/`. The key that opens it is `~/hex/state/vault/key`; tell them to back it up somewhere safe, since git never gets it. The link goes through a relay the hex project hosts, which only ever sees encrypted data. To run their own, deploy it to their Convex account with `cd ~/hex/.hex/vault && npx convex deploy` and set `HEX_VAULT_CONVEX_URL` in `.env` to the URL it prints. `vault/README.md` explains how to swap the relay or the store for something else entirely.
- **Discord (optional):** a second app for deeper work. Tag the bot in any channel and it opens a thread with its own session. Ask them to create an application at https://discord.com/developers/applications, turn on **Message Content Intent** under Bot, copy the bot token, and invite the bot to their server with the `bot` scope and the Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History, Attach Files and Add Reactions permissions **(you)**. Then set `DISCORD_BOT_TOKEN` in `.env`, write their Discord user id to `~/hex/state/discord/access.json` as `{ "allowFrom": ["<user id>"] }`, run `claude plugin install discord@hex` and `claude plugin disable discord@hex`, then `~/hex/.hex/bin/hex restart`.
- **Buzz (optional):** [Buzz](https://github.com/block/buzz) is a workspace where people and agents share channels; hex joins as an agent and works like it does in Discord. Buzz Desktop deploys it through a provider that writes hex's Buzz key over SSH, so the computer running Buzz Desktop must reach this machine with `ssh` and a key, no password. Build the provider for that computer (`bun-darwin-arm64` for an Apple silicon Mac, `bun-darwin-x64`, `bun-linux-x64`) and copy it into its `~/.local/bin`:

  ```sh
  bun build --compile --target=bun-darwin-arm64 ~/hex/.hex/channels/external_plugins/buzz/provider.ts --outfile /tmp/buzz-backend-hex
  ```

  Run `claude plugin install buzz@hex` and `claude plugin disable buzz@hex` here. Then ask them to create an agent named hex in Buzz Desktop, pick **hex** as where it runs with this machine's SSH destination (like `user@host`), deploy it, and add it to the channels they want it in **(you)**. Deploying writes `~/hex/state/buzz/.env` and restarts the hub. Tag hex in a channel to check it answers.

## 9. Say hi (you)

Ask them to say hi in General. hex should answer within a few seconds. Then show them what hex does on its own: ask for something worth its own thread (for example "research X and keep me posted") and a new topic will appear with a session working on it.

## Updating

`.hex/bin/update` runs every morning from `schedules.json`. It pulls hex, moves the channels to the fork's latest verified version once its `scripts/verify` passes, and restarts the hub and hex's sessions.
