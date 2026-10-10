# media

Videos in hex's look, made from HTML. Each video is a page of timed scenes. Headless Chrome renders it frame by frame, and the sound effects are placed from the same page's timing, so picture and sound can't drift apart.

```
media/
  kit/
    stage.css   tokens, the 1920×1080 stage, rails, keyframes, tags
    stage.js    the timeline: shows scenes, seeks every animation, springs from Motion, counters
    apps.css    Telegram (iOS 26), Discord and Buzz, drawn like the real apps
    apps.js     fills in each app's standard parts, so a scene only writes the conversation
    sound.js    lists every data-cue with its time and place on screen, for the sound layer
  launch/       the launch video: index.html, launch.css, music.m4a, score.json, CREDITS.md
  delayed/      a short silent cut: an "introducing hex" that gets a record scratch when the memory piles up
  render.mjs
```

Fonts and the icon come from `site/`, so the videos and the site stay one design. The colors in `kit/stage.css` mirror `site/style.css`.

## Make a video

```sh
cd media && npm install
node render.mjs launch serve           # watch it live; click to play with sound, ?t=12 to jump
node render.mjs launch stills 12 30.5  # PNGs of single moments, in out/launch/
node render.mjs launch audio           # soundtrack.wav: music and effects, mixed to -14 LUFS (needs SOUND_LAYER)
node render.mjs launch video           # launch.mp4 at 60fps, with the soundtrack if there is one
node render.mjs launch all             # audio, then video
```

A new video is a new folder with an `index.html` like `launch/`. Rendering needs Chrome and ffmpeg (`CHROME=/path/to/chrome` if it isn't at `/usr/bin/google-chrome-stable`).

`video` encodes 5 seconds at a time, which keeps its memory flat, and keeps the parts in `out/` until the page changes. A stopped render picks up where it left off, and a new soundtrack only needs `video` again to swap the audio in seconds.

## Timing

A scene runs from `data-s` to `data-e` seconds. Anything with class `a` animates once, at the scene's start plus `--d`:

```html
<section class="scene" data-s="12" data-e="18" data-theme="cream">
  <span class="m"><b class="a" style="--d:1">Claude Code</b></span>
</section>
```

- `--k` picks the keyframes: `rise` by default (a line coming up out of an `.m` mask), `up`, `fade`, `pop` and `focus` blur in, `wipe`, `wipe-up` and `wipe-down` reveal.
- `--t` picks the timing. The springs come from [Motion](https://motion.dev) as CSS `linear()` curves and carry their own length: `var(--settle)` (the default), `var(--draw)` for lines and bars, `var(--pop)` with a little bounce, `var(--swing)` for things that travel. For a fixed length, give a duration and a curve: `.6s var(--out)`.
- `data-split=".1 .03"` sets a word in letters that rise one after another, the first at `.1`, then every `.03`.
- Themes are `cream`, `blue` and `black`.
- Moving a scene moves everything in it, sound included.

## Apps

Write the messages; `apps.js` adds the rest of each app around them.

```html
<div class="phone" data-topic="General" data-time="4:41">  <!-- status bar, glass header and composer -->
  <div class="tg-chat">…</div>
  <div class="tg-tabs glass">…</div>                        <!-- or a .tg-rail inside .phone.side -->
</div>
<div class="dc-win" data-channel="dev" data-thread="fix ci"><div class="dc-feed">…</div></div>
<div class="bz-win" data-channel="team" data-channels="general team research"><div class="bz-feed">…</div></div>
```

## Sound

The sound is mixed by [opus-sound-layer](https://github.com/Bodila51/opus-sound-layer): real CC0 recordings, each placed from the picture's own timing, over the video's music. Clone it, build its library once (`uv run scripts/sfx.py kit`), and point `SOUND_LAYER` at the clone.

Put a cue on the element it belongs to, and its sound peaks when that element starts animating:

```html
<div class="msg a" style="--d:1" data-cue="tap/kenney-impact-impact-glass-light-001">…</div>
<div class="frame end" data-cue="tap/kenney-impact-impact-glass-heavy-000 weight=hero stop_before visual=cut">…</div>
<b class="val a" data-cue="tick repeat=7 every=.14">…</b>
```

- The first word is a sound from the library (`sfx.py browse --type tap` shows the choices), or just a type. The rest are its options: `weight=hero` for the one or two big moments, `stop_before` drops the music out just before it, `build` filters the music up into it, `pitch=1` moves it a semitone into the music's key, `align=end` ends it on the cue instead of peaking there, `visual=cut|move|land` is what `qa.py` checks against the picture, and `repeat` with `every` makes a run.
- Each cue sits where its element is on screen, and the mixer sets every level against the music in that sound's own band.
- Use them sparingly: one for a moment that matters, not one per item.

`score.json` holds the rest of the cue sheet: the music, the loudness and any planned silence. The launch music (`music.m4a`) is a Suno v6 instrumental, slowed to 120 BPM and cut on its own beats so its drop lands on the reveal at 8s, its breakdowns on 33s and 74s, and its last hit on the end card. If a scene moves, recut the music to match.

`audio` writes `out/<video>/cues.json` and mixes it to -14 LUFS with true peaks under -2 dB. After `video`, check the result with the sound layer's QA: `uv run $SOUND_LAYER/scripts/qa.py out/launch/launch.mp4 --audio out/launch/sound`.
