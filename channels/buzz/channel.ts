import { z } from "zod";

import { tool, type ChannelServer } from "../../hub/hub.ts";

const title = z.string().describe('One word, like a chat name ("Anchors", "Frontier").');
const limit = z.number().describe("Max messages (default 20, max 100).");

export const tools = [
  tool({
    name: "reply",
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Reply in this Buzz thread, or post in another one by name. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.",
    input: z.object({
      text: z.string(),
      thread: z.string().describe("Thread name to post in instead of this thread.").optional(),
      reply_to: z
        .string()
        .describe(
          "Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch_messages.",
        )
        .optional(),
      files: z
        .array(z.string())
        .describe(
          "Absolute file paths to attach: images, MP4 video, PDFs or other files, but not audio. Max 100MB each.",
        )
        .optional(),
      buttons: z
        .array(z.string())
        .describe(
          'Choices the user can tap, at most 10, like ["Yes", "No"]. They show as a numbered list under the text. When you have a pick, end its label with (my pick).',
        )
        .optional(),
    }),
  }),
  tool({
    name: "react",
    _meta: { "anthropic/alwaysLoad": true },
    description: "Add an emoji reaction to a Buzz message, or take yours off.",
    input: z.object({
      message_id: z.string(),
      emoji: z.string(),
      remove: z.boolean().describe("Take your reaction with this emoji off instead.").optional(),
    }),
  }),
  tool({
    name: "delete_message",
    description: "Delete a message the bot sent.",
    input: z.object({ message_id: z.string() }),
  }),
  tool({
    name: "edit_message",
    description:
      "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
    input: z.object({ message_id: z.string(), text: z.string() }),
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
      "Fetch recent messages from this thread, or from a channel or another thread. Returns oldest-first with message IDs. In a channel, a message that has a thread shows its reply count and last reply; pass its id as thread to read the thread.",
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
      limit: limit.optional(),
    }),
  }),
  tool({
    name: "search_messages",
    annotations: { readOnlyHint: true },
    description:
      "Search the Buzz channels you are in for messages containing words, best matches first. Each row names its channel, and the thread a reply belongs to, for fetch_messages.",
    input: z.object({
      query: z.string(),
      channel: z.string().describe("Only search this channel, by name or id.").optional(),
      limit: limit.optional(),
    }),
  }),
  tool({
    name: "canvas",
    reads: (args) => args.text === undefined,
    description:
      "Read this channel's canvas, or replace it by passing text. Reading returns its Markdown and revision.",
    input: z.object({
      text: z.string().describe("The whole new canvas, in Markdown.").optional(),
      revision: z
        .string()
        .describe("The revision you read: the save is refused if the canvas changed since.")
        .optional(),
      channel: z
        .string()
        .describe("Channel whose canvas to use instead of this one, by name or id.")
        .optional(),
    }),
  }),
  tool({
    name: "presence",
    annotations: { readOnlyHint: true },
    description: "Whether the user is online, away or offline in Buzz right now.",
    input: z.object({}),
  }),
  tool({
    name: "list_channels",
    annotations: { readOnlyHint: true },
    description: "List the Buzz channels you are in, with their IDs. Direct messages are marked.",
    input: z.object({}),
  }),
  tool({
    name: "create_channel",
    description:
      "Create a Buzz channel. You own it and the user is added to it, so it shows up for them; open threads in it with new_thread.",
    input: z.object({
      name: z.string().describe('Channel name, like "research" or "open source".'),
      about: z.string().describe("One line on what the channel is for.").optional(),
      type: z
        .enum(["stream", "forum"])
        .describe("stream (default): a chat like #general. forum: every thread is a post.")
        .optional(),
      private: z
        .boolean()
        .describe("Only members can see it. Default: open to the workspace.")
        .optional(),
    }),
  }),
  tool({
    name: "rename_thread",
    description:
      "Name this thread. Buzz threads have no titles, so the name is for your thread list and handoffs; a thread you opened with new_thread also shows it as its first message.",
    input: z.object({ title }),
  }),
  tool({
    name: "close_thread",
    description:
      "Close a thread whose work is done and stop its session once it is idle. Defaults to this thread. Tagging the bot in it again starts a fresh session.",
    input: z.object({
      thread: z.string().describe("Thread name to close instead of this thread.").optional(),
    }),
  }),
  tool({
    name: "new_thread",
    description:
      "Open a new thread, start a fresh session for it, and give that session the prompt as its first message. The title is the thread's first message in Buzz.",
    input: z.object({
      title,
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
        .enum(["buzz", "discord", "telegram"])
        .describe("Where to open it. Default: buzz.")
        .optional(),
      channel: z
        .string()
        .describe(
          "Channel to open it in, by name. Defaults to this thread's channel; in Discord, the server's system channel.",
        )
        .optional(),
    }),
  }),
  tool({
    name: "handoff",
    description:
      "Move this conversation to another app when the user asks. It opens a thread there, and this session stops here once the turn ends and resumes there with its full memory (in T3 Code, with the user's next message there). The title defaults to this thread's name.",
    input: z.object({
      to: z.enum(["telegram", "discord", "t3"]),
      title: title.optional(),
      channel: z
        .string()
        .describe(
          "Discord only: the channel to open it in, by name. Default: the server's system channel.",
        )
        .optional(),
    }),
  }),
] as const;

