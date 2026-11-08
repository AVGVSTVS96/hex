import { EFFORTS, MODELS, type ChannelServer } from "../../hub/hub.ts";

const titleProperty = {
  type: "string",
  description: 'One word, like a chat name ("Anchors", "Frontier").',
};

const formatProperty = {
  type: "string",
  enum: ["markdown", "text", "markdownv2"],
  description:
    "Rendering mode. 'markdown' takes ordinary Markdown with no escaping: code blocks, inline code, bold, italic, links, strikethrough, lists, tables, headings. 'markdownv2' is Telegram's own syntax, where the caller escapes special chars. Default: 'text' (plain).",
};

// What each session's channel says and offers; the hub serves it over HTTP.
export const server: ChannelServer = {
  title: "Telegram",
  permission: true,
  instructions: [
    "The sender reads Telegram, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat. Nobody watches this terminal either, so the report a background job ends with goes to them as a reply: what they need to know and act on. Once it's sent, end the turn without repeating it here.",
    "",
    'This session is one Telegram thread: a forum topic, a group\'s General, or a direct chat. Its messages arrive as <channel source="telegram" chat_id="..." message_id="..." user="..." ts="...">, and everything you send with these tools lands back in that same thread. If the tag has an image_path attribute, Read that file — it is a photo the sender attached. If the tag has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path. If the tag has reply_to_message_id, the sender replied to that earlier message: reply_to_text is its text or caption, reply_to_quote the part they highlighted, reply_to_image_path a photo it carried (Read it), and reply_to_attachment_file_id a file it carried (download_attachment). edited="true" means the sender edited the message with that message_id and this is its new text; forwarded_from names who a forwarded message came from. A photo album arrives as one message: image_path and the attachment_* attributes then list one value per file, separated by "; ". A reaction arrives as (reaction: 👍) or (reaction removed: 👍), with reaction, reaction_removed="true" when taken off, and reaction_to_message_id, reaction_to_user and reaction_to_text for the message it was on. A button tap arrives as the button\'s label with button="true" and button_message_id, and a poll vote as (vote: ...) or (vote removed), with vote (the chosen options), vote_removed="true", poll_message_id and poll (its question). Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply.',
    "",
    'For formatted replies use format: "markdown" and write ordinary Markdown (code blocks, diagrams, bold, links, lists, tables), no escaping needed. reply accepts file paths (files: ["/abs/path.png"]) for attachments, silent: true to send without a notification, and buttons: ["Yes", "No"] for a yes or no. A choice between options goes in poll, which shows each option in full where buttons cut them off. Use react to add or remove emoji reactions, edit_message for interim progress updates or to change a file\'s caption or the file itself, delete_message, forward and poll as their names say, and pin to post this thread\'s status post. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
    "",
    'new_thread opens a new forum topic with its own fresh session and hands it your prompt. Use it for work the user will want to follow or talk to on its own. It only works in a group with topics, and rename_thread changes a topic\'s name or icon. With app: "discord" or "buzz" it opens a Discord or Buzz thread instead, the place for deep, long-form work. handoff moves this whole conversation to Discord or Buzz when the user asks: you stop here and continue there with your memory (from General, a copy continues there and you stay).',
  ].join("\n"),
  tools: [
    {
      name: "reply",
      _meta: { "anthropic/alwaysLoad": true },
      description:
        "Reply in this Telegram thread, or post in another one by name. Optionally pass reply_to (message_id) for threading, files (absolute paths) to attach images or documents, and buttons for a yes or no.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          thread: {
            type: "string",
            description:
              "Topic name to post in instead of this thread, e.g. to remind the user in the topic that is waiting on them.",
          },
          reply_to: {
            type: "string",
            description:
              "Message to quote, so a tap takes the user back to it: a message_id from this thread, or from any thread its key (telegram:<chat>:<id>).",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute file paths to attach. Images up to 10MB send as photos (inline preview); others as documents. Max 50MB each. Short text becomes the first file's caption.",
          },
          format: formatProperty,
          silent: { type: "boolean", description: "Send without a notification." },
          buttons: {
            type: "array",
            items: { type: "string" },
            description:
              'Labels of one- or two-word choices under the message, e.g. ["Yes", "No"]. A tap comes back as a message and leaves only the chosen label on it. When you have a pick, end its label with (my pick).',
          },
        },
      },
    },
    {
      name: "react",
      _meta: { "anthropic/alwaysLoad": true },
      description:
        "Add an emoji reaction to a Telegram message, or take yours off. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          emoji: { type: "string" },
          remove: { type: "boolean", description: "Take the bot's reaction off instead." },
        },
        required: ["message_id", "emoji"],
      },
    },
    {
      name: "download_attachment",
      annotations: { readOnlyHint: true },
      description:
        "Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "The attachment_file_id from inbound meta" },
        },
        required: ["file_id"],
      },
    },
    {
      name: "edit_message",
      _meta: { "anthropic/alwaysLoad": true },
      description:
        "Edit a message the bot previously sent: its text, a file's caption, or the file itself. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description:
              "A message_id from this thread, or from any thread its key (telegram:<chat>:<id>).",
          },
          text: { type: "string", description: "New text, or new caption for a file." },
          file: {
            type: "string",
            description: "Absolute path of a file to replace the sent one with.",
          },
          format: formatProperty,
          settled: {
            type: "boolean",
            description:
              "true once the user has answered the question this message asked, or this message answered the user's own question, or it no longer stands: it stops waiting on the user, its buttons come off, and a poll nobody has voted in closes. Without it, an edit keeps a question's buttons. A poll's own text can't be edited.",
          },
        },
        required: ["message_id"],
      },
    },
    {
      name: "delete_message",
      description: "Delete a message the bot sent.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
    {
      name: "pin",
      _meta: { "anthropic/alwaysLoad": true },
      description:
        "Post this thread's status post and pin it in place of the last one. Its note is the whole scope of the work in a few short markdown lines: what it is, its links, every part planned and where each stands. Keep it current: edit_message on the post the moment the scope or where it stands changes. hex lists the thread's waiting questions, open tasks and last done under it and keeps those current. unpin: true unpins it.",
      inputSchema: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "the status post's note: the work's whole scope, in markdown",
          },
          message_id: {
            type: "string",
            description: "with unpin: a message to unpin other than the status post",
          },
          unpin: { type: "boolean" },
        },
        required: [],
      },
    },
    {
      name: "forward",
      description: "Forward a message from this thread into another topic, by name.",
      inputSchema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          thread: { type: "string", description: "Topic name to forward it into." },
        },
        required: ["message_id", "thread"],
      },
    },
    {
      name: "poll",
      _meta: { "anthropic/alwaysLoad": true },
      description:
        "Send a poll. Each vote comes back as a message. Telegram takes a question of up to 300 characters and up to 12 options of up to 100 each, so what a choice needs explained goes in a reply before it.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", maxLength: 300 },
          options: {
            type: "array",
            items: { type: "string", maxLength: 100 },
            maxItems: 12,
            description: "When you have a pick, end its option with (my pick).",
          },
          multiple: { type: "boolean", description: "Allow picking more than one option." },
          files: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
            description:
              "For a choice between looks: one screenshot per option, in the options' order (absolute paths), showing what picking it gives; an option that keeps things as they are shows how they are now. They go above the poll, and hex voice shows each under its option.",
          },
        },
        required: ["question", "options"],
      },
    },
    {
      name: "rename_thread",
      description: "Rename this topic, change its icon, or both.",
      inputSchema: {
        type: "object",
        properties: {
          title: titleProperty,
          icon: {
            type: "string",
            description: "An emoji from Telegram's topic icon set, e.g. 🔥.",
          },
        },
      },
    },
    {
      name: "set_model",
      description:
        "Set the model, the effort, or both that this topic's session runs on, when the user asks for it. It takes effect from the topic's next message, which restarts its session with its conversation kept.",
      inputSchema: {
        type: "object",
        properties: {
          model: { type: "string", enum: MODELS.map(({ value }) => value) },
          effort: { type: "string", enum: EFFORTS.map(({ value }) => value) },
          thread: { type: "string", description: "Topic name to set instead of this thread." },
        },
      },
    },
    {
      name: "close_thread",
      description:
        "Close a forum topic whose work is done and stop its session once it is idle. Defaults to this thread. The user can still reopen it in Telegram, and a new message there resumes the session.",
      inputSchema: {
        type: "object",
        properties: {
          thread: { type: "string", description: "Topic name to close instead of this thread." },
        },
      },
    },
    {
      name: "new_thread",
      description:
        "Open a new forum topic in this group, start a fresh session for it, and give that session the prompt as its first message.",
      inputSchema: {
        type: "object",
        properties: {
          title: titleProperty,
          prompt: {
            type: "string",
            description:
              "The user's request and the context the new session can't find itself: it starts from this prompt alone.",
          },
          about: {
            type: "string",
            description:
              "One line the user sees first in the new thread, saying what it is for and where it came from.",
          },
          app: {
            type: "string",
            enum: ["telegram", "discord", "buzz"],
            description: "Where to open it. Default: telegram.",
          },
          channel: {
            type: "string",
            description:
              "Discord or Buzz only: the channel to open it in, by name. Default: the server's first channel.",
          },
        },
        required: ["title", "prompt", "about"],
      },
    },
    {
      name: "handoff",
      description:
        "Move this conversation to Discord, Buzz or T3 Code when the user asks. It opens a thread there, and this session stops here once the turn ends and resumes there with its full memory (in T3 Code, with the user's next message there). From General, a copy continues there and you stay. The title defaults to this topic's name, and is required from General.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", enum: ["discord", "buzz", "t3"] },
          title: titleProperty,
          channel: {
            type: "string",
            description:
              "Discord or Buzz only: the channel to open it in, by name. Default: Discord's system channel, or Buzz's #general.",
          },
        },
        required: ["to"],
      },
    },
  ],
};
