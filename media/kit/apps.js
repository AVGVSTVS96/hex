const icon = (paths, box = "0 0 24 24") => `<svg viewBox="${box}">${paths}</svg>`

const ICONS = {
  signal: icon(`<rect y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" width="3" height="12" rx="1"/>`, "0 0 18 12"),
  wifi: icon(`<path d="M8 11.6 5.7 9.2a3.3 3.3 0 0 1 4.6 0zM3.5 7a6.4 6.4 0 0 1 9 0l-1.4 1.4a4.4 4.4 0 0 0-6.2 0zM1.2 4.7a9.6 9.6 0 0 1 13.6 0l-1.4 1.4a7.6 7.6 0 0 0-10.8 0z"/>`, "0 0 16 12"),
  clip: icon(`<path d="M16.5 6.5 8.4 14.6a2 2 0 1 0 2.8 2.8l8.1-8.1a4 4 0 0 0-5.6-5.6L5.4 12a6 6 0 0 0 8.5 8.5l6.6-6.6"/>`),
  mic: icon(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>`),
  sticker: icon(`<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 0 8.5 8.5H12z"/>`),
  sidebar: icon(`<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>`, "0 0 16 16"),
  back: icon(`<path d="M10 3 5 8l5 5"/>`, "0 0 16 16"),
  forward: icon(`<path d="m6 3 5 5-5 5"/>`, "0 0 16 16"),
  at: icon(`<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7"/>`),
  smile: icon(`<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>`),
  up: icon(`<path d="M12 18V6M7 11l5-5 5 5"/>`),
  search: icon(`<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>`, "0 0 16 16"),
  inbox: icon(`<path d="M2.5 9.5 4.3 4a1.5 1.5 0 0 1 1.4-1h4.6a1.5 1.5 0 0 1 1.4 1l1.8 5.5V12a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2.5 12zM2.5 9.5h3l1 1.5h3l1-1.5h3"/>`, "0 0 16 16"),
  bot: icon(`<rect x="2.5" y="5" width="11" height="8" rx="2"/><path d="M8 2v3M6 9h.01M10 9h.01"/>`, "0 0 16 16"),
  people: icon(`<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5a4.5 4.5 0 0 1 9 0M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12.5 9.6a4.5 4.5 0 0 1 2 3.9"/>`, "0 0 16 16"),
  more: icon(`<circle cx="8" cy="3" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="8" cy="13" r="1"/>`, "0 0 16 16"),
}

const lights = `<span class="lights"><i></i><i></i><i></i></span>`

function telegram(phone) {
  const { title = "hex", sub = "2 members", topic = "General", time = "4:41" } = phone.dataset
  phone.insertAdjacentHTML("afterbegin", `
    <div class="ios-bar"><time>${time}</time><i class="island"></i><span class="ios-icons">${ICONS.signal}${ICONS.wifi}<span class="battery"><i></i></span></span></div>
    <div class="tg-top"><span class="glass tg-back">‹<em>3</em></span><span class="glass tg-name"><b>${title}</b><small>${sub}</small></span><span class="glass tg-more">•••</span></div>`)
  phone.insertAdjacentHTML("beforeend", `
    <div class="tg-compose"><span class="glass tg-round">${ICONS.clip}</span><span class="glass tg-field">Message in ${topic}${ICONS.sticker}</span><span class="glass tg-round">${ICONS.mic}</span></div>`)
}

function discord(win) {
  const { server = "hex", channels = "general research dev", channel = "dev", thread } = win.dataset
  const list = channels.split(" ").map(name => `<span${name === channel ? ' class="on"' : ""}># ${name}</span>`).join("")
  const head = thread ? `<i>⌗</i>${thread} <small>in #${channel}</small>` : `<i>#</i>${channel}`
  win.insertAdjacentHTML("afterbegin", `
    <div class="dc-title">${lights}${server}</div>
    <div class="dc-rail"><span class="srv on"><img src="../../site/icon.svg" alt=""></span><span class="srv"></span><span class="srv"></span></div>
    <div class="dc-side"><b class="dc-server">${server}</b><div class="dc-channels">${list}</div><div class="dc-user"><span class="dc-av"></span><span>you<small>Online</small></span></div></div>`)
  const main = document.createElement("div")
  main.className = "dc-main"
  main.append(...win.querySelectorAll(":scope > .dc-feed"))
  main.insertAdjacentHTML("afterbegin", `<div class="dc-head">${head}</div>`)
  main.insertAdjacentHTML("beforeend", `<div class="dc-compose"><i>+</i>Message ${thread ? thread : `#${channel}`}</div>`)
  win.append(main)
}

function buzz(win) {
  const { channel = "team", channels = "general team research", people = "3" } = win.dataset
  const list = channels.split(" ").map(name => `<span${name === channel ? ' class="on"' : ""}><i>#</i>${name}</span>`).join("")
  win.querySelectorAll(".by").forEach(by => by.insertAdjacentHTML("afterbegin", ICONS.bot))
  const main = document.createElement("div")
  main.className = "bz-main"
  main.append(...win.children)
  main.insertAdjacentHTML("afterbegin", `<div class="bz-head"><b><i>#</i>${channel}</b><span>${ICONS.people}${people}</span><span>${ICONS.more}</span></div>`)
  main.insertAdjacentHTML("beforeend", `
    <div class="bz-compose">Message #${channel}<div>${ICONS.at}${ICONS.clip}${ICONS.mic}${ICONS.smile}<span class="send">${ICONS.up}</span></div></div>`)
  win.insertAdjacentHTML("afterbegin", `
    <div class="bz-title">${lights}${ICONS.sidebar}${ICONS.back}${ICONS.forward}</div>
    <div class="bz-side"><span class="bz-search">${ICONS.search}Search</span><span>${ICONS.inbox}Inbox</span><span>${ICONS.bot}Agents</span><small>Channels</small>${list}</div>`)
  win.append(main)
}

function wave(el) {
  el.innerHTML = [...Array(24)].map((_, i) => `<i style="height:${4 + Math.round(16 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6)))}px"></i>`).join("")
}

document.querySelectorAll(".phone").forEach(telegram)
document.querySelectorAll(".wave").forEach(wave)
document.querySelectorAll(".dc-win").forEach(discord)
document.querySelectorAll(".bz-win").forEach(buzz)
