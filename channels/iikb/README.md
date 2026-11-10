# iikb

Your Telegram with hex, its DM and topics, as chats in [iikb](https://github.com/AVGVSTVS96/iikb), an iOS keyboard, so you can read and write to hex from any app. The hub serves iikb's [extension protocol](https://github.com/AVGVSTVS96/iikb/blob/main/docs/extensions.md) itself, on `127.0.0.1:2593` (`IIKB_PORT`):

```
iikb keyboard ── https (your tailnet) ──► hub: channels/iikb ──► the Telegram thread and its session
```

- `GET /` lists Telegram's threads: the DM and General first, then the topics by their latest message, each with its last line.
- `GET /<app>:<thread>?after=<version>` is the chat as Telegram shows it: edits in place, a poll with its options, and no reactions, button taps or votes, then the owner's words its session hasn't taken yet, marked pending. A message's photos and files come as `files: [{ name, url, type? }]`, each `url` relative to this address and fetched with the same token. With `after`, the answer waits up to 25 seconds for the next message.
- `POST /<app>:<thread> { text, id, files? }` hands your words to the thread as the owner's, from `iikb`, keyed by `id`, so a retry delivers once. Telegram shows them in the thread: your name over your words. `files` holds up to ten photos, `{ type, data, width?, height? }`, a JPEG or PNG in base64 with its pixels: they're kept in `state/iikb/photos`, the session gets them as it gets photos sent in Telegram, and Telegram shows them as an album with your words as its caption.

The chats are Telegram's threads, so iikb holds none of its own and starts no session. Set `IIKB_TOKEN` in `~/hex/.env` to require `Authorization: Bearer <token>`.

## Set up

1. Put it on your tailnet: `tailscale serve --bg --set-path /hex 2593`.
2. In the iikb app: Settings › iikb › Extensions › Add Extension, named hex, at `https://<machine>.<tailnet>.ts.net/hex`, with the token if you set one.
