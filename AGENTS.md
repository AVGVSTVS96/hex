# Working on hex

This repo is hex itself. A user's hex is a folder of their own (`~/hex`) with this repo cloned inside it as `.hex/`; their sessions run in that folder, never in here.

- `HEX.md` is how the assistant works. Each user's `AGENTS.md` imports it, so write it to the assistant, in the user's voice.
- `defaults/` seeds a new user's folder (`bin/hex init`). Updates never touch those files once they exist, so anything every hex must get belongs in `HEX.md`, `plugin/` or `bin/`.
- `plugin/` holds the hooks every session loads; `mods/scheduler` runs `schedules.json` in General only. `bin/session` is how the hub starts a session.
- `channels/` is a fork of Anthropic's plugin marketplace, rebuilt daily from upstream plus `channels/patches/`. Change it there: edit the code, update the patch's `PATCH.md`, run `python3 scripts/fork_sync.py refresh --source-sha <baseline>` and `scripts/verify`.
- Nothing personal goes in this repo: no names, accounts, machines or memories.
