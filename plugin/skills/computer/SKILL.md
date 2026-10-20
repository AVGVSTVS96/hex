---
name: computer
description: Drive hex's own computer, a Fly.io Sprite with a Linux desktop and Chrome, through cua-driver. Use when a task needs a real browser or desktop, like signing in to a site, filling a form or checking a page as a person would.
---

# Your computer

If I've given you a computer of your own, it's a Fly.io Sprite named in `AGENTS.md` (`HEX_COMPUTER` in settings), a Linux desktop with Chrome. Drive it with cua-driver:

```sh
sprite exec -s <name> -- env DISPLAY=:1 /home/sprite/.local/bin/cua-driver call get_desktop_state '{"screenshot_out_file":"/tmp/screen.png"}'
sprite file pull -s <name> /tmp/screen.png /tmp/screen.png
```

`cua-driver list-tools` and `describe <tool>` cover the rest. Copy screenshots out with `sprite file pull`, not through `exec`'s output. The Sprite sleeps about 30 seconds after your last command, so for longer work hold it awake, then delete the task:

```sh
sprite exec -s <name> -- sprite-env curl -X POST /v1/tasks -H 'Content-Type: application/json' -d '{"name":"work","expire":"30m"}'
sprite exec -s <name> -- sprite-env curl -X DELETE /v1/tasks/work
```

Sign-ins type their passwords and codes with `.hex/bin/vault fill` (the `vault` skill), so you never read them.
