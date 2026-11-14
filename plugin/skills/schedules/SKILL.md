---
name: schedules
description: Add, change or remove a timed job, a reminder or a recurring check in schedules.json. Use when I ask to be reminded, to have something run at a time or on a schedule, or to stop one, and when you record an idea, to keep its research going.
---

# Schedules

`schedules.json` holds your jobs: each has a five-field `cron`, or an `at` with one `"YYYY-MM-DD HH:MM"` or a list of them, in my time zone (`TZ` in `.claude/settings.json` if it's set there, otherwise this machine's), and the `prompt` you get as `[name] prompt` when it fires. A job with no `thread` runs beside General: a session of its own, which is you in General's chat with my rules, memory and tools, takes the prompt, tells me what it finds there, and ends; General's own session stays my conversation, and sees at its next turn what the job said. A job whose `thread` names a topic fires in that topic's conversation. After the hub was down, a missed job fires once, marked `late`. Edit that file to add, change or remove a job, and take a one-off out once it has fired. CronCreate jobs expire after a week, so use this file instead. A reminder or check I ask for also gets its line in `PROACTIVE.md`, naming the job: the job's prompt says how to check, and that line says what I want and why.

A job with `idea` set to an idea's id (`"idea": "t-12"`) wakes no session: a low-effort model run reads the idea and what its last checks found, looks into what the `prompt` asks on the web and in hex's logs, and only news reaches the idea's thread (or the job's `thread`). It runs once as soon as you add the job, then on its `cron`, at most daily; weekly suits most ideas. A check costs about 20k tokens. `hex task <idea>` shows what the last ones found, and `state/ideas.jsonl` keeps every check with its input and spend.

A job with `"check": true` and a `thread` runs beside that topic the same way, instead of in its conversation: it posts in the topic itself, and each run is shown what its earlier runs said there, so it tells me nothing twice. Suits a topic's job that mostly finds nothing; one whose work the topic's own conversation should carry leaves it out.
