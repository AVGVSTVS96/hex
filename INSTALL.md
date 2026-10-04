# Installing hex

These steps are written for a coding agent (Claude Code, Codex, …) setting hex up for its user. Follow them in order. Steps marked **(you)** need the person: tell them exactly what to do, then wait for them to confirm.

hex needs an always-on Linux machine with systemd: a home server or a cloud VM. Run everything below on that machine, as the user hex will run as.

## 1. Check what's there

`git`, `curl`, `jq`, `bun` and `claude` must be on the `PATH`, and `systemctl --user status` must work.

- Missing `bun`: install it from https://bun.sh.
- Missing `jq`: install it with the system package manager, after asking.
- Missing `claude`: install Claude Code from https://claude.com/claude-code. The person signs in by running `claude` once **(you)**.

hex lives at `~/hex`. If that path already exists, stop and ask.

```sh
git clone --recurse-submodules https://github.com/AVGVSTVS96/hex ~/hex
```

## 2. Make the Telegram bot and group (you)

1. In Telegram, open **@BotFather**, send `/newbot`, and copy the token it gives you.
2. Create a new group, open its settings, and turn on **Topics**.
3. Add the bot to the group and make it an admin with **Manage Topics**. hex opens a topic for each piece of work it starts.
4. Send any message in the group's **General** topic.

## 3. Connect hex to the group

Write the token to `~/hex/.env`, copied from `.env.example`, and `chmod 600` it.

Find the group and the person with the bot's recent updates. The hub isn't running yet, so nothing else is reading them:

```sh
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
  | jq '.result[].message | select(.chat.is_forum) | { chat: .chat.id, title: .chat.title, from: .from.id, name: .from.first_name }'
```

- Set `ASSISTANT_MAIN_THREAD` in `.env` to the group's `chat` id. It starts with `-100`.
- Only the person may talk to hex. Write their `from` id to `~/.claude/channels/telegram-hub/access.json` as `{ "allowFrom": ["<from id>"] }`, and make that directory `chmod 700`.

If nothing shows up, the bot isn't an admin yet or the message was sent before it joined. Ask them to send another one.

## 4. Install the Telegram channel

The channel and its hub live in `~/hex/channels`, a fork of Anthropic's official plugin marketplace:

```sh
claude plugin marketplace add ~/hex/channels
claude plugin install telegram@assistant
```

## 5. Trust the folder (you)

hex starts its sessions in `~/hex`, and Claude Code only runs there once the folder is trusted. Ask the person to run `cd ~/hex && claude`, accept the trust prompt, then quit with `/exit`.

## 6. Start it

```sh
systemctl --user link ~/hex/system/hex-hub.service ~/hex/system/hex.service
systemctl --user enable --now hex-hub hex
```

To keep hex running after the person logs out, run `loginctl enable-linger "$USER"`. Some systems need `sudo` for this; ask first.

Check that it's up:
- `systemctl --user status hex-hub hex`: both are active.
- `claude agents --json | jq '.[] | select(.name == "hex")'`: shows a session with a `pid`.

## 7. Make it theirs

- Ask their name, what they do, and anything they want hex to know from day one. Write it in `~/hex/MEMORY.md` under `## Me`, one fact per line.
- **Voice notes (optional):** `bin/transcribe` works with any OpenAI-compatible `/v1/audio/transcriptions` endpoint: a hosted API, or a local speech-to-text server. Search the web for the current best option, suggest one, and if they agree, set `TRANSCRIBE_URL` (the full endpoint URL), `TRANSCRIBE_MODEL` and, if needed, `TRANSCRIBE_API_KEY` in `.env`.
- **Email (optional):** the heartbeat reads mail through whatever mail connector Claude Code has, such as Gmail at claude.ai → Settings → Connectors.

## 8. Say hi (you)

Ask them to say hi in General. hex should answer within a few seconds. Then show them what hex does on its own: ask for something worth its own thread (for example "research X and keep me posted") and a new topic will appear with a session working on it.

## Updating

`~/hex/bin/update` pulls hex, then moves the channel to the fork's latest `main`, but only after its `scripts/verify` passes, and restarts the hub. To make it run daily, add it to `schedules.json`.
