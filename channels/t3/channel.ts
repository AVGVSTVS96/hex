import { z } from "zod";

import { tool } from "../../hub/hub.ts";
import type { ChannelServer } from "../../hub/hub.ts";

const titleField = z.string().describe('One word, like a chat name ("Anchors", "Frontier").');
const app = z.enum(["discord", "telegram", "buzz"]);

const channelField = z
  .string()
  .describe(
    "Discord or Buzz only: the channel to open it in, by name. Default: Discord's system channel, or Buzz's #general.",
  )
  .optional();

export const tools = [
  tool({
    name: "new_thread",
    description:
      "Open a thread in Discord, Telegram or Buzz, start a fresh session for it in this project, and give that session the prompt as its first message.",
    input: z.object({
      app,
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
      channel: channelField,
    }),
  }),
  tool({
    name: "handoff",
    description:
      "Continue this conversation in Discord, Telegram or Buzz when the user asks. It opens a thread there, where a copy of this session carries on with its full memory; this thread stays here.",
    input: z.object({ to: app, title: titleField, channel: channelField }),
  }),
] as const;

export const server: ChannelServer = {
  title: "T3 Code",
  instructions: [
    "This session is one T3 Code thread. Unlike the chat apps, the user reads this session itself: T3 Code shows your text, tool calls and edits live as you work. So answer in plain text, as you would in a terminal; there is no reply tool here.",
    "",
    'Messages arrive as <channel source="t3" ts="...">. Images and files the user attaches show up in them as absolute paths: Read them. Your working directory is the project this thread was opened in.',
    "",
    "new_thread opens a thread in one of hex's chat apps (Discord, Telegram or Buzz) with its own fresh session, working in this project, and hands it your prompt. handoff continues this conversation in one of them when the user asks: a copy of this session carries on there with your memory, and you stay here.",
  ].join("\n"),
  tools,
};
