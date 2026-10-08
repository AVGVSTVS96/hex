# vault

How hex asks for a secret without it passing through chat or the model, and where it keeps it.

```
hex: vault ask GitHub username password
 │   makes a one-time key pair, keeps the private half in state/vault/pending/
 │   prints https://<relay>/d/<slug>#a=hex&n=GitHub&f=username,password&k=<public key>
 ▼
you: open the link, type, send
 │   the page encrypts to the public key in the # part, which never reaches the relay
 │   the relay stores the encrypted bytes, once
 ▼
hex: vault wait GitHub
     hears the relay's update, takes the bytes (the relay deletes them), decrypts, saves
```

The relay only ever holds encrypted bytes, and every link works once and is gone after 10 minutes. The key comes from hex's link, never the relay, so a relay can't swap in its own.

## The relay

`convex/` is the relay and its page, a [Convex](https://convex.dev) app: one table, no dependencies in the page, the browser's own crypto (X25519, HKDF, AES-GCM). hex uses a hosted one by default. To run your own:

```sh
npx convex deploy
```

then set `HEX_VAULT_CONVEX_URL` in `~/hex/.env` to the `.convex.cloud` URL it prints.

## Plugins

`bin/vault` talks to two programs. `relay` and `store` here are the defaults; point `HEX_VAULT_RELAY` or `HEX_VAULT_STORE` in `~/hex/.env` at your own to replace one (a path relative to `~/hex` works). Both get `HEX_DIR`, the user's hex folder.

**Relay**

| Command | Does |
|---|---|
| `relay open` | Prints `{"id": "...", "url": "https://..."}`. `id` is yours to use however you like; the page lives at `url` |
| `relay wait <id>` | Prints what the page posted once someone sends it, and exits 1 if the link expires first |
| `relay close <id>` | Drops the link |

The page at `url` posts the sealed text to its own path; any relay serving `convex/page.ts` the same way works.

**Store**

| Command | Does |
|---|---|
| `store put <name>` | Saves the JSON object on stdin, merged with what's already saved |
| `store get <name> <field>` | Prints one value, only ever piped into `vault fill` |
| `store list` | One line per item: `name: field, field` |

The default store keeps each item as `~/hex/vault/<name>.sealed`, encrypted with the key in `~/hex/state/vault/key`.
