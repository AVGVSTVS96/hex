import { END, mark } from "../kit/sound.js"

const BEAT = 0.5
const BAR = BEAT * 4

const hz = midi => 440 * 2 ** ((midi - 69) / 12)

const CHORDS = [
  { bass: 33, pad: [57, 60, 64, 67, 71] },
  { bass: 29, pad: [53, 57, 60, 64, 67] },
  { bass: 36, pad: [55, 60, 62, 64, 69] },
  { bass: 31, pad: [55, 59, 62, 64, 69] },
]
const FINAL = { bass: 24, pad: [48, 55, 60, 62, 64, 69, 76] }

function noiseBuffer(ctx, seconds) {
  const buffer = ctx.createBuffer(2, seconds * ctx.sampleRate, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return buffer
}

function room(ctx, seconds, into) {
  const impulse = noiseBuffer(ctx, seconds)
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c)
    for (let i = 0; i < data.length; i++) data[i] *= Math.exp((-6.9 * i) / data.length) * 0.08
  }
  const low = ctx.createBiquadFilter()
  low.type = "highpass"
  low.frequency.value = 220
  const high = ctx.createBiquadFilter()
  high.type = "lowpass"
  high.frequency.value = 5200
  const convolver = ctx.createConvolver()
  convolver.normalize = false
  convolver.buffer = impulse
  low.connect(high).connect(convolver).connect(into)
  return low
}

function echo(ctx, into) {
  const input = ctx.createGain()
  const delay = ctx.createDelay(1)
  delay.delayTime.value = BEAT * 0.75
  const feedback = ctx.createGain()
  feedback.gain.value = 0.34
  const tone = ctx.createBiquadFilter()
  tone.type = "lowpass"
  tone.frequency.value = 2600
  input.connect(delay).connect(tone).connect(feedback).connect(delay)
  tone.connect(into)
  return input
}

function envelope(param, t, peak, attack, hold, release) {
  param.setValueAtTime(0, t)
  param.linearRampToValueAtTime(peak, t + attack)
  param.setValueAtTime(peak, t + attack + hold)
  param.exponentialRampToValueAtTime(0.0001, t + attack + hold + release)
}