export const server: ChannelServer = {
  title: "Buzz",
  instructions: [
    "The sender reads Buzz, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat. Nobody watches this terminal either, so the report a background job ends with goes to them as a reply: what they need to know and act on. Once it's sent, end the turn without repeating it here.",
    "",
    'This session is one Buzz thread or direct message, the place for deeper work. Buzz renders Markdown, so answers can be longer and structured: headings, lists, and code blocks with a language. Its messages arrive as <channel source="buzz" chat_id="..." message_id="..." user="..." ts="...">, and everything you send with these tools lands back in that same thread. If the tag has new_thread="true", name this thread with rename_thread. If you were tagged into a thread that was already going, reply_to_* is the message it hangs off ("(tagged you)" alone means: read that message) and fetch_messages shows the rest. In a forum channel each post is its own thread: comments on it arrive here, and your replies post as comments on it. If the tag has image_path, Read every file it lists (separated by "; "): images sent from hex\'s app, with a line in the message for each photo or video they come from, a video\'s being stills across it in order. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(message_id) to fetch them. If the tag has reply_to_message_id, the sender replied to that earlier message: reply_to_text is its text and reply_to_attachments lists its files (download_attachment with that id). edited="true" means the sender edited the message with that message_id and this is its new text. A reaction arrives as "(reaction: 👍)", or "(reaction removed: 👍)" with reaction_removed="true", with reaction_to_message_id, reaction_to_user and reaction_to_text naming the message it is on. deleted="true" means the sender deleted the message with that message_id; deleted_text is what it said. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply.',
    "",
    'reply accepts file paths (files: ["/abs/path.png"]) for attachments, and buttons (up to 10 short labels) to offer choices the user taps: a tap arrives with button="true" and button_message_id, and the chosen label as its text. Use react to add emoji reactions (remove: true takes yours off), edit_message for interim progress updates, and delete_message to take back a message you sent. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
    "",
    "Each channel has one shared canvas, a Markdown document the user opens from the channel's details: canvas() reads it with its revision, and canvas(text, revision) replaces it, refused if someone changed it since that revision. presence tells you whether the user is online, away or offline.",
    "",
    'new_thread opens another thread with its own fresh session and hands it your prompt. Use it for work the user will want to follow or talk to on its own. With app: "discord" or "telegram" it opens the thread there instead. handoff moves this whole conversation to Telegram or Discord when the user asks: you stop here and continue there with your memory.',
    "",
    "fetch_messages pulls real Buzz history, from this thread by default. The tag's channel attribute names the channel this thread is in: fetch_messages(channel) reads that channel's top-level messages, a message with a thread shows its reply count, and fetch_messages(thread: that message's id) reads the thread. When the user refers to earlier work or talk in the channel, read it rather than saying you can't see it. search_messages finds older messages by their words.",
  ].join("\n"),
  tools,
};
