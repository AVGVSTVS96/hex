# media

Videos in hex's look, made from HTML. Each video is a page of timed scenes. Headless Chrome renders it frame by frame, and the soundtrack is synthesized from the same page, so picture and sound can't drift apart.

```
media/
  kit/
    stage.css   tokens, the 1920×1080 stage, rails, the animation system, Telegram phone, tags
    stage.js    the timeline: shows scenes, seeks every animation, rolls counters
    sound.js    sound effects from data-cue (cuelume), the WAV encoder
  launch/       the launch video: index.html, launch.css, music.js
  render.mjs
```

Fonts and the icon come from `site/`, so the videos and the site stay one design. The colors in `kit/stage.css` mirror `site/style.css`.

## Make a video

```sh
cd media && npm install
node render.mjs launch serve           # watch it live; click to play with sound, ?t=12 to jump
node render.mjs launch stills 12 30.5  # PNGs of single moments, in out/launch/
node render.mjs launch audio           # soundtrack.wav: music, effects, mixed to -14 LUFS
node render.mjs launch video           # launch.mp4 at 60fps, with the soundtrack if there is one
node render.mjs launch all             # audio, then video
```

A new video is a new folder with an `index.html` like `launch/`. Rendering needs Chrome and ffmpeg (`CHROME=/path/to/chrome` if it isn't at `/usr/bin/google-chrome-stable`).

## Timing

A scene runs from `data-s` to `data-e` seconds. Anything with class `a` animates once, at the scene's start plus `--d`:

```html
<section class="scene" data-s="9.5" data-e="15.5" data-theme="cream">
  <span class="m"><b class="a" style="--d:1">Claude Code</b></span>
</section>
```

- `--k` picks the keyframes (`rise` by default: a line coming up out of an `.m` mask), `--dur` the length.
- Themes are `cream`, `blue` and `black`.
- Moving a scene moves everything in it, sound included.

## Sound

Effects come from [cuelume](https://github.com/danielwh2/cuelume). Put the cue on the element it belongs to, and it plays when that element starts animating:

```html
<b class="a" style="--d:2" data-cue="tap">Your Claude Max plan</b>
<svg class="a" data-cue="success emphasis=strong">…</svg>
```

Music is a function per video (`launch/music.js`) that builds the track in Web Audio. It finds its sections from scenes marked `data-music`, so a drop or a breakdown stays on its cut when scenes move. The launch track runs at 120 BPM: cuts on half seconds land on the beat.
