# iikb

Your hex threads as chats in [iikb](https://github.com/AVGVSTVS96/iikb), an iOS keyboard, so you can read and write to hex from any app. The hub serves iikb's [extension protocol](https://github.com/AVGVSTVS96/iikb/blob/main/docs/extensions.md) itself, on `127.0.0.1:2593` (`IIKB_PORT`):

```
iikb keyboard ── https (your tailnet) ──► hub: channels/iikb ──► the thread's own app and session
```

- `GET /` lists every thread a running app can take words for: the DM and General first, then the rest by their latest message, each with its last line.
- `GET /<app>:<thread>?after=<version>` is the chat: what was said, then the owner's words its session hasn't taken yet, marked pending. With `after`, the answer waits up to 25 seconds for the next message.
- `POST /<app>:<thread> { text, id }` hands your words to the thread's app as the owner's, from `iikb`, keyed by `id`, so a retry delivers once. The app shows them in the thread, as Telegram does in a topic: your name over your words.

The chats are other apps' threads, so iikb holds none of its own and starts no session. Set `IIKB_TOKEN` in `~/hex/.env` to require `Authorization: Bearer <token>`.

## Set up

1. Put it on your tailnet: `tailscale serve --bg --set-path /hex 2593`.
2. In the iikb app: Settings › iikb › Extensions › Add Extension, named hex, at `https://<machine>.<tailnet>.ts.net/hex`, with the token if you set one.
