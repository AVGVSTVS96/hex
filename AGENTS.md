# Working on hex

This repo is hex itself. A user's hex is a folder of their own (`~/hex`) with this repo cloned inside it as `.hex/`; their sessions run in that folder, never in here.

- `HEX.md` is how the assistant works. Each user's `AGENTS.md` imports it, so write it to the assistant, in the user's voice.
- `defaults/` seeds a new user's folder (`bin/hex init`). Updates never touch those files once they exist, so anything every hex must get belongs in `HEX.md`, `plugin/` or `bin/`.
- Memory is [OptMem](https://github.com/VictorTaelin/OptMem): `bin/optmem` downloads the pinned version into `vendor/` at init and on every update. It has no license, so it's never committed here.
- `plugin/` holds the hooks every session loads; `mods/scheduler` runs `schedules.json` in General only. `bin/session` is how the hub starts a session.
- `computer/setup` turns a fresh Fly.io Sprite into hex's own computer (XFCE, Chrome, cua-driver, a noVNC viewer), run inside it with `sprite exec`.
- `vault/` is the vault behind `bin/vault`: `convex/` is the relay and the page people type secrets into (deploy it with `npx convex deploy` from `vault/`), and `relay` and `store` are the default plugins. Nothing readable ever reaches the relay.
- `channels/` is a fork of Anthropic's plugin marketplace, rebuilt daily from upstream plus `channels/patches/`. Change it there: edit the code, update the patch's `PATCH.md`, run `python3 scripts/fork_sync.py refresh --source-sha <baseline>` and `scripts/verify`.
- `media/` makes videos in the site's look from HTML (`media/README.md`). It shares `site/`'s fonts and icon; keep its colors and its app mocks (`media/kit/apps.css`) in step with `site/style.css`.
- Nothing personal goes in this repo: no names, accounts, machines or memories.
