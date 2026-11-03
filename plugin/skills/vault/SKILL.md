---
name: vault
description: Get a password, key, 2FA code or passkey from the vault, type one into a sign-in on hex's computer, or ask the person for one by link; and set the vault up from their password manager. Use whenever a task needs a secret or a login, when setting hex up, or when they mention their password manager.
---

# The vault

hex's vault is [enclave](https://github.com/AVGVSTVS96/enclave): `.hex/bin/vault` runs it and adds typing on hex's computer.

## Every day

Look in the vault first: `.hex/bin/vault list <site or name>` finds saved logins by name or website, with their fields and never their values.

- `.hex/bin/vault fill <name> <field>` types a saved value (`totp`: the current code) into the focused field on your computer, so you never read it.
- `.hex/bin/vault run KEY=<name>/<field> <command>` runs a command with the secret in its environment, hidden in its output.
- `.hex/bin/vault passkey <name>` lets your computer's browser sign in once with a saved passkey: run it, then click the site's passkey sign-in within 5 minutes.
- `<command> | .hex/bin/vault save <name> <field>` keeps a value you just made, like a new API token, without it passing through your context.

When the vault doesn't have it, ask me: run `.hex/bin/vault ask <name> <field…>` (a `totp` field asks for a 2FA setup key), send me the link it prints, and run `.hex/bin/vault wait <name>` in the background until it says `saved`. What I type goes straight into your vault, never through chat or your context. The link works once, for 24 hours; if the wait stops, run it again and it picks up the same link.

If I paste a secret in chat, tell me it's in this chat's log now and send me a link instead.

## Bring in their password manager

Ask which one they use, then:

- **Proton Pass.** Run `pass-cli login` (install it from proton.me/pass/download if it's missing) and send them the link it prints, saying to open it in a browser rather than the Proton app and sign in within 10 minutes. Once `pass-cli info` works, run `.hex/bin/vault import proton`, which copies every vault. Then `pass-cli logout`, so nothing stays signed in as them. Proton keeps everything; running the import again later brings in what changed and keeps every item's name.
- **Anything else.** enclave has no importer for it yet. Ask by link for each login as hex needs it (`.hex/bin/vault ask`), and tell them a bulk import would need one written.

Afterwards, `.hex/bin/vault list` shows what came in. Tell them the counts.

## Passkeys on hex's computer

A saved passkey signs in through enclave's Chrome extension, which sends the site's request to the vault so the key never enters the browser.

The computer's browser reaches the vault over `ssh`, with a key and no password, so set that up from the computer to here first. Then:

1. Here, run `command -v enclave` for the path to sign with (install it with `bun add -g enclave-link` if it's missing).
2. Inside the computer, clone enclave and run `extension/install ssh -o BatchMode=yes <user>@<this machine> <that path> sign`, then restart Chrome.
3. Check the path: inside the computer, `echo '{"origin":"https://example.com","challenge":"AA"}' | ssh -o BatchMode=yes <user>@<this machine> <that path> sign` should answer `no passkey is ready for example.com`.
4. Sign in once on a site they have a passkey for in the vault, with `.hex/bin/vault passkey <name>`.

## The key

The vault's key is `~/.enclave/key.json`. Tell them to back it up somewhere safe: without it the saved items can't be opened.
