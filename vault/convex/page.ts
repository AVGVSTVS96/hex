export const page = (state: string, nonce: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Secure form</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --fg: #1b1b1f; --muted: #6b6b76; --line: #d9d9e0; --bg: #f6f6f8; --card: #fff; --accent: #2f6df6; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f1f1f4; --muted: #9a9aa6; --line: #34343c; --bg: #111114; --card: #1b1b20; --accent: #5b8cff; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--fg); font: 18px/1.5 system-ui, -apple-system, sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 32px 28px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; overflow-wrap: anywhere; }
  p { margin: 0 0 24px; color: var(--muted); }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  .field { position: relative; margin-bottom: 20px; }
  input { width: 100%; font: inherit; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: transparent; color: inherit; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .field:has(.show) input { padding-right: 76px; }
  .show { position: absolute; right: 8px; bottom: 11px; font: inherit; font-size: 15px; padding: 6px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--accent); cursor: pointer; }
  .send { width: 100%; font: inherit; font-weight: 600; padding: 16px; border: 0; border-radius: 12px; background: var(--accent); color: #fff; cursor: pointer; }
  .send:disabled { opacity: .6; }
  .lock { margin: 20px 0 0; font-size: 15px; text-align: center; }
</style>
</head>
<body data-state="${state}">
<main></main>
<script nonce="${nonce}">
const hash = new URLSearchParams(location.hash.slice(1))
const agent = hash.get("a") || "Your assistant"
const name = hash.get("n")
const fields = (hash.get("f") || "").split(",").filter(Boolean)
const key = hash.get("k")
const main = document.querySelector("main")

const labels = { username: "Username", email: "Email", password: "Password", totp: "2FA setup key" }
const label = (field) => labels[field] || field.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase())
const visible = { username: ["text", "username"], email: ["email", "email"] }

function show(title, text) {
  main.replaceChildren(Object.assign(document.createElement("h1"), { textContent: title }), Object.assign(document.createElement("p"), { textContent: text }))
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "")
const unb64 = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

async function seal(values) {
  const recipient = unb64(key)
  const theirs = await crypto.subtle.importKey("raw", recipient, { name: "X25519" }, false, [])
  const mine = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: theirs }, mine.privateKey, 256)
  const ephemeral = new Uint8Array(await crypto.subtle.exportKey("raw", mine.publicKey))
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
  const salt = new Uint8Array([...ephemeral, ...recipient])
  const info = new TextEncoder().encode(location.origin + location.pathname)
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(values)))
  return [ephemeral, iv, sealed].map(b64).join(".")
}

function form() {
  const form = document.createElement("form")
  form.append(
    Object.assign(document.createElement("h1"), { textContent: name }),
    Object.assign(document.createElement("p"), { textContent: agent + " is asking for this. Only " + agent + " can read what you type here, not even this website." }),
  )
  for (const field of fields) {
    const [type, autocomplete] = visible[field] || ["password", field === "password" ? "current-password" : "off"]
    const box = Object.assign(document.createElement("div"), { className: "field" })
    const input = Object.assign(document.createElement("input"), { name: field, id: field, type, autocomplete, required: true, autocapitalize: "none", spellcheck: false })
    box.append(Object.assign(document.createElement("label"), { htmlFor: field, textContent: label(field) }), input)
    if (type === "password") {
      const toggle = Object.assign(document.createElement("button"), { type: "button", className: "show", textContent: "Show" })
      toggle.onclick = () => {
        input.type = input.type === "password" ? "text" : "password"
        toggle.textContent = input.type === "password" ? "Show" : "Hide"
      }
      box.append(toggle)
    }
    form.append(box)
  }
  const send = Object.assign(document.createElement("button"), { className: "send", textContent: "Send securely" })
  form.append(send, Object.assign(document.createElement("p"), { className: "lock", textContent: "🔒 Locked on this device before it's sent" }))
  form.onsubmit = async (event) => {
    event.preventDefault()
    send.disabled = true
    send.textContent = "Sending…"
    try {
      const values = Object.fromEntries(fields.map((field) => [field, form.elements[field].value]))
      const response = await fetch(location.pathname, { method: "POST", body: await seal(values) })
      if (response.status === 410) return show("This link was already used", "Ask " + agent + " for a new one if you still need to send this.")
      if (!response.ok) throw new Error()
      show("Sent", agent + " has it now. You can close this page.")
    } catch (error) {
      if (error.name === "NotSupportedError") return show("This browser is too old for this page", "Update it, or open the link in another browser.")
      send.disabled = false
      send.textContent = "Try again"
    }
  }
  main.replaceChildren(form)
  form.elements[fields[0]].focus()
}

const state = document.body.dataset.state
if (state === "used") show("This link was already used", "Ask " + agent + " for a new one if you still need to send this.")
else if (state === "gone") show("This link has expired", "Ask " + agent + " for a new one.")
else if (!name || !key || !fields.length) show("This link isn't complete", "Copy the whole link from " + agent + " and try again.")
else if (!crypto.subtle) show("This browser can't open this page", "Try it in Safari, Chrome or Firefox.")
else form()
</script>
</body>
</html>
`
