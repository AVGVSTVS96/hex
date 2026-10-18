# Working on hex

This repo is hex itself. A user's hex is a folder of their own (`~/hex`) with this repo cloned inside it as `.hex/`; their sessions run in that folder, never in here.

- `HEX.md` is how the assistant works. Each user's `AGENTS.md` imports it, so write it to the assistant, in the user's voice.
- `defaults/` seeds a new user's folder (`bin/hex init`). Updates never touch those files once they exist, so anything every hex must get belongs in `HEX.md`, `plugin/` or `bin/`.
- Memory is inspired by [OptMem](https://github.com/VictorTaelin/OptMem) and works like it: notes pile up in the user's `memory/`, `bin/wake` loads them as a binary tree of one-line summaries at each session start, and `bin/compacted` loads them again after a compaction. `bin/optmem` downloads the pinned OptMem into `vendor/` at init and on every update; it has no license, so it's never committed here.
- Chats work like Taelin's [OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): `bin/log` saves every message word for word to `log/`, and in a DM `bin/chat` has Haiku compress that log into the same kind of tree, so each message gets a fresh session that sees the tree's summaries instead of a history (`chat/prompt.md`).
- `plugin/` holds the hooks every session loads; `mods/scheduler` runs `schedules.json` in General only. `bin/session` is how the hub starts a session, `bin/update` ships hex and `channels/` as one pinned pair only after `bin/check` passes, and `bin/live-status` shows each session its branches, jobs and threads.
- `computer/setup` turns a fresh Fly.io Sprite into hex's own computer (XFCE, Chrome, cua-driver, a noVNC viewer), run inside it with `sprite exec`.
- `vault/` is the vault behind `bin/vault`: `convex/` is the relay and the page people type secrets into (deploy it with `npx convex deploy` from `vault/`), and `relay` and `store` are the default plugins. Nothing readable ever reaches the relay.
- `channels/` is a fork of Anthropic's plugin marketplace, rebuilt daily from upstream plus `channels/patches/`. Change it there: edit the code, update the patch's `PATCH.md`, run `python3 scripts/fork_sync.py refresh --source-sha <baseline>` and `scripts/verify`.
- `media/` makes videos in the site's look from HTML (`media/README.md`). It shares `site/`'s fonts and icon; keep its colors and its app mocks (`media/kit/apps.css`) in step with `site/style.css`.
- Nothing personal goes in this repo: no names, accounts, machines or memories.
