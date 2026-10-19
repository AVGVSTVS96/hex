# Working on hex

This repo is hex itself. A user's hex is a folder of their own (`~/hex`) with this repo cloned inside it as `.hex/`; their sessions run in that folder, never in here.

- `HEX.md` is how the assistant works. Each user's `AGENTS.md` imports it, so write it to the assistant, in the user's voice.
- `defaults/` seeds a new user's folder (`bin/hex init`). Updates never touch those files once they exist, so anything every hex must get belongs in `HEX.md`, `plugin/` or `bin/`.
- Memory is inspired by [OptMem](https://github.com/VictorTaelin/OptMem) and works like it: notes pile up in the user's `memory/`, `bin/wake` loads them as a binary tree of one-line summaries at each session start, and `bin/compacted` loads them again after a compaction. `bin/optmem` downloads the pinned OptMem into `vendor/` at init and on every update; it has no license, so it's never committed here.
- Chats work like Taelin's [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): `bin/log` saves every message word for word to `log/`, and in a DM `bin/chat` has Haiku compress that log into the same kind of tree, so each message gets a fresh session that sees the tree's summaries instead of a history (`chat/prompt.md`).
- `plugin/` holds the hooks every session loads; `mods/scheduler` runs `schedules.json` in General only. `bin/session` is how the hub starts a session, `bin/update` ships hex only after `bin/check` passes, and `bin/live-status` shows each session its branches, jobs and threads.
- `computer/setup` turns a fresh Fly.io Sprite into hex's own computer (XFCE, Chrome, cua-driver, a noVNC viewer), run inside it with `sprite exec`.
- `bin/vault` is [enclave](https://github.com/AVGVSTVS96/enclave) plus typing on hex's computer. enclave owns the relay, the page and the store; changes to them go there.
- `hub/` gives every thread its own session, and `channels/` is hex's plugin marketplace: Telegram, Discord, Buzz, T3 Code and voice, each a client of the hub. Telegram and Discord began as [Anthropic's](https://github.com/anthropics/claude-plugins-official) and no longer follow it, so an upstream fix comes in by hand: port the change into `channels/telegram` or `channels/discord` and run `bin/check`. Their history, and each change's original intent in a `PATCH.md`, is in [the old fork](https://github.com/AVGVSTVS96/claude-plugins-official).
- `media/` makes videos in the site's look from HTML (`media/README.md`). It shares `site/`'s fonts and icon; keep its colors and its app mocks (`media/kit/apps.css`) in step with `site/style.css`.
- Nothing personal goes in this repo: no names, accounts, machines or memories.
