# iikb

Your Telegram with hex, its DM and topics, as chats in [iikb](https://github.com/AVGVSTVS96/iikb), an iOS keyboard, so you can read and write to hex from any app. The hub answers iikb's [extension protocol](https://github.com/AVGVSTVS96/iikb/blob/main/docs/extensions.md) itself, behind a door on `127.0.0.1:2593` (`IIKB_PORT`) that stays up while the hub restarts:

```
iikb keyboard ── https (your tailnet) ──► door: 127.0.0.1:2593 ──► hub: channels/iikb ──► the Telegram thread and its session
```

- `GET /` lists Telegram's threads: the DM and General first, then the topics by their latest message, each with its last line.
- `GET /<app>:<thread>?after=<version>` is the chat as Telegram shows it: edits in place, a poll with its options, and no reactions, button taps or votes, then the owner's words its session hasn't taken yet, marked pending. A message's photos and files come as `files: [{ name, url, type? }]`, each `url` relative to this address and fetched with the same token. With `after`, the answer waits up to 25 seconds for the next message.
- `POST /<app>:<thread> { text, id, files? }` hands your words to the thread as the owner's, from `iikb`, keyed by `id`, so a retry delivers once. Telegram shows them in the thread: your name over your words. `files` holds up to ten photos, `{ type, data, width?, height? }`, a JPEG or PNG in base64 with its pixels: they're kept in `state/iikb/photos` and reach the thread as photos sent in Telegram do, so the session sees them and Telegram shows them as an album with your words as its caption.

The chats are Telegram's threads, so iikb holds none of its own and starts no session. Set `IIKB_TOKEN` in `~/hex/.env` to require `Authorization: Bearer <token>`.

## The door

`bin/hex run` keeps `door.ts` on the port for as long as hex runs on the machine, so the address answers while the hub restarts. The keyboard has no clock to try a refused read again on: it asks again only as an answer comes.

```
door.ts ── state/iikb/chats.sock ──► the hub's channel
        ◄── state/iikb/door.sock ── each hub, as it comes up
```

- A request goes to the hub, and its answer back, as they are.
- One that finds no hub, or whose hub stops before answering, waits at the door for the next hub: a read gets the chat as it is now, and a send goes once, by its `id`.
- The door is replaced only when `door.ts` changes, and stops with hex. The address refuses then, as it does while hex runs on another machine.

The keyboard waits 60 seconds for an answer (40 on Android), so a hub away longer than that still fails the read.

## Set up

1. Put it on your tailnet: `tailscale serve --bg --set-path /hex 2593`.
2. In the iikb app: Settings › iikb › Extensions › Add Extension, named hex, at `https://<machine>.<tailnet>.ts.net/hex`, with the token if you set one.
