# Telegram

A fork of the official Telegram channel where every forum topic in a group is its own Claude Code session. Its intent, invariants and what changed from upstream live in the old fork's [`telegram-topics/PATCH.md`](https://github.com/AVGVSTVS96/claude-plugins-official/blob/989adf98ed3ebfeb225b27635853be59d62b0b1f/patches/telegram-topics/PATCH.md).

- `bot.ts` holds the one bot connection. It runs in the hub service (`bun hub/serve.ts`) next to Discord, so a conversation can move between them. It starts sessions in `HEX_DIR` (the service's folder by default) through `HEX_LAUNCHER` (`claude` by default).
- `channel.ts` is the channel the hub serves each session over HTTP, so no process runs per session. `.mcp.json` points a session at the hub's port (`HEX_PORT`) with its topic (`HEX_THREAD`) and the hub's token (`HEX_TOKEN`, as `Authorization`) in headers.

The bot token lives in `~/.claude/channels/hex/telegram/.env` as `TELEGRAM_BOT_TOKEN=…`, and `access.json` there holds `allowFrom`, the Telegram user ids allowed to talk to it. In a thread with a session, `/model` and `/effort` set what its next message starts with, and any other `/command` runs in the session as Claude Code's slash command (once the thread isn't working).