export default function music(ctx) {
  const drop = mark("drop")
  const brk = mark("break")
  const lift = mark("lift")
  const end = mark("end")
  const grooving = t => (t >= drop && t < brk) || (t >= lift && t < end)

  const master = ctx.createGain()
  master.gain.setValueAtTime(0.5, 0)
  master.gain.setValueAtTime(0.5, END - 1.2)
  master.gain.linearRampToValueAtTime(0, END)
  const glue = ctx.createDynamicsCompressor()
  glue.threshold.value = -18
  glue.knee.value = 8
  glue.ratio.value = 3
  glue.attack.value = 0.008
  glue.release.value = 0.16
  const ceiling = ctx.createDynamicsCompressor()
  ceiling.threshold.value = -2
  ceiling.ratio.value = 20
  ceiling.attack.value = 0.001
  ceiling.release.value = 0.05
  master.connect(glue).connect(ceiling).connect(ctx.destination)

  const verb = room(ctx, 3, master)
  const delay = echo(ctx, master)
  const pump = ctx.createGain()
  pump.connect(master)
  const noise = noiseBuffer(ctx, 2)

  const send = (node, amount, bus) => {
    const g = ctx.createGain()
    g.gain.value = amount
    node.connect(g).connect(bus)
  }

  const pad = (t, length, notes, level, cutoff, release = 1.4) => {
    const filter = ctx.createBiquadFilter()
    filter.type = "lowpass"
    filter.Q.value = 0.6
    filter.frequency.setValueAtTime(cutoff[0], t)
    filter.frequency.linearRampToValueAtTime(cutoff[1], t + length)
    const gain = ctx.createGain()
    envelope(gain.gain, t, level, 0.4, Math.max(0, length - 0.4), release)
    filter.connect(gain).connect(pump)
    send(gain, 0.35, verb)
    for (const note of notes)
      for (const spread of [-1, 0, 1]) {
        const osc = ctx.createOscillator()
        osc.type = "sawtooth"
        osc.frequency.value = hz(note)
        osc.detune.value = spread * 7
        const pan = ctx.createStereoPanner()
        pan.pan.value = spread * 0.6
        osc.connect(pan).connect(filter)
        osc.start(t)
        osc.stop(t + length + release + 0.1)
      }
  }

  const bass = (t, note, length, level) => {
    const gain = ctx.createGain()
    envelope(gain.gain, t, level, 0.006, length * 0.4, length * 0.6)
    const filter = ctx.createBiquadFilter()
    filter.type = "lowpass"
    filter.frequency.value = 420
    filter.connect(gain).connect(pump)
    for (const [ratio, type, amount] of [[1, "sine", 1], [2, "triangle", 0.3]]) {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = hz(note) * ratio
      const g = ctx.createGain()
      g.gain.value = amount
      osc.connect(g).connect(filter)
      osc.start(t)
      osc.stop(t + length + 0.05)
    }
  }

  const kick = (t, level = 1) => {
    const osc = ctx.createOscillator()
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.11)
    const gain = ctx.createGain()
    envelope(gain.gain, t, level, 0.002, 0.03, 0.4)
    osc.connect(gain).connect(master)
    osc.start(t)
    osc.stop(t + 0.5)
    hiss(t, 0.18 * level, 3200, "highpass", 0.012)
    pump.gain.setValueAtTime(0.32, t)
    pump.gain.setTargetAtTime(1, t + 0.03, 0.09)
  }

  const hiss = (t, level, frequency, type, decay, out = master, reverb = 0) => {
    const source = ctx.createBufferSource()
    source.buffer = noise
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = frequency
    const gain = ctx.createGain()
    envelope(gain.gain, t, level, 0.001, 0, decay)
    source.connect(filter).connect(gain).connect(out)
    if (reverb) send(gain, reverb, verb)
    source.start(t, Math.random() * 1.5)
    source.stop(t + decay + 0.05)
  }

  const clap = t => {
    for (const offset of [0, 0.011, 0.023]) hiss(t + offset, 0.16, 1400, "bandpass", 0.09, master, 0.5)
  }

  const pluck = (t, note, level) => {
    const gain = ctx.createGain()
    envelope(gain.gain, t, level, 0.003, 0, 0.32)
    const filter = ctx.createBiquadFilter()
    filter.type = "lowpass"
    filter.frequency.value = 3400
    filter.connect(gain).connect(pump)
    send(gain, 0.5, delay)
    send(gain, 0.3, verb)
    for (const [ratio, amount] of [[1, 1], [2, 0.25], [3, 0.08]]) {
      const osc = ctx.createOscillator()
      osc.frequency.value = hz(note) * ratio
      const g = ctx.createGain()
      g.gain.value = amount
      osc.connect(g).connect(filter)
      osc.start(t)
      osc.stop(t + 0.4)
    }
  }

  const rise = (from, to, level) => {
    const source = ctx.createBufferSource()
    source.buffer = noise
    source.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = "bandpass"
    filter.Q.value = 1.6
    filter.frequency.setValueAtTime(300, from)
    filter.frequency.exponentialRampToValueAtTime(7000, to)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, from)
    gain.gain.linearRampToValueAtTime(level, to - 0.02)
    gain.gain.linearRampToValueAtTime(0, to)
    source.connect(filter).connect(gain).connect(master)
    send(gain, 0.4, verb)
    source.start(from)
    source.stop(to + 0.05)
  }

  const impact = (t, level) => {
    const osc = ctx.createOscillator()
    osc.frequency.setValueAtTime(72, t)
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.8)
    const gain = ctx.createGain()
    envelope(gain.gain, t, level, 0.004, 0.05, 1.6)
    osc.connect(gain).connect(master)
    osc.start(t)
    osc.stop(t + 1.8)
    hiss(t, 0.3 * level, 1800, "lowpass", 0.5, master, 0.9)
  }

  const chordAt = bar => CHORDS[(((bar - drop / BAR) % 4) + 4) % 4]

  for (let bar = 0; bar * BAR < end; bar++) {
    const t = bar * BAR
    const chord = chordAt(bar)
    if (t < drop) pad(t, BAR, chord.pad, 0.012 + 0.006 * bar, [380 + 300 * bar, 680 + 400 * bar])
    else if (t < brk) pad(t, BAR, chord.pad, 0.02, [1500, 1900])
    else if (t < lift) pad(t, BAR, chord.pad, 0.022, [520, 1100 + 600 * (t - brk)])
    else pad(t, BAR, chord.pad, 0.022, [2100, 2600])

    for (let beat = 0; beat < 4; beat++) {
      const b = t + beat * BEAT
      if (grooving(b)) {
        kick(b, b === drop || b === lift ? 1.15 : 1)
        bass(b + BEAT / 2, chord.bass + (beat === 3 ? 12 : 0), BEAT * 0.45, 0.32)
        hiss(b + BEAT / 2, 0.11, 8200, "highpass", 0.07)
        if (b >= drop + 2 * BAR) for (const q of [0.25, 0.75]) hiss(b + q * BEAT, 0.03 + 0.015 * Math.random(), 9500, "highpass", 0.03)
        if (beat % 2 === 1 && b >= drop + 2 * BAR) clap(b)
      } else if (b >= BAR && b < drop) {
        hiss(b + BEAT / 2, 0.025 + 0.01 * (b / drop), 9000, "highpass", 0.04)
      }
      if (b >= drop + 4 * BAR && b < end && (b < brk || b >= lift)) {
        const order = [0, 2, 4, 1, 3, 2, 4, 3]
        for (let e = 0; e < 2; e++) pluck(b + e * BEAT / 2, chord.pad[order[(beat * 2 + e) % 8]] + 12, 0.05)
      } else if (b >= brk && b < lift) {
        pluck(b, chord.pad[(beat * 2) % 5] + 12, 0.045)
      }
    }
  }

  rise(drop - 2.4, drop, 0.16)
  rise(lift - 2, lift, 0.14)
  impact(drop, 0.9)
  impact(lift, 0.7)
  impact(end, 1)
  kick(end, 1.2)
  pad(end, 0.2, FINAL.pad, 0.026, [2600, 2400], 4.6)
  bass(end, FINAL.bass + 12, 2.4, 0.26)
}
