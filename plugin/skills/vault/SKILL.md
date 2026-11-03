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
- `.hex/bin/vault passkey <name> [field]` lets your computer's browser sign in once with a saved passkey: run it, then click the site's passkey sign-in within 5 minutes. An item with more than one has fields like `passkey 2` (`vault list <name>` shows them); quote one when you name it (`vault passkey GitHub 'passkey 2'`). Arm one passkey per site at a time: an arm stays live until it signs or 5 minutes pass.
- `value=$(set -o pipefail; <command>) && printf %s "$value" | .hex/bin/vault save '<name>' '<field>'` keeps a one-line value you just made, like a new API token, without it passing through your context. It saves when the command exits cleanly, so make a failed request exit with an error (`curl -f`, `jq -er`); if it doesn't print `saved`, revoke what you made, and make it again once `.hex/bin/vault list` works.

When the vault doesn't have it, ask me: run `.hex/bin/vault ask <name> <field…>` (a `totp` field asks for a 2FA setup key), send me the link it prints, and run `.hex/bin/vault wait <name>` in the background until it says `saved`. What I type goes straight into your vault, not through chat or your context. The link works once, for 24 hours; if the wait stops, run it again and it picks up the same link.

If I paste a secret in chat, tell me it's in this chat's log now and send me a link instead.

## Bring in their password manager

Ask which one they use, then:

- **Proton Pass.** Run `pass-cli login` (install it from proton.me/pass/download if it's missing) and send them the link it prints, saying to open it in a browser rather than the Proton app and sign in within 10 minutes. Once `pass-cli info` works, run `.hex/bin/vault import proton`, which copies every vault. Then `pass-cli logout`, so nothing stays signed in as them. Proton keeps everything; running the import again later brings in what changed. An item keeps its name unless it's renamed in Proton. A value hex saves over one of Proton's stays until that field changes in Proton, and fields hex added go when the item is deleted there. So save a token hex makes under a name of its own (like `GitHub token`), and when hex changes a password, save it into its item and ask them to change it in Proton too.
- **Anything else.** enclave has no importer for it yet. Ask by link for each login as hex needs it (`.hex/bin/vault ask`), and tell them a bulk import would need one written.

Afterwards, `.hex/bin/vault list` shows what came in. Tell them the counts.

## Passkeys on hex's computer

A saved passkey signs in through enclave's Chrome extension, which sends the site's request to the vault, so the key stays in the vault.

The computer's browser reaches the vault over `ssh`, with a key of its own that can only sign. Set it up from the computer to here:

1. Here, with node 22 or newer, run `npm install -g enclave-link@^0.2.13` (or `bun add -g enclave-link@^0.2.13`; 0.2.13 is the first release whose extension carries its version), then `node -p process.execPath` and `readlink -f "$(command -v enclave)"` for the two paths to sign with. A command over ssh gets a short PATH, so it needs both in full. After a node upgrade on either machine, or after enclave here is updated, run these steps again; after this machine is rebuilt, first run `ssh-keygen -R <this machine>` on the computer (`'[<this machine>]:<port>'` if ssh isn't on port 22).
2. On the computer (it needs node too), make the signing key if it has none yet: `ssh-keygen -t ed25519 -N '' -f ~/.ssh/enclave_sign`.
3. Here, add that key's `.pub` line to `~/.ssh/authorized_keys` (replacing its old line on a rerun), starting it with `restrict,command="<node path> <enclave path> sign" ` (single-quote a path with a space), so the key can run `enclave sign` and nothing else. If hex sets `ENCLAVE_HOME` anywhere (its environment, `.env` or a settings file), put `env ENCLAVE_HOME=<its full path>` at the start of that command. If an older setup gave the computer a key here with a full shell, remove that key's line too, unless they use it on purpose.
4. On the computer, check out enclave at the release this machine signs with, so the extension matches its signer: `git clone https://github.com/AVGVSTVS96/enclave ~/enclave` if it isn't there yet, then `git -C ~/enclave fetch --tags && git -C ~/enclave checkout v<enclave --version here>`. Then run `~/enclave/extension/install ssh -i '~/.ssh/enclave_sign' -o IdentitiesOnly=yes -o ControlPath=none -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new <user>@<this machine> sign` (with `-p <port>` just before `<user>@` if ssh here isn't on port 22), then restart Chrome.
5. Check the installed signer: here, run `.hex/bin/vault passkey <name>` for a site they have a passkey for. On the computer, `echo '{"origin":"https://<the exact domain the passkey was made for, usually the main one, like google.com rather than accounts.google.com>","challenge":"AA"}' | sh -c "$(jq -r '.command | @sh' "${XDG_DATA_HOME:-$HOME/.local/share}/enclave-extension/host.json")"` should print a signed answer starting with `{"id":`. Apart from ssh noting it added the host, anything printed before it comes from the vault account's shell startup files, which need to stay quiet. A try that signs uses up the arm, so run `vault passkey` again before the next.
6. Once that works, run `.hex/bin/vault passkey <name>` again and sign in on that site once.

## The key

The vault's key is `$ENCLAVE_HOME/key.json` (`~/.enclave/key.json` by default). Tell them to back it up somewhere safe: without it the saved items can't be opened.
