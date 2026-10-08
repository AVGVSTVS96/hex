const { spring, cubicBezier } = Motion

const stage = document.getElementById("stage")
const scenes = [...document.querySelectorAll(".scene")]
const count = document.getElementById("count")
const counters = [...document.querySelectorAll("[data-count]")]
const END = Math.max(...scenes.map(s => +s.dataset.e))
const easeOut = cubicBezier(0.23, 1, 0.32, 1)
const clamp01 = x => Math.min(Math.max(x, 0), 1)

const springs = { settle: [0.55, 0], draw: [0.8, 0], pop: [0.45, 0.25], swing: [0.7, 0.12] }
for (const [name, [duration, bounce]] of Object.entries(springs)) stage.style.setProperty(`--${name}`, spring(duration, bounce))

for (const s of scenes) s.style.setProperty("--s", s.dataset.s)

for (const el of document.querySelectorAll("[data-split]")) {
  const [start, step] = el.dataset.split.split(" ").map(Number)
  el.innerHTML = [...el.textContent].map((c, i) => `<span class="m"><span class="a" style="--d:${start + i * step}">${c}</span></span>`).join("")
}

const roll = spring({ keyframes: [0, 1], visualDuration: 0.45, bounce: 0 })
const pad = n => String(n).padStart(2, "0")
if (count) count.innerHTML = `<span class="roll"><span>${scenes.map((_, i) => `<span>${pad(i + 1)}</span>`).join("")}</span></span> / ${pad(scenes.length)}`
const numbers = count?.querySelector(".roll > span")

function seek(t) {
  scenes.forEach((s, i) => {
    const on = t >= +s.dataset.s && t < +s.dataset.e
    s.classList.toggle("on", on)
    if (on) {
      stage.dataset.theme = s.dataset.theme
      const at = i && i - 1 + roll.next((t - +s.dataset.s) * 1000).value
      if (numbers) numbers.style.transform = `translateY(${-at}em)`
    }
  })
  for (const el of counters) {
    const start = +el.closest(".scene").dataset.s + +el.dataset.at
    const p = easeOut(clamp01((t - start) / +el.dataset.dur))
    el.textContent = Math.round(+el.dataset.count * p).toLocaleString("en-US")
  }
  for (const a of document.getAnimations()) {
    a.pause()
    a.currentTime = t * 1000
  }
}

window.seek = seek
window.END = END

if (!navigator.webdriver) {
  const name = location.pathname.split("/").filter(Boolean).at(-1)
  const audio = new Audio(`../out/${name}/soundtrack.wav`)
  const from = +new URLSearchParams(location.search).get("t") || 0
  let t0 = performance.now() - from * 1000
  addEventListener("click", () => {
    audio.currentTime = 0
    audio.play()
  })
  audio.addEventListener("ended", () => (t0 = performance.now()))
  const tick = now => {
    seek(audio.paused ? ((now - t0) / 1000) % END : audio.currentTime)
    requestAnimationFrame(tick)
  }
  document.fonts.ready.then(() => requestAnimationFrame(tick))
}
