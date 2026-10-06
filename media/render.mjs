import { createServer } from "node:http"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { extname, join } from "node:path"
import { spawn } from "node:child_process"
import puppeteer from "puppeteer-core"

const [video, mode = "video", ...rest] = process.argv.slice(2)
if (!video || !existsSync(join(import.meta.dirname, video, "index.html"))) {
  console.error("usage: node render.mjs <video> [serve | stills <t…> | audio [music cues] | video [fps] | all]")
  process.exit(1)
}

const root = join(import.meta.dirname, "..")
const out = join(import.meta.dirname, "out", video)
await mkdir(out, { recursive: true })

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wav": "audio/wav", ".png": "image/png" }
const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html")))
    const body = await readFile(path)
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
    args: ["--force-color-profile=srgb", "--hide-scrollbars"],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  await page.goto(url, { waitUntil: "networkidle0" })
  await page.evaluate(() => document.fonts.ready)
  const end = await page.evaluate(() => window.END)

  const shot = async t => {
    await page.evaluate(t => window.seek(t), t)
    return page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1920, height: 1080 } })
  }

  const ffmpeg = args => {
    const child = spawn("ffmpeg", ["-y", "-hide_banner", ...args], { stdio: ["pipe", "inherit", "pipe"] })
    let log = ""
    child.stderr.on("data", d => (log += d))
    const done = new Promise((resolve, reject) => child.on("close", code => (code ? reject(new Error(log)) : resolve(log))))
    return { stdin: child.stdin, done }
  }

  const audio = async (music = 1, cues = 4) => {
    await page.mouse.click(1, 1)
    const stems = await page.evaluate(() => window.soundtrack())
    for (const [name, data] of Object.entries(stems)) await writeFile(join(out, `${name}.wav`), Buffer.from(data, "base64"))
    const inputs = ["-i", join(out, "music.wav"), "-i", join(out, "cues.wav")]
    const mix = `[0]volume=${music}[m];[1]volume=${cues}[c];[m][c]amix=inputs=2:normalize=0`
    const stats = await ffmpeg([...inputs, "-filter_complex", `${mix},ebur128`, "-f", "null", "-"]).done
    const loudness = Number(stats.match(/I:\s+(-?[\d.]+) LUFS/g).at(-1).match(/-?[\d.]+/)[0])
    await ffmpeg(["-loglevel", "error", ...inputs, "-filter_complex", `${mix},volume=${-14 - loudness}dB,alimiter=limit=0.89:level=false`, join(out, "soundtrack.wav")]).done
    console.log(`soundtrack: ${loudness} → -14 LUFS`)
  }

  const render = async (fps = 60) => {
    const sound = join(out, "soundtrack.wav")
    const { stdin, done } = ffmpeg([
      "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
      ...(existsSync(sound) ? ["-i", sound] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
      "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", join(out, `${video}.mp4`),
    ])
    const frames = Math.round(end * fps)
    for (let i = 0; i < frames; i++) {
      if (!stdin.write(await shot(i / fps))) await new Promise(r => stdin.once("drain", r))
      if (i % fps === 0) process.stdout.write(`\r${i / fps}s / ${end}s`)
    }
    stdin.end()
    await done
    console.log(`\n${join(out, `${video}.mp4`)}`)
  }

  if (mode === "stills") for (const t of rest.map(Number)) await writeFile(join(out, `${t.toFixed(2)}.png`), await shot(t))
  if (mode === "audio" || mode === "all") await audio(...rest.map(Number))
  if (mode === "video") await render(...rest.map(Number))
  if (mode === "all") await render()

  await browser.close()
  server.close()
}
