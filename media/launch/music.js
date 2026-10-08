import { END, mark, hall } from "../kit/sound.js"
import { MALLET } from "../node_modules/cuelume/dist/sounds/recipes.js"

const BEAT = 0.5
const BAR = BEAT * 4
const STEP = BEAT / 4
const SWING = 0.01

const LETTERS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const midi = note => {
  if (typeof note === "number") return note
  const [, letter, sharp, octave] = note.match(/([A-G])(#?)(\d)/)
  return 12 * (+octave + 1) + LETTERS[letter] + (sharp ? 1 : 0)
}
const hz = note => 440 * 2 ** ((midi(note) - 69) / 12)
const chord = (bass, voicing) => ({ bass: midi(bass), voicing: voicing.split(" ").map(midi) })

const AM9 = chord("A1", "A3 C4 E4 G4 B4")
const DM9 = chord("D2", "F3 A3 C4 E4")
const E7SUS = chord("E1", "E3 A3 B3 D4")
const E7 = chord("E1", "E3 G#3 B3 D4")
const FMAJ9 = chord("F1", "F3 C4 E4 G4 A4")
const G6 = chord("G1", "G3 D4 E4 A4 B4")
const EM11 = chord("E1", "E3 B3 D4 G4 A4")
const F_G = chord("G1", "F3 A3 C4 E4")
const C69 = chord("C2", "C3 G3 D4 E4 A4")
const ROYAL = [FMAJ9, G6, EM11, AM9]

const MOTIF = ["C5", "A4", "G4", "A4", "C5", "E5"]
const HOOK = [MOTIF, ["D5", "B4", "G4", "D5", "B4", "G4"], ["E5", "B4", "G4", "B4", "E5", "G5"], ["E5", "C5", "A4"]]
const TURNAROUND = ["B4", "G#4", "E4", "G#4", "B4", "D5"]
const HOOK_STEPS = [0, 3, 6, 8, 11, 14]
const BASS_STEPS = [[2, 0, 1], [3, 12, 0.5], [6, 0, 1], [10, 0, 1], [11, 12, 0.5], [14, 0, 1], [15, 7, 0.6]]
const ARP = [0, 1, 2, 3, 4, 3, 2, 1]
const ACCENTS = [0.42, 0.14, 0.26, 0.12, 0.3, 0.14, 0.26, 0.12, 0.36, 0.14, 0.26, 0.12, 0.3, 0.14, 0.26, 0.12]

function noise(ctx, seconds) {
  const buffer = ctx.createBuffer(2, seconds * ctx.sampleRate, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return buffer
}

function metal(ctx, seconds) {
  const rate = ctx.sampleRate
  const buffer = ctx.createBuffer(1, seconds * rate, rate)
  const data = buffer.getChannelData(0)
  for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800].map(f => f * 1.7)) {
    const phase = Math.random() * 2 * Math.PI
    for (let k = 1; k * f < 18000; k += 2) {
      const w = (2 * Math.PI * k * f) / rate
      for (let i = 0; i < data.length; i++) data[i] += Math.sin(w * i + k * phase) / k / 6
    }
  }
  return buffer
}

function saturate(amount) {
  const curve = new Float32Array(2048)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount)
  }
  return curve
}

