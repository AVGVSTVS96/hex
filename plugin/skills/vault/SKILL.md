---
name: vault
description: Set up hex's vault for the person and bring in the passwords, 2FA codes and passkeys they already keep in a password manager, so hex can sign in for them on its computer. Use when setting hex up, when they mention their password manager, or when a sign-in needs a login the vault doesn't have yet.
---

# Setting up the vault

hex's vault is [enclave](https://github.com/AVGVSTVS96/enclave): `.hex/bin/vault` runs it and adds typing on hex's computer. HEX.md's Secrets section is how to use it day to day; this is how to fill it.

## Bring in their password manager

Ask which one they use, then:

- **Proton Pass.** Run `pass-cli login` (install it from proton.me/pass/download if it's missing) and send them the link it prints, saying to open it in a browser rather than the Proton app and sign in within 10 minutes. Once `pass-cli info` works, run `pass-cli vault list`, and `.hex/bin/vault import proton <vault>` for each vault with items in it. Then `pass-cli logout`, so nothing stays signed in as them. Proton keeps everything; running it again later brings in what changed.
- **Anything else.** enclave has no importer for it yet. Ask by link for each login as hex needs it (`.hex/bin/vault ask`), and tell them a bulk import would need one written.

Afterwards, `.hex/bin/vault list` shows what came in: names and fields, never values. Tell them the counts.

## Passkeys on hex's computer

A saved passkey signs in through enclave's Chrome extension, which sends the site's request to the vault so the key never enters the browser. The extension signs with a counter of 0 every time, the same as Proton Pass, so the passkey keeps working from their own devices too.

The computer's browser must reach the machine the vault is on, so this needs `ssh` from the computer to here with a key and no password. Inside the computer, clone enclave and run `extension/install ssh <user>@<this machine> enclave sign`, then restart Chrome. Check it on webauthn.io: register a test passkey there, save it with `.hex/bin/vault ask`, and sign in once.

## The key

The vault's key is `~/.enclave/key.json`. Tell them to back it up somewhere safe: without it the saved items can't be opened.
