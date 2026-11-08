import { z } from "zod";

import { tool } from "../../hub/hub.ts";
import type { ChannelServer } from "../../hub/hub.ts";

const titleField = z.string().describe('One word, like a chat name ("Anchors", "Frontier").');
const names = z.array(z.string());

export const tools = [
  tool({
    name: "reply",
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Reply in this Discord thread, or post in another one by name. Optionally pass reply_to (message_id) for threading, files (absolute paths) to attach images or other files, silent to send without a notification, and buttons for tappable choices.",
    input: z.object({
      text: z.string(),
      thread: z.string().describe("Thread name to post in instead of this thread.").optional(),
      reply_to: z
        .string()
        .describe(
          "Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch_messages.",
        )
        .optional(),
      files: names
        .describe("Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each.")
        .optional(),
      silent: z.boolean().describe("Send without a push notification.").optional(),
      buttons: names
        .describe(
          'Button labels shown under the message (max 25, 80 chars each). A tap comes back as a message with button="true", and the buttons then lock showing the choice. When you have a pick, end its label with (my pick).',
        )
        .optional(),
      multiple: z
        .boolean()
        .describe(
          "Show the buttons as a menu where any number can be picked at once (labels up to 100 chars). The picks come back as one message.",
        )
        .optional(),
    }),
  }),
  tool({
    name: "react",
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Add an emoji reaction to a Discord message, or take the bot's own off with remove. Unicode emoji work directly; custom emoji need the <:name:id> form.",
    input: z.object({
      message_id: z.string(),
      emoji: z.string(),
      remove: z.boolean().describe("Remove the bot's reaction instead of adding it.").optional(),
    }),
  }),
  tool({
    name: "edit_message",
    description:
      "Edit a message the bot previously sent: its text, its files, or both. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
    input: z.object({
      message_id: z.string(),
      text: z.string().optional(),
      files: names
        .describe("Absolute file paths that replace the message's attachments.")
        .optional(),
      settled: z
        .boolean()
        .describe(
          "true once the user has answered the question this message asked with buttons, or it no longer stands: its buttons come off and it stops waiting on the user. Without it, an edit keeps a question's buttons.",
        )
        .optional(),
    }),
  }),
  tool({
    name: "delete_message",
    description: "Delete a message the bot sent.",
    input: z.object({ message_id: z.string() }),
  }),
  tool({
    name: "pin",
    description:
      "Post this thread's status post and pin it in place of the last one. Its note is the whole scope of the work in a few short markdown lines: what it is, its links, every part planned and where each stands. Keep it current: edit_message on the post the moment the scope or where it stands changes. hex lists the thread's waiting questions, open tasks and last done under it and keeps those current. unpin: true unpins it.",
    input: z.object({
      note: z
        .string()
        .describe("the status post's note: the work's whole scope, in markdown")
        .optional(),
      message_id: z
        .string()
        .describe("with unpin: a message to unpin other than the status post")
        .optional(),
      unpin: z.boolean().optional(),
    }),
  }),
  tool({
    name: "forward",
    description:
      "Forward a message from this thread into another thread or a channel, as a Discord forward.",
    input: z.object({
      message_id: z.string(),
      thread: z.string().describe("Thread to forward into, by name.").optional(),
      channel: z.string().describe("Channel to forward into instead, by name or id.").optional(),
    }),
  }),
  tool({
    name: "poll",
    description: "Post a Discord poll in this thread. It runs for 24 hours.",
    input: z.object({
      question: z.string().describe("Max 300 characters."),
      options: names.describe(
        "1–10 answers, 55 characters each. When you have a pick, end its answer with (my pick).",
      ),
      multiple: z.boolean().describe("Allow picking more than one answer.").optional(),
    }),
  }),
  tool({
    name: "download_attachment",
    annotations: { readOnlyHint: true },
    description:
      "Download attachments from a message in this thread to the local inbox. Use after the inbound meta or fetch_messages shows a message has attachments. Returns file paths ready to Read.",
    input: z.object({ message_id: z.string() }),
  }),
  tool({
    name: "fetch_messages",
    annotations: { readOnlyHint: true },
    description:
      "Fetch recent messages from this thread, or from a channel or another thread. Returns oldest-first with message IDs. In a channel, a message that has a thread shows its reply count and last reply; pass its id as thread to read the thread. A forum channel lists its posts; pass a post's id as thread to read it.",
    input: z.object({
      channel: z
        .string()
        .describe('Channel to read instead of this thread, by name ("open-source") or id.')
        .optional(),
      thread: z
        .string()
        .describe(
          "Thread to read instead of this thread: the id of the message it hangs off, or its name.",
        )
        .optional(),
      before: z
        .string()
        .describe(
          "Message ID: only messages older than it. Pass the oldest ID you have to page back.",
        )
        .optional(),
      limit: z.number().describe("Max messages (default 20, Discord caps at 100).").optional(),
    }),
  }),
  tool({
    name: "search_messages",
    annotations: { readOnlyHint: true },
    description:
      "Search messages across the Discord server by their text, newest first, with where each one is. Page with offset.",
    input: z.object({
      query: z.string(),
      channel: z.string().describe("Only search this channel, by name or id.").optional(),
      limit: z.number().describe("Max results (default and cap 25).").optional(),
      offset: z.number().describe("Skip this many results, to page on.").optional(),
    }),
  }),
  tool({
    name: "list_channels",
    annotations: { readOnlyHint: true },
    description:
      "List the Discord text, announcement and forum channels you can read, with their IDs.",
    input: z.object({}),
  }),
  tool({
    name: "rename_thread",
    description: "Rename this thread.",
    input: z.object({ title: titleField }),
  }),
  tool({
    name: "close_thread",
    description:
      "Archive a thread whose work is done and stop its session once it is idle. Defaults to this thread. A new message in it unarchives it and resumes the session.",
    input: z.object({
      thread: z.string().describe("Thread name to close instead of this thread.").optional(),
    }),
  }),
  tool({
    name: "new_thread",
    description:
      "Open a new thread, start a fresh session for it, and give that session the prompt as its first message.",
    input: z.object({
      title: titleField,
      prompt: z
        .string()
        .describe(
          "The user's request and the context the new session can't find itself: it starts from this prompt alone.",
        ),
      about: z
        .string()
        .describe(
          "One line the user sees first in the new thread, saying what it is for and where it came from.",
        ),
      app: z
        .enum(["discord", "telegram", "buzz"])
        .describe("Where to open it. Default: discord.")
        .optional(),
      channel: z
        .string()
        .describe(
          "Channel to open it in, by name: a text or forum channel. Defaults to this thread's channel; in Buzz, its #general.",
        )
        .optional(),
      tags: names.describe("Forum channel only: the post's tags, by name.").optional(),
    }),
  }),
  tool({
    name: "handoff",
    description:
      "Move this conversation to another app when the user asks. It opens a thread there, and this session stops here once the turn ends and resumes there with its full memory (in T3 Code, with the user's next message there). The title defaults to this thread's name.",
    input: z.object({
      to: z.enum(["telegram", "buzz", "t3"]),
      title: titleField.optional(),
      channel: z
        .string()
        .describe("Buzz only: the channel to open it in, by name. Default: its #general.")
        .optional(),
    }),
  }),
] as const;

