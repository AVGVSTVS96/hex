---
name: schedules
description: Add, change or remove a timed job, a reminder or a recurring check in schedules.json. Use when I ask to be reminded, to have something run at a time or on a schedule, or to stop one, and when you record an idea, to keep its research going.
---

# Schedules

`schedules.json` holds your jobs: each has a five-field `cron`, or an `at` with one `"YYYY-MM-DD HH:MM"` or a list of them, in my time zone (`TZ` in `.claude/settings.json` if it's set there, otherwise this machine's), and the `prompt` you get as `[name] prompt` when it fires, in General unless its `thread` names another. After the hub was down, a missed job fires once, marked `late`. Edit that file to add, change or remove a job, and take a one-off out once it has fired. CronCreate jobs expire after a week, so use this file instead.

A job with `idea` set to an idea's id (`"idea": "t-12"`) wakes no session: a quick low-effort model run reads the idea and what its last checks found, looks on the web for what the `prompt` asks, and only news reaches the idea's thread. Each check costs about 10k tokens; what it found and spent is in `state/ideas.jsonl`.
