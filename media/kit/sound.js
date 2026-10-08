export const RATE = 48000

const scenes = [...document.querySelectorAll(".scene")]
export const END = Math.max(...scenes.map(s => +s.dataset.e))

const at = el => {
  const style = getComputedStyle(el)
  return +style.getPropertyValue("--s") + +(style.getPropertyValue("--d") || 0)
}
export const mark = name => at(document.querySelector(`[data-music="${name}"]`))

export function hall(ctx, seconds, predelay) {
  const rate = ctx.sampleRate
  const buffer = ctx.createBuffer(2, seconds * rate, rate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    let low = 0
    let energy = 0
    for (let i = 0; i < data.length; i++) {
      const t = i / rate - predelay
      if (t < 0) continue
      low += (0.06 + 0.9 * Math.exp(-t * 2.2)) * (Math.random() * 2 - 1 - low)
      data[i] = low * Math.exp((-6.9 * t) / (seconds - predelay))
      energy += data[i] ** 2
    }
    for (let i = 0; i < data.length; i++) data[i] /= Math.sqrt(energy)
  }
  return buffer
}

const WIDTH = 0.4
function pan(el, t) {
  window.seek(t)
  const { left, width } = el.getBoundingClientRect()
  return Math.max(-1, Math.min(1, (left + width / 2) / 960 - 1)) * WIDTH
}

function cues() {
  return [...document.querySelectorAll("[data-cue]")].map(el => {
    const [name, ...pairs] = el.dataset.cue.split(" ")
    const options = Object.fromEntries(pairs.map(pair => pair.split("=")).map(([k, v]) => [k, Number.isNaN(+v) ? v : +v]))
    const t = at(el)
    return { t, name, options, from: pan(el, t), to: pan(el, t + 0.6) }
  })
}

async function renderCue({ name, options }, i) {
  const ctx = new OfflineAudioContext(2, 3 * RATE, RATE)
  Object.defineProperty(ctx, "state", { get: () => "running" })
  window.AudioContext = function () {
    return ctx
  }
  // cuelume keeps one AudioContext for the life of its module, so every cue imports a fresh copy
  const { play } = await import(`../node_modules/cuelume/dist/audio/engine.js?cue=${i}`)
  play(name, options)
  return ctx.startRendering()
}

async function renderCues() {
  const list = cues()
  const ctx = new OfflineAudioContext(2, Math.ceil(END * RATE), RATE)
  const clear = new BiquadFilterNode(ctx, { type: "highpass", frequency: 250, Q: 0.6 })
  clear.connect(ctx.destination)
  const room = new ConvolverNode(ctx, { buffer: hall(ctx, 1.8, 0.025), disableNormalization: true })
  clear.connect(new GainNode(ctx, { gain: 0.08 })).connect(room).connect(ctx.destination)
  for (const [i, cue] of list.entries()) {
    const source = new AudioBufferSourceNode(ctx, { buffer: await renderCue(cue, i) })
    const panner = new StereoPannerNode(ctx)
    panner.pan.setValueAtTime(cue.from, cue.t)
    panner.pan.linearRampToValueAtTime(cue.to, cue.t + 0.6)
    source.connect(panner).connect(clear)
    source.start(cue.t)
  }
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
  const bytes = new DataView(new ArrayBuffer(44 + frames * 8))
  const text = (offset, s) => [...s].forEach((c, i) => bytes.setUint8(offset + i, c.charCodeAt(0)))
  text(0, "RIFF")
  bytes.setUint32(4, 36 + frames * 8, true)
  text(8, "WAVEfmt ")
  bytes.setUint32(16, 16, true)
  bytes.setUint16(20, 3, true)
  bytes.setUint16(22, 2, true)
  bytes.setUint32(24, RATE, true)
  bytes.setUint32(28, RATE * 8, true)
  bytes.setUint16(32, 8, true)
  bytes.setUint16(34, 32, true)
  text(36, "data")
  bytes.setUint32(40, frames * 8, true)
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < 2; c++) bytes.setFloat32(44 + i * 8 + c * 4, channels[c][i], true)
  return new Uint8Array(bytes.buffer).toBase64()
}

export function soundtrack(music) {
  window.soundtrack = async () => ({ cues: wav(await renderCues()), music: wav(await renderMusic(music)) })
}
