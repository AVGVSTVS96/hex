---
name: widget
description: Write and send a Telegram widget, a small live app inside a message (a board, a tracker, a picker, a game), and keep it current. Use before calling the widget tool, and when a widget's request arrives.
---

# Widgets

A widget is one HTML file with its CSS and JS inline, sent with the `widget` tool and drawn inside a Telegram message on every app. Its code is fixed once sent. What changes is its state, two strings of up to 1024 bytes (usually JSON) that only you write:

- `chat_data`: this message's state.
- `public_data`: the same wherever the widget shows, forwards included.

`widget` sends the first state. `edit_message` with the widget's `message_id` and a new `chat_data` or `public_data` changes it (an empty string clears one): the widget gets `chatDataChanged` or `publicDataChanged` and redraws in place, silently.

## Requests

`TelegramWidget.request(data)`, with 1-64 bytes, reaches this thread as `(widget: <data>)`, with `widget_message_id` to edit and `widget_caption`. hex answers it at once, so the widget's promise resolves with `result: null` once you have it, or with a short reason when it didn't reach you. Show "sent" on null and wait for your new state.

Each request is a turn of yours. Call `request` in a tap's click handler only: one made at start or on a timer goes out every time the widget comes on screen. What a tap can settle inside the widget, like tabs, pages or a local game move, stays in the widget.

## Writing one

Telegram's rules for models writing widgets are the "Writing widgets with an LLM" block of https://core.telegram.org/bots/widgets.md. Read it before writing one:

```sh
curl -s https://core.telegram.org/bots/widgets.md | awk '/^### Writing widgets with an LLM/{p=1} p&&/^### /&&!/Writing/{exit} p'
```

What trips widgets up most:

- **Size**: at most 32768 bytes, and 4096 after zlib level 9, which is usually the one you hit. Measure as Telegram does: `python3 -c 'import sys,zlib; d=open(sys.argv[1],"rb").read(); print(len(d), len(zlib.compress(d,9)))' widget.html`. No comments, short names, repeated patterns over varied ones.
- **The bubble**: 200-600px wide (design for 320), at most 600px tall, and nothing scrolls inside, so long content goes in pages or tabs. The bubble's color shows through; build colors on the `--tg-theme-*` variables so light and dark both work.
- **What's gone**: network, named fonts, form inputs and the keyboard, images from URLs (data: images work), vertical drags. Taps, pointer events and horizontal drags work.
- `window.TelegramWidget` is undefined outside Telegram, so check it; `chatData` and `publicData` are strings or null, so parse them in try/catch.

The guide's "A first look in a browser" has a stand-in for `TelegramWidget`, for a screenshot at 320px before you send.

Telegram shows widgets only in private chats for now. From a group topic, `widget` sends it to the owner's DM with a button back to the topic, and its requests still come to the topic.
