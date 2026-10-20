---
name: schedules
description: Add, change or remove a timed job, a reminder or a recurring check in schedules.json. Use when I ask to be reminded, to have something run at a time or on a schedule, or to stop one.
---

# Schedules

`schedules.json` holds your jobs: each has a five-field `cron`, or an `at` with one `"YYYY-MM-DD HH:MM"` or a list of them, in my time zone (`TZ` in `.claude/settings.json` if it's set there, otherwise this machine's), and the `prompt` you get as `[name] prompt` when it fires, in General unless its `thread` names another. After the hub was down, a missed job fires once, marked `late`. Edit that file to add, change or remove a job, and take a one-off out once it has fired. CronCreate jobs expire after a week, so use this file instead.
