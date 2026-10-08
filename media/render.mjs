import { createServer } from "node:http"
import { readFile, mkdir, writeFile, rename, readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { extname, join } from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import puppeteer from "puppeteer-core"

const [video, mode = "video", ...rest] = process.argv.slice(2)
if (!video || !existsSync(join(import.meta.dirname, video, "index.html"))) {
  console.error("usage: node render.mjs <video> [serve | stills <t…> | audio [effects dB over the music at -14 LUFS] | video [fps] | all]")
  process.exit(1)
}

const root = join(import.meta.dirname, "..")
const out = join(import.meta.dirname, "out", video)
await mkdir(out, { recursive: true })

const served = new Map()
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wav": "audio/wav", ".png": "image/png" }
const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html")))
    const body = await readFile(path)
    served.set(path, body)
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body)
  } catch {
    res.writeHead(404).end()
  }
}).listen(mode === "serve" ? Number(rest[0] ?? 4321) : 0, "127.0.0.1")
await new Promise(r => server.once("listening", r))
const url = `http://127.0.0.1:${server.address().port}/media/${video}/`

if (mode === "serve") {
  console.log(`${url}  (click to play with sound, ?t=12 to start at 12s)`)
} else {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome-stable",
    headless: true,
    protocolTimeout: 0,
    args: ["--force-color-profile=srgb", "--hide-scrollbars"],
  })
  let page
  const open = async () => {
    await page?.close().catch(() => {})
    page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.goto(url, { waitUntil: "networkidle0" })
    await page.evaluate(() => document.fonts.ready)
  }
  await open()
  const end = await page.evaluate(() => window.END)
  const pageHash = [...served].sort(([a], [b]) => a.localeCompare(b)).reduce((hash, [path, body]) => hash.update(path).update(body), createHash("sha256")).digest("hex").slice(0, 12)

  const shot = async (t, retry = true) => {
    try {
      await page.evaluate(t => window.seek(t), t)
      return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1920, height: 1080 } })
    } catch (error) {
      if (!retry) throw error
      await open()
      return shot(t, false)
    }
  }

  const ffmpeg = args => {
    const child = spawn("ffmpeg", ["-y", "-hide_banner", ...args], { stdio: ["pipe", "inherit", "pipe"] })
    let log = ""
    child.stderr.on("data", d => (log += d))
    const done = new Promise((resolve, reject) => child.on("close", code => (code ? reject(new Error(log)) : resolve(log))))
    return { stdin: child.stdin, done }
  }

  const loudness = async filters => {
    const log = await ffmpeg(["-i", join(out, "music.wav"), "-i", join(out, "cues.wav"), "-filter_complex", `${filters},ebur128=peak=true`, "-f", "null", "-"]).done
    const summary = log.slice(log.lastIndexOf("Summary"))
    return { lufs: Number(summary.match(/I:\s+(-?[\d.]+)/)[1]), peak: Number(summary.match(/Peak:\s+(-?[\d.]+)/)[1]) }
  }

  const audio = async (cues = 11) => {
    await page.mouse.click(1, 1)
    const stems = await page.evaluate(() => window.soundtrack())
    for (const [name, data] of Object.entries(stems)) await writeFile(join(out, `${name}.wav`), Buffer.from(data, "base64"))
    const music = (await loudness("[0]anull")).lufs
    const mix = [
      "[0]acompressor=threshold=-18dB:ratio=2:attack=30:release=150:knee=6[glued]",
      `[1]volume=${cues + music + 14}dB,asplit[c][k]`,
      "[k]atrim=start=0.015,asetpts=PTS-STARTPTS,apad[key]",
      "[glued][key]sidechaincompress=threshold=0.025:ratio=2:attack=5:release=200[ducked]",
      "[ducked][c]amix=inputs=2:normalize=0,adelay=33:all=1",
    ].join(";")
    const master = gain => `${mix},volume=${gain}dB,aresample=192000,alimiter=limit=0.794:attack=5:release=50:level=0:latency=1,aresample=48000`
    let gain = -14 - (await loudness(mix)).lufs
    gain += -14 - (await loudness(master(gain))).lufs
    await ffmpeg(["-loglevel", "error", "-i", join(out, "music.wav"), "-i", join(out, "cues.wav"), "-filter_complex", master(gain), "-c:a", "pcm_f32le", join(out, "soundtrack.wav")]).done
    const { lufs, peak } = await loudness(master(gain))
    console.log(`soundtrack: ${lufs} LUFS, true peak ${peak} dBTP`)
  }

  const render = async (fps = 60) => {
    const parts = join(out, `parts-${fps}-${pageHash}`)
    for (const dir of await readdir(out)) if (dir.startsWith("parts-") && join(out, dir) !== parts) await rm(join(out, dir), { recursive: true })
    await mkdir(parts, { recursive: true })
    const frames = Math.round(end * fps)
    const batch = 5 * fps
    const list = []
    for (let from = 0; from < frames; from += batch) {
      const name = String(from / batch).padStart(2, "0")
      list.push(`file '${name}.mp4'`)
      if (existsSync(join(parts, `${name}.mp4`))) continue
      await open()
      const { stdin, done } = ffmpeg([
        "-loglevel", "error",
        "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
        "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-profile:v", "high",
        "-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
        "-threads", "4", join(parts, `${name}.tmp.mp4`),
      ])
      for (let i = from; i < Math.min(from + batch, frames); i++) {
        if (!stdin.write(await shot(i / fps))) await new Promise(r => stdin.once("drain", r))
        if (i % fps === 0) process.stdout.write(`\r${i / fps}s / ${end}s`)
      }
      stdin.end()
      await done
      await rename(join(parts, `${name}.tmp.mp4`), join(parts, `${name}.mp4`))
    }
    await writeFile(join(parts, "list.txt"), list.join("\n"))
    const sound = join(out, "soundtrack.wav")
    await ffmpeg([
      "-loglevel", "error",
      "-f", "concat", "-i", join(parts, "list.txt"),
      ...(existsSync(sound) ? ["-i", sound] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
      "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-shortest", "-movflags", "+faststart", join(out, `${video}.mp4`),
    ]).done
    console.log(`\n${join(out, `${video}.mp4`)}`)
  }

  if (mode === "stills") for (const t of rest.map(Number)) await writeFile(join(out, `${t.toFixed(2)}.png`), await shot(t))
  if (mode === "audio" || mode === "all") await audio(...rest.map(Number))
  if (mode === "video") await render(...rest.map(Number))
  if (mode === "all") await open().then(() => render())

  await browser.close()
  server.close()
}
