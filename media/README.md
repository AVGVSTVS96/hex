# media

Videos in hex's look, made from HTML. Each video is a page of timed scenes. Headless Chrome renders it frame by frame, and the soundtrack is synthesized from the same page, so picture and sound can't drift apart.

```
media/
  kit/
    stage.css   tokens, the 1920×1080 stage, rails, keyframes, tags
    stage.js    the timeline: shows scenes, seeks every animation, springs from Motion, counters
    apps.css    Telegram (iOS 26), Discord and Buzz, drawn like the real apps
    apps.js     fills in each app's standard parts, so a scene only writes the conversation
    sound.js    sound effects from data-cue (cuelume), the shared room, the WAV encoder
  launch/       the launch video: index.html, launch.css, music.js
  render.mjs
```

Fonts and the icon come from `site/`, so the videos and the site stay one design. The colors in `kit/stage.css` mirror `site/style.css`.

## Make a video

```sh
cd media && npm install
node render.mjs launch serve           # watch it live; click to play with sound, ?t=12 to jump
node render.mjs launch stills 12 30.5  # PNGs of single moments, in out/launch/
node render.mjs launch audio           # soundtrack.wav: music and effects, mixed to -14 LUFS
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
<div class="bz-win" data-channel="team"><div class="bz-main"><div class="bz-feed">…</div></div><div class="bz-panel">…</div></div>
```

## Sound

Effects come from [cuelume](https://github.com/danielwh2/cuelume). Put the cue on the element it belongs to, and it plays when that element starts animating:

```html
<div class="msg a" style="--d:1" data-cue="tap emphasis=subtle">…</div>
<b class="imsg a" data-cue="attention">iMessage.</b>
```

- Each cue sits where its element is on screen (and follows it if it moves), out of the bass, in the same room as the music.
- Use them sparingly: one for a moment that matters, not one per item. `volume=` sets its tier: 1 for the one or two big moments, about .5 for a tap or a toggle, about .35 for a whoosh.

Music is a function per video (`launch/music.js`) that builds the track in Web Audio. It finds its sections from elements marked `data-music`, so a drop or a breakdown stays on its cut when scenes move. The launch track runs at 120 BPM in C major, the key cuelume's cues are pitched in, so every chime lands in tune. Cuts on half seconds land on the beat.

`audio` glues the music, tucks it under the bigger effects, sets the effects a fixed level over the music (`audio 11` is the default, in dB), and masters to -14 LUFS with true peaks under -2 dB.
