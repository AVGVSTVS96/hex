const stage = document.getElementById("stage")
const scenes = [...document.querySelectorAll(".scene")]
const count = document.getElementById("count")
const counters = [...document.querySelectorAll("[data-count]")]
const END = Math.max(...scenes.map(s => +s.dataset.e))
const easeOut = x => 1 - (1 - x) ** 4
const clamp01 = x => Math.min(Math.max(x, 0), 1)

for (const s of scenes) s.style.setProperty("--s", s.dataset.s)

function seek(t) {
  scenes.forEach((s, i) => {
    const on = t >= +s.dataset.s && t < +s.dataset.e
    s.classList.toggle("on", on)
    if (on) {
      stage.dataset.theme = s.dataset.theme
      if (count) count.textContent = `${String(i + 1).padStart(2, "0")} / ${scenes.length}`
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
