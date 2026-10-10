const at = el => {
  const style = getComputedStyle(el)
  return +style.getPropertyValue("--s") + +(style.getPropertyValue("--d") || 0)
}

const WIDTH = 0.4
const pan = (el, t) => {
  window.seek(t)
  const { left, width } = el.getBoundingClientRect()
  return Math.max(-1, Math.min(1, (left + width / 2) / 960 - 1)) * WIDTH
}

const value = v => (v === undefined ? true : Number.isNaN(+v) ? v : +v)

window.cues = () =>
  [...document.querySelectorAll("[data-cue]")].flatMap((el, i) => {
    const [sound, ...pairs] = el.dataset.cue.split(" ")
    const { repeat = 1, every = 0, ...options } = Object.fromEntries(pairs.map(pair => pair.split("=")).map(([k, v]) => [k, value(v)]))
    const t = at(el)
    return Array.from({ length: repeat }, (_, n) => ({ id: `${i + 1}.${n + 1}`, t: t + n * every, sound, pan: pan(el, t), ...options }))
  })
