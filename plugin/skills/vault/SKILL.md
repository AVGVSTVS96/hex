---
name: vault
description: Get a password, key, 2FA code or passkey from the vault, type one into a sign-in on hex's computer, or ask the person for one by link; and set the vault up from their password manager. Use whenever a task needs a secret or a login, when setting hex up, or when they mention their password manager.
---

# The vault

hex's vault is [enclave](https://github.com/AVGVSTVS96/enclave): `.hex/bin/vault` runs it and adds typing on hex's computer.

## Every day

Look in the vault first: `.hex/bin/vault list <site>` finds saved logins by name or website, with their fields and without their values. Search by the bare name (`github`, not `github.com`), since logins saved by link have no website field.

- `.hex/bin/vault fill <name> <field>` types a saved value (`totp`: the current code) into the focused field on your computer, without you reading it.
- `.hex/bin/vault run KEY='<name>/<field>' sh -c '<command using "$KEY">'` runs a command with the secret in its environment, hidden in its output. The single quotes keep your own shell from expanding `$KEY` first.
- `.hex/bin/vault passkey <name>` lets your computer's browser sign in once with a saved passkey: run it, then click the site's passkey sign-in within 5 minutes.
- `value=$(<command>) && printf %s "$value" | .hex/bin/vault save '<name>' <field>` keeps a value you just made, like a new API token, without it passing through your context. It saves when the command exits cleanly, so make a failed request exit with an error (`curl -f`, `jq -er`).

When the vault doesn't have it, ask me: run `.hex/bin/vault ask <name> <field…>` (a `totp` field asks for a 2FA setup key), send me the link it prints, and run `.hex/bin/vault wait <name>` in the background until it says `saved`. What I type goes straight into your vault, not through chat or your context. The link works once, for 24 hours; if the wait stops, run it again and it picks up the same link.

If I paste a secret in chat, tell me it's in this chat's log now and send me a link instead.

## Bring in their password manager

Ask which one they use, then:

- **Proton Pass.** Run `pass-cli login` (install it from proton.me/pass/download if it's missing) and send them the link it prints, saying to open it in a browser rather than the Proton app and sign in within 10 minutes. Once `pass-cli info` works, run `.hex/bin/vault import proton`, which copies every vault. Then `pass-cli logout`, so nothing stays signed in as them. Proton keeps everything; running the import again later brings in what changed. An item keeps its name unless it's renamed in Proton, and fields hex saved onto it stay until it's deleted there.
- **Anything else.** enclave has no importer for it yet. Ask by link for each login as hex needs it (`.hex/bin/vault ask`), and tell them a bulk import would need one written.

Afterwards, `.hex/bin/vault list` shows what came in. Tell them the counts.

## Passkeys on hex's computer

A saved passkey signs in through enclave's Chrome extension, which sends the site's request to the vault, so the key stays in the vault.

The computer's browser reaches the vault over `ssh`, with a key and no password, so set that up from the computer to here first. Then:

1. Here, run `node -p process.execPath` and `readlink -f "$(command -v enclave)"` for the two paths to sign with (install or update enclave with `npm install -g enclave-link@latest`). A command over ssh gets a short PATH, so it needs both in full.
2. Inside the computer, clone enclave and run `extension/install ssh -o BatchMode=yes <user>@<this machine> <node path> <enclave path> sign`, then restart Chrome.
3. Check the installed signer: here, run `.hex/bin/vault passkey <name>` for a site they have a passkey for. Inside the computer, `echo '{"origin":"https://<the passkey's domain>","challenge":"AA"}' | sh -c "$(jq -r '.command | @sh' ~/.local/share/enclave-extension/host.json)"` should print a signed answer starting with `{"id":`.
4. Run `.hex/bin/vault passkey <name>` again and sign in on that site once.

## The key

The vault's key is `~/.enclave/key.json`. Tell them to back it up somewhere safe: without it the saved items can't be opened.