export const server: ChannelServer = {
  title: "Discord",
  permission: true,
  instructions: [
    "The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat. Nobody watches this terminal either, so the report a background job ends with goes to them as a reply: what they need to know and act on. Once it's sent, end the turn without repeating it here.",
    "",
    'This session is one Discord thread, the place for deeper work. Discord renders Markdown, so answers can be longer and structured: headings (#, ##, ###), lists, quotes, bold and italic, and code blocks with a language (```ts) for syntax highlighting. It has no tables: use a list, or line columns up in a code block. -# at the start of a line makes it small grey subtext, [text](https://...) masks a link, and a link wrapped in <> shows no preview. Its messages arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">, and everything you send with these tools lands back in that same thread. If the tag has new_thread="true", this thread was just opened from that message and named after its first word: give it a fitting name with rename_thread first. If the tag has image_path, Read it: those are the images the sender attached, already downloaded. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(message_id) to fetch the other files. If the tag has reply_to_message_id, the sender replied to that earlier message: reply_to_text is its text and reply_to_attachments lists its files (download_attachment with that id). edited="true" means the sender edited the message with that message_id and this is its new text; forwarded="true" means it is a message they forwarded. stickers lists sent stickers with their image URLs; poll is a poll question, with poll_options and poll_multiple when several answers are allowed. post_title is the title of a new forum post. A reaction arrives as "(reaction: 👍)" with reaction, reaction_to_message_id, reaction_to_user and reaction_to_text, plus reaction_removed="true" when taken off. deleted="true" means the message with that message_id was deleted, with deleted_text when known. button="true" means the sender tapped the button with this label on button_message_id, or picked these labels (joined by "; ") from its menu. answered_in says a question was answered somewhere else, in hex\'s app or on a call, and took_back that an answer given there no longer stands. A vote on your poll arrives as "(vote: Tacos)" with vote, poll and poll_message_id, plus vote_removed="true" when taken back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply.',
    "",
    'reply accepts file paths (files: ["/abs/path.png"]) for attachments, silent: true to skip the notification, and buttons: ["Yes", "No"] for tappable choices; with multiple: true they come as a menu where the user picks any number of them. Use react to add emoji reactions, and edit_message for interim progress updates or to swap a sent file. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
    "",
    'new_thread opens another thread with its own fresh session and hands it your prompt. Use it for work the user will want to follow or talk to on its own. In a forum channel it opens a post, with tags if you name them. With app: "telegram" or "buzz" it opens the thread there instead. handoff moves this whole conversation to Telegram or Buzz when the user asks: you stop here and continue there with your memory.',
    "",
    "fetch_messages pulls real Discord history, from this thread by default. The tag's channel attribute names the channel this thread is in: fetch_messages(channel) reads that channel's top-level messages, a message with a thread shows its reply count, and fetch_messages(thread: that message's id) reads the thread. When the user refers to earlier work or talk in the channel, read it rather than saying you can't see it. To find an old message anywhere in the server, use search_messages.",
  ].join("\n"),
  tools,
};
