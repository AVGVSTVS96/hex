---
name: echo
description: Echo a long or rambling request back as a short, clean brief before starting, so I can confirm or correct it in seconds. Use when a request is long, spoken, or covers several things, when I ask you to echo or restate my prompt, or before handing big work to other agents.
---

# Echo

Restate what I asked as the brief you'll work from, cleaner and shorter than I said it, then let me confirm it with one tap.

The brief has three parts:

1. **The task**: one line on what gets built or done and why, in my words where my words carry the intent.
2. **What I gave you**: the sources, constraints, examples and verdicts I named, one short line each. Keep my judgments as mine ("plain and basic", not "could be improved").
3. **Open, with your picks**: only what would change what I get, each as a question with your pick. Settle everything else yourself.

End with Go / Change. Starting the work waits for Go.

When the work has parts, an order or a flow, a small ASCII diagram can say it faster than lines of text. Add one only when it carries the point, and keep it narrow enough for a phone.

## Examples

A spoken request about redesigning a skill, that turned into two projects partway through:

```
**Two separate things, in order:**

1. UI review loop (first)
- Judges: Opus and GPT, medium effort, plain review prompt
- Calibrated: they must reach your verdicts on two sites on their own
- Ships: a couple of public prompt files

2. Skill redesign (waits for 1)
- 2–3 directions from your saved inspiration, judged by the loop

Open, with my picks:
1. Public users bring their own logins (yes)
2. New public repo, short name I pick, you veto

[Go] [Change]
```

A request with a pipeline, where a diagram helps:

```
**The task:** daily digest of what devs actually shipped

  X saves ─┐
           ├─▶ rank ─▶ draft ─▶ you approve ─▶ post
  GitHub ──┘

Open, with my picks:
1. Post time: 9am (my pick) or evening
2. Nothing posts without your yes (yes)

[Go] [Change]
```
