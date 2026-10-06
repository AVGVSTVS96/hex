import { play } from "../node_modules/cuelume/dist/index.js"

export const RATE = 48000

const scenes = [...document.querySelectorAll(".scene")]
export const END = Math.max(...scenes.map(s => +s.dataset.e))
export const mark = name => +document.querySelector(`[data-music="${name}"]`).dataset.s

function cues() {
  return [...document.querySelectorAll("[data-cue]")].map(el => {
    const [name, ...pairs] = el.dataset.cue.split(" ")
    const options = Object.fromEntries(pairs.map(pair => pair.split("=")).map(([k, v]) => [k, Number.isNaN(+v) ? v : +v]))
    const style = getComputedStyle(el)
    const t = +style.getPropertyValue("--s") + +(style.getPropertyValue("--d") || 0)
    return { t, name, options }
  })
}

async function renderCues() {
  const ctx = new OfflineAudioContext(2, Math.ceil(END * RATE), RATE)
  Object.defineProperty(ctx, "state", { get: () => "running" })
  window.AudioContext = function () {
    return ctx
  }
  const quantum = 128 / RATE
  const groups = Map.groupBy(cues(), cue => Math.max(1, Math.round(cue.t / quantum)) * quantum)
  for (const [t, group] of groups)
    ctx.suspend(t).then(() => {
      for (const cue of group) play(cue.name, cue.options)
      ctx.resume()
    })
  return ctx.startRendering()
}

async function renderMusic(music) {
  const ctx = new OfflineAudioContext(2, Math.ceil(END * RATE), RATE)
  music(ctx)
  return ctx.startRendering()
}

function wav(buffer) {
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)]
  const frames = buffer.length
  const bytes = new DataView(new ArrayBuffer(44 + frames * 4))
  const text = (offset, s) => [...s].forEach((c, i) => bytes.setUint8(offset + i, c.charCodeAt(0)))
  text(0, "RIFF")
  bytes.setUint32(4, 36 + frames * 4, true)
  text(8, "WAVEfmt ")
  bytes.setUint32(16, 16, true)
  bytes.setUint16(20, 1, true)
  bytes.setUint16(22, 2, true)
  bytes.setUint32(24, RATE, true)
  bytes.setUint32(28, RATE * 4, true)
  bytes.setUint16(32, 4, true)
  bytes.setUint16(34, 16, true)
  text(36, "data")
  bytes.setUint32(40, frames * 4, true)
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < 2; c++) bytes.setInt16(44 + i * 4 + c * 2, Math.max(-1, Math.min(1, channels[c][i])) * 32767, true)
  return new Uint8Array(bytes.buffer).toBase64()
}

export function soundtrack(music) {
  window.soundtrack = async () => ({ music: wav(await renderMusic(music)), cues: wav(await renderCues()) })
}