export default function music(ctx) {
  const doubt = mark("doubt")
  const drop = mark("drop")
  const turn = mark("turn")
  const squeeze = mark("squeeze")
  const restore = mark("restore")
  const ask = mark("ask")
  const full = mark("full")
  const top = mark("top")
  const brk = mark("break")
  const lift = mark("lift")
  const end = mark("end")
  const build = drop - BAR
  const rise = lift - BAR

  const NOISE = noise(ctx, 2)
  const METAL = metal(ctx, 2)

  const node = (Type, options, ...into) => {
    const n = new Type(ctx, options)
    for (const target of into) n.connect(target)
    return n
  }
  const shaper = amount => node(WaveShaperNode, { curve: saturate(amount), oversample: "4x" })
  const send = (from, amount, bus) => from.connect(node(GainNode, { gain: amount }, bus))

  const out = node(GainNode, { gain: 1 }, ctx.destination)
  out.gain.setValueAtTime(1, END - 0.3)
  out.gain.linearRampToValueAtTime(0, END)
  const tone = node(BiquadFilterNode, { type: "lowpass", frequency: 20000, Q: 0.9 }, node(BiquadFilterNode, { type: "highpass", frequency: 28, Q: 0.7 }, out))
  const master = node(GainNode, { gain: 0.5 }, tone)
  const direct = node(GainNode, { gain: 1 }, out)
  const stopdown = (from, to) => {
    master.gain.setValueAtTime(0.5, from - 0.004)
    master.gain.linearRampToValueAtTime(0, from)
    master.gain.setValueAtTime(0, to)
    master.gain.linearRampToValueAtTime(0.5, to + 0.002)
  }

  const drums = node(GainNode, { gain: 1 }, master)
  const pump = node(GainNode, { gain: 1 }, master)
  const duck = t => {
    pump.gain.setValueAtTime(0.6, t)
    pump.gain.setTargetAtTime(1, t + 0.01, 0.05)
  }

  const verb = node(BiquadFilterNode, { type: "highpass", frequency: 300 })
  verb.connect(node(ConvolverNode, { buffer: hall(ctx, 1.8, 0.025), disableNormalization: true })).connect(node(BiquadFilterNode, { type: "lowpass", frequency: 8000 }, pump))

  const echo = node(GainNode, { gain: 1 })
  const left = node(DelayNode, { delayTime: BEAT * 0.75, maxDelayTime: 1 })
  const right = node(DelayNode, { delayTime: BEAT * 0.75, maxDelayTime: 1 })
  echo.connect(node(BiquadFilterNode, { type: "bandpass", frequency: 1800, Q: 0.5 })).connect(left)
  left.connect(node(GainNode, { gain: 0.36 }, right))
  right.connect(node(GainNode, { gain: 0.36 }, left))
  left.connect(node(StereoPannerNode, { pan: -0.7 }, pump))
  right.connect(node(StereoPannerNode, { pan: 0.7 }, pump))

  const envelope = (param, t, peak, attack, decay) => {
    param.setValueAtTime(0, t)
    param.linearRampToValueAtTime(peak, t + attack)
    param.setTargetAtTime(0, t + attack, decay / 4.6)
  }

  const burst = (t, { level, decay, type = "bandpass", frequency, Q = 0.8, attack = 0.0008, into = drums, pan = 0, buffer = NOISE }) => {
    const source = node(AudioBufferSourceNode, { buffer, loop: true })
    const amp = node(GainNode, { gain: 0 })
    source.connect(node(BiquadFilterNode, { type, frequency, Q })).connect(amp).connect(node(StereoPannerNode, { pan }, into))
    envelope(amp.gain, t, level, attack, decay)
    source.start(t, Math.random() * 1.5)
    source.stop(t + attack + decay + 0.05)
    return amp
  }

  const tonal = (t, { frequency, to, glide = 0.015, level, attack = 0.002, decay, type = "sine", into }) => {
    const osc = node(OscillatorNode, { type, frequency })
    osc.frequency.setValueAtTime(frequency, t)
    if (to) osc.frequency.setTargetAtTime(to, t, glide)
    const amp = node(GainNode, { gain: 0 }, into)
    osc.connect(amp)
    envelope(amp.gain, t, level, attack, decay)
    osc.start(t)
    osc.stop(t + attack + decay + 0.05)
    return amp
  }

  const kick = (t, level = 1, muffle = 0) => {
    const into = muffle ? node(BiquadFilterNode, { type: "lowpass", frequency: muffle, Q: 0.7 }, drums) : drums
    const body = node(GainNode, { gain: 0.5 })
    body.connect(shaper(1.3)).connect(into)
    tonal(t, { frequency: 55 * 4.5, to: 55, level, attack: 0.001, decay: 0.25, into: body })
    burst(t, { level: 0.24 * level, decay: 0.006, type: "highpass", frequency: 2000, Q: 0.7, into })
    duck(t)
  }

  const clap = (t, level = 1) => {
    for (const [frequency, pan, offset] of [[1100, -0.15, 0], [1250, 0.15, 0.004]]) {
      for (const d of [0, 0.011, 0.022]) burst(t + offset + d + (Math.random() - 0.5) * 0.002, { level: 0.4 * level, decay: 0.0115, frequency, Q: 2, pan })
      send(burst(t + offset + 0.033, { level: 0.34 * level, decay: 0.2, frequency, Q: 1.4, pan }), 0.3, verb)
    }
    burst(t, { level: 0.16 * level, decay: 0.03, type: "highpass", frequency: 3200, Q: 0.7 })
    for (const frequency of [180, 330]) tonal(t, { frequency, level: 0.06 * level, decay: 0.1, type: "triangle", into: drums })
  }

  let ringing = null
  const hat = (t, level, open = false) => {
    if (ringing) ringing.gain.setTargetAtTime(0, t, 0.006)
    const source = node(AudioBufferSourceNode, { buffer: METAL, loop: true })
    const amp = node(GainNode, { gain: 0 })
    source.connect(node(BiquadFilterNode, { type: "bandpass", frequency: 9000, Q: 0.5 })).connect(node(BiquadFilterNode, { type: "highpass", frequency: 6000 })).connect(amp).connect(node(StereoPannerNode, { pan: 0.15 }, drums))
    const decay = open ? 0.3 : 0.04
    envelope(amp.gain, t, 1.4 * level * (0.85 + 0.3 * Math.random()), 0.0006, decay)
    source.start(t, Math.random() * 1.5)
    source.stop(t + decay + 0.05)
    ringing = open ? amp : null
  }

  const shaker = (t, level) => burst(t, { level, decay: 0.05, attack: 0.009, frequency: 6200, Q: 1.4, pan: -0.35 })

  const rim = (t, level, pan) => {
    burst(t, { level: level * 0.6, decay: 0.012, frequency: 2400, Q: 1.5, pan })
    tonal(t, { frequency: 1720, level: level * 0.35, decay: 0.03, into: node(StereoPannerNode, { pan }, drums) })
  }

  const crash = (t, level = 1) => {
    const source = node(AudioBufferSourceNode, { buffer: METAL, loop: true })
    const amp = node(GainNode, { gain: 0 })
    source.connect(node(BiquadFilterNode, { type: "highpass", frequency: 5000, Q: 0.5 })).connect(amp).connect(master)
    envelope(amp.gain, t, 0.3 * level, 0.001, 2.2)
    source.start(t)
    source.stop(t + 2.3)
    burst(t, { level: 0.14 * level, decay: 1.8, type: "highpass", frequency: 6500, Q: 0.5, into: master })
    send(amp, 0.25, verb)
  }

  const swell = (to, length, level) => {
    const source = node(AudioBufferSourceNode, { buffer: NOISE, loop: true })
    const amp = node(GainNode, { gain: 0.0001 })
    source.connect(node(BiquadFilterNode, { type: "highpass", frequency: 3200, Q: 0.5 })).connect(amp).connect(direct)
    amp.gain.setValueAtTime(0.0001, to - length)
    amp.gain.exponentialRampToValueAtTime(level, to - 0.004)
    amp.gain.linearRampToValueAtTime(0, to)
    source.start(to - length)
    source.stop(to + 0.01)
  }

  const riser = (from, to, level) => {
    const source = node(AudioBufferSourceNode, { buffer: NOISE, loop: true })
    const filter = node(BiquadFilterNode, { type: "bandpass", Q: 2.2 })
    filter.frequency.setValueAtTime(800, from)
    filter.frequency.exponentialRampToValueAtTime(10000, to)
    const amp = node(GainNode, { gain: 0 })
    amp.gain.setValueAtTime(0, from)
    amp.gain.linearRampToValueAtTime(level, to - 0.004)
    amp.gain.linearRampToValueAtTime(0, to)
    source.connect(filter).connect(amp).connect(master)
    send(amp, 0.4, verb)
    source.start(from)
    source.stop(to + 0.01)
  }

  const impact = (t, level = 1) => {
    const body = node(GainNode, { gain: 1 })
    body.connect(shaper(1.8)).connect(master)
    tonal(t, { frequency: 110, to: 41, glide: 0.18, level: 0.7 * level, decay: 1.2, into: body })
    send(burst(t, { level: 0.24 * level, decay: 0.4, type: "lowpass", frequency: 1200, Q: 0.5, into: master }), 0.6, verb)
  }

  const roll = (from, to, level) => {
    for (let t = from; t < to - 0.001; ) {
      const p = (t - from) / (to - from)
      burst(t, { level: level * (0.25 + 0.75 * p), decay: 0.05, frequency: 1300 + 1500 * p, Q: 1.2 })
      tonal(t, { frequency: 180 + 120 * p, level: level * 0.1 * (0.3 + p), decay: 0.05, type: "triangle", into: drums })
      t += p < 0.5 ? BEAT / 2 : p < 0.8 ? STEP : STEP / 2
    }
  }

  const bass = (t, note, length, level = 1) => {
    const f = hz(note)
    const filter = node(BiquadFilterNode, { type: "lowpass", Q: 3 })
    filter.frequency.setValueAtTime(Math.min(f * 14, 1500), t)
    filter.frequency.setTargetAtTime(f * 2.5, t + 0.005, 0.05)
    const amp = node(GainNode, { gain: 0 })
    filter.connect(shaper(1.4)).connect(amp).connect(master)
    amp.gain.setValueAtTime(0, t)
    amp.gain.linearRampToValueAtTime(0.16 * level, t + 0.004)
    amp.gain.setValueAtTime(0.16 * level, t + length)
    amp.gain.setTargetAtTime(0, t + length, 0.015)
    for (const [type, gain] of [["sine", 0.9], ["sawtooth", 0.4]]) {
      const osc = node(OscillatorNode, { type, frequency: f })
      osc.connect(node(GainNode, { gain }, filter))
      osc.start(t)
      osc.stop(t + length + 0.1)
    }
  }

  const pad = (t, length, notes, level, cutoff, { attack = 0.5, release = 1.2, bend = 0 } = {}) => {
    const filter = node(BiquadFilterNode, { type: "lowpass", Q: 0.5 })
    filter.frequency.setValueAtTime(cutoff[0], t)
    filter.frequency.exponentialRampToValueAtTime(cutoff[1], t + length)
    const amp = node(GainNode, { gain: 0 })
    filter.connect(node(BiquadFilterNode, { type: "highpass", frequency: 240 })).connect(amp).connect(pump)
    send(amp, 0.45, verb)
    amp.gain.setValueAtTime(0, t)
    amp.gain.linearRampToValueAtTime(level, t + attack)
    amp.gain.setValueAtTime(level, t + length)
    amp.gain.setTargetAtTime(0, t + length, release / 4.6)
    for (const note of notes)
      for (const spread of [-1, 0, 1]) {
        const f = hz(note)
        const osc = node(OscillatorNode, { type: "sawtooth", frequency: f, detune: spread * 9 })
        if (bend) osc.detune.setTargetAtTime(spread * 9 + bend, t + length, 0.15)
        osc.connect(node(StereoPannerNode, { pan: spread * 0.6 }, filter))
        osc.start(Math.max(0, t - Math.random() / f))
        osc.stop(t + length + release + 0.1)
      }
  }

  const stab = (t, notes, level) => {
    const filter = node(BiquadFilterNode, { type: "lowpass", Q: 1.1 })
    filter.frequency.setValueAtTime(5200, t)
    filter.frequency.setTargetAtTime(700, t + 0.01, 0.05)
    const amp = node(GainNode, { gain: 0 })
    filter.connect(node(BiquadFilterNode, { type: "highpass", frequency: 220 })).connect(amp).connect(pump)
    send(amp, 0.3, verb)
    send(amp, 0.18, echo)
    envelope(amp.gain, t, level, 0.003, 0.26)
    for (const note of notes)
      for (const spread of [-1, 1]) {
        const f = hz(note)
        const osc = node(OscillatorNode, { type: "sawtooth", frequency: f, detune: spread * 6 })
        osc.connect(node(StereoPannerNode, { pan: spread * 0.45 }, filter))
        osc.start(Math.max(0, t - Math.random() / f))
        osc.stop(t + 0.4)
      }
  }

  const hook = (t, note, level = 1) => {
    const f = hz(note)
    const carrier = node(OscillatorNode, { frequency: f })
    const modulator = node(OscillatorNode, { frequency: f * 2 })
    const depth = node(GainNode, { gain: 0 })
    depth.gain.setValueAtTime(f * 2.5, t)
    depth.gain.setTargetAtTime(0, t, 0.07)
    modulator.connect(depth).connect(carrier.frequency)
    const amp = node(GainNode, { gain: 0 })
    carrier.connect(amp).connect(master)
    envelope(amp.gain, t, 0.14 * level, 0.002, 0.6)
    send(amp, 0.3, echo)
    send(amp, 0.25, verb)
    for (const osc of [carrier, modulator]) {
      osc.start(t)
      osc.stop(t + 0.7)
    }
  }

  const mallet = (t, note, level = 1, decay = 2) => {
    const f = hz(note)
    const amp = node(GainNode, { gain: 1 }, master)
    send(amp, 0.35, verb)
    send(amp, 0.15, echo)
    for (const [ratio, gain] of MALLET) tonal(t, { frequency: f * ratio, level: 0.16 * level * gain, attack: 0.003, decay: decay / ratio, into: amp })
    burst(t, { level: 0.05 * level, decay: 0.004, type: "lowpass", frequency: 1600, Q: 0.7, into: amp })
  }

  const arp = (t, note, level, pan) => {
    const filter = node(BiquadFilterNode, { type: "lowpass", frequency: 2100, Q: 2 })
    filter.connect(node(StereoPannerNode, { pan }, pump))
    send(tonal(t, { frequency: hz(note), level, decay: 0.09, type: "square", into: filter }), 0.2, echo)
  }

  const at = (bar, step) => bar * BAR + step * STEP + (step % 2 ? SWING : 0)

  pad(0, doubt, AM9.voicing, 0.02, [600, 1500], { attack: 1.2, release: 0.9, bend: -100 })
  MOTIF.slice(0, 5).forEach((note, i) => hook(BEAT * (i + 1), note, 1.6))
  for (let step = 0; step * STEP < doubt; step++) if (step % 4) hat(at(0, step), step % 4 === 2 ? 0.16 : 0.08)
  pad(doubt + 0.1, build - doubt - 0.1, DM9.voicing, 0.022, [900, 520], { attack: 0.9, release: 0.6 })

  const buildUp = (t, length, gap) => {
    pad(t, BEAT * 2, E7SUS.voicing, 0.009, [500, 1600], { attack: 0.2, release: 0.05 })
    pad(t + BEAT * 2, length - BEAT * 2, E7.voicing, 0.01, [1600, 4800], { attack: 0.05, release: 0.05 })
    for (let i = 0; i < 4; i++) kick(t + i * BEAT, 0.55 + i * 0.12, 260 + i * 300)
    roll(t, t + length, 0.42)
    riser(t, t + length, 0.1)
    bass(t, E7.bass + 12, length, 0.6)
    stopdown(t + length, t + length + gap)
    swell(t + length + gap, 1, 0.1)
  }
  buildUp(build, BAR - BEAT, BEAT)
  buildUp(rise, BAR - BEAT / 2, BEAT / 2)

  const harmony = bar => {
    const t = bar * BAR
    if (t >= lift) return [FMAJ9, G6, F_G][(bar - lift / BAR) % 3]
    if (t === turn - BAR) return E7
    return ROYAL[(bar - (t >= turn ? turn : drop) / BAR) % 4]
  }

  for (let bar = drop / BAR; bar < end / BAR; bar++) {
    const t = bar * BAR
    if (t >= rise && t < lift) continue
    if (t >= brk && t < rise) {
      pad(t, BAR, AM9.voicing, 0.024, [900, 2600], { attack: 0.08, release: 0.4 })
      tonal(t, { frequency: hz(AM9.bass + 12), level: 0.22, attack: 0.02, decay: 2, into: master })
      MOTIF.forEach((note, i) => mallet(t + BEAT * 2 + HOOK_STEPS[i] * STEP, note, 1.4, 1.6))
      continue
    }
    const now = harmony(bar)
    const section = t >= lift ? "lift" : t >= top ? "top" : t >= full ? "full" : t >= ask ? "ask" : t >= turn ? "turn" : "a"
    const phrase = (bar - (t >= turn ? turn : drop) / BAR) % 4
    const wide = section === "top" || section === "lift"

    pad(t, BAR, now.voicing, section === "turn" ? 0.012 : 0.009, [1600, 2200], { attack: 0.06, release: 0.3 })
    for (const beat of [0, 1, 2, 3]) kick(t + beat * BEAT)
    for (const beat of [1, 3]) clap(t + beat * BEAT, 0.9)
    for (const [step, octave, level] of BASS_STEPS) bass(at(bar, step), now.bass + 12 + octave, STEP * 0.8, level)

    for (let step = 0; step < 16; step++) {
      const open = wide && step % 4 === 2
      if (open) hat(at(bar, step), 0.3, true)
      else if (!(wide && step % 4 === 3)) hat(at(bar, step), ACCENTS[step] * (bar === drop / BAR ? 0.7 : 1))
      shaker(at(bar, step), (step % 2 ? 0.05 : 0.03) * (section === "a" ? 0.6 : 1))
    }
    if (section !== "a") for (const [step, pan] of [[3, -0.4], [10, 0.4]]) rim(at(bar, step), 0.2, pan)

    if (section === "turn") ARP.concat(ARP).forEach((index, step) => arp(at(bar, step), now.voicing[index % now.voicing.length] + 12, 0.05, step % 2 ? 0.3 : -0.3))
    else {
      const line = t === turn - BAR ? TURNAROUND : now === F_G ? MOTIF : HOOK[phrase]
      line.forEach((note, i) => hook(at(bar, HOOK_STEPS[i]), note, section === "lift" ? 1.1 : 1))
      if (wide) line.forEach((note, i) => hook(at(bar, HOOK_STEPS[i]), midi(note) + 12, 0.3))
    }
    if (section !== "a" && section !== "turn" && section !== "ask") for (const step of [6, 14]) stab(at(bar, step), now.voicing, section === "lift" ? 0.026 : 0.02)

    if (phrase === 3 || t + BAR === brk || t + BAR === turn - BAR)
      for (const step of [13, 14, 15]) burst(at(bar, step), { level: 0.22 + 0.08 * (step - 13), decay: 0.06, frequency: 1500, Q: 1.2 })
  }

  for (const t of [turn, full]) {
    swell(t, 1, 0.06)
    crash(t, 0.6)
  }

  tone.frequency.setValueAtTime(20000, squeeze - 0.12)
  tone.frequency.exponentialRampToValueAtTime(480, squeeze + 0.12)
  tone.frequency.setValueAtTime(480, restore - 0.05)
  tone.frequency.exponentialRampToValueAtTime(20000, restore + 0.3)
  swell(restore, 0.5, 0.05)
  for (const [i, note] of ["G5", "C6", "E6"].entries()) mallet(restore + i * 0.06, note, 0.55, 1.4)
  for (const [t, level] of [[drop, 1], [lift, 0.85]]) {
    impact(t, level)
    crash(t, level)
  }

  impact(end, 0.9)
  crash(end, 0.8)
  kick(end, 1.1)
  stab(end, C69.voicing, 0.02)
  pad(end, 0.1, C69.voicing, 0.013, [3200, 3000], { attack: 0.004, release: 4.5 })
  tonal(end, { frequency: hz(C69.bass), level: 0.28, attack: 0.004, decay: 3, into: master })
  MOTIF.forEach((note, i) => mallet(end + BEAT + (i * BEAT) / 2, note, 1, 2.6))
  mallet(end + BEAT * 4.5, "C6", 0.8, 3.5)
}
