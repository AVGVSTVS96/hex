import { opener } from "./board.ts";
import type { Run } from "./board.ts";
import type { Entry } from "./feed.ts";
import { clip } from "./questions.ts";
import type { Question } from "./questions.ts";
import { styleLines } from "./style.ts";
import type { VoiceStyle } from "./style.ts";

export const BACKCHANNEL =
  "Backchannel policy: Do not produce any backchannel interjections while the caller is speaking. Backchanneling is entirely disallowed: stay silent until it is your turn to respond.";

export const INTERRUPTION =
  "Interruption policy: Stop speaking when the caller interrupts. Listen to what they say.";

export const DELEGATION = `Delegation policy:
Backend tools:
- Assistant: the caller's files, machines, projects, memory, messages, email, calendar, hex's threads and the web. It looks things up, takes actions, runs long tasks and ends the call. It also has the call's full transcript and knows what was sent, seen and done.

You and Assistant are both hex: speak as one, and never mention Assistant. You know the world up to mid-2025 and nothing of the caller's life or hex beyond this call. Answer from that knowledge yourself, right away: how things work, what words mean, history, science, language, maths, everyday advice, brainstorming, opinions and small talk.

Generate <|SpawnThinking|> when:
- The question is about the caller, the people and things in their life, their plans, projects, files, messages or accounts.
- The question is about hex itself: how it works or is built, what changed and why, what it's doing. Explain hex only in Assistant's words, even when the call already touched on it.
- The answer can change over time or may be newer than mid-2025: news, prices, versions, weather, schedules, what's running or done.
- The caller wants something done, sent, changed, started, stopped or checked, or wants to hang up.
- The caller asks you to talk, sound or come across differently, in any words, like "talk faster" or "be more like an engineer": Assistant keeps it for every call.
- The caller asks what you heard, know, can see or can do, or whether something happened or was done.
- The caller challenges or corrects something said on the call, says something is wrong, or sounds frustrated.
- You're not sure of the answer, or it needs careful reasoning.

Do not generate <|SpawnThinking|> when:
- The caller is talking to someone or something else, or says they aren't talking to you, even when the words sound frustrated or like a question: stay silent, with no reply or listening sound, until they speak to you again.
- General knowledge that doesn't change answers it.
- The caller only greets or thanks you.
- The caller asks you to repeat or rephrase something already said on the call.
- You need a brief clarification to understand the request.

Generate <|SpawnThinking|> before giving an answer that depends on backend work, then name what you're checking in a few words, in the caller's terms, like "Checking whether the build passed."
If the caller is frustrated, acknowledge it in a few words, then hand off.
Do not guess the result while waiting.
When Assistant's result arrives, say all of it, close to its words, then stop: keep every name, number and fact, add nothing it didn't say, and never carry it on with details of your own. If the caller wants more, hand off again.
Say something is done, that the audio cut, that you lack information, or that you can't see or do something only when the backend says so.`;

export const MUTING =
  "Mute policy: when the caller tells you to mute yourself or go quiet, hex mutes you: say nothing and hand nothing off. You're told when they unmute you.";

export const MUTED =
  "The caller muted you. Stop now and say nothing at all, not even an okay, and hand nothing off, until you're told they unmuted you. Keep listening: what's said while you're muted isn't for you, so once unmuted, leave it unanswered unless the caller asks again.";

export const UNMUTED =
  "The caller unmuted you: talk as usual again, and say anything Assistant sent while you were muted.";

export const NOT_MUTED =
  "You aren't muted after all: the caller went on to talk about muting. Carry on as before.";

export const STOPPING =
  "hex is stopping on this machine, to restart or to move to another one, and is back once it has started again, usually within a few minutes.";

export const noAnswer = (why: string) =>
  `I can't look that up or do it right now: ${why} Nothing was checked or done.`;

export const unreachable = (why: string) =>
  `hex can't look anything up or do anything right now: ${why} Tell the caller that now, in a sentence or two.`;

export function voicePrompt(identity: string, style: VoiceStyle, started: string, mutes = false) {
  return [
    identity,
    ...styleLines(style),
    BACKCHANNEL,
    INTERRUPTION,
    DELEGATION,
    ...(mutes ? [MUTING] : []),
    `The call started ${started}, the caller's local time.`,
  ].join("\n\n");
}

export type Topic = { id: string; claude: string; voice: string };

function filled(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

export function runTopic(run: Run): Topic {
  return {
    id: run.id,
    claude: `The caller started it with Talk it through on a task. ${opener(run)}`,
    voice: `The caller tapped Talk it through on a task, so name it now in a sentence, with its last update and how old that is, then listen: Assistant checks what's new. ${opener(run)} Its last update came ${ago(run.at)}.`,
  };
}

function ago(at: string) {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);

  if (!Number.isFinite(minutes)) {
    return "at a time hex doesn't know";
  }

  if (minutes < 2) {
    return "just now";
  }

  if (minutes < 90) {
    return `${minutes} minutes ago`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

const FEED_KINDS = {
  done: "a task hex finished",
  found: "news an idea check found",
  decided: "a question hex decided itself",
} satisfies Record<Entry["kind"], string>;

export function feedTopic(entry: Entry): Topic {
  const said = [
    `It's ${FEED_KINDS[entry.kind]}, ${entry.opens} in ${entry.topic || "hex"}: ${entry.title}`,
    entry.body,
    ...entry.links.map((link) => `${link.label}: ${link.url}`),
  ]
    .filter(filled)
    .join("\n");

  return {
    id: `feed:${entry.id}`,
    claude: `The caller started it with Discuss on an entry in the Feed. ${said}`,
    voice: `The caller tapped Discuss on an entry in the Feed, so name it now in a sentence, with how long ago it was, then listen: Assistant checks what's new. ${said}\nIt came ${ago(entry.at)}.`,
  };
}

function halfDone({ partly, undoing }: Question) {
  if (undoing === true) {
    return " [taking back its answer stopped partway: only Undo in the app finishes it]";
  }

  return filled(partly)
    ? ` ["${partly}" already went out to part of it: only "${partly}" finishes it, or Undo in the app]`
    : "";
}

export function walkTopic(questions: Question[]): Topic {
  const list = questions.map(
    (question, i) =>
      `${i + 1}. ${question.id} · ${question.topic} · ${question.question}${filled(question.context) ? ` (${clip(question.context.replaceAll(/\s+/gu, " ").trim(), 280)})` : ""} Options: ${question.options.map((option) => `${option.label}${option.pick === true ? " (hex’s pick)" : ""}`).join(" / ")}${filled(question.tag) ? ` [${question.tag}]` : ""}${halfDone(question)}`,
  );

  return {
    id: "asks",
    claude: [
      `The caller tapped Go through them with hex: walk them through the ${questions.length} things waiting on them, one at a time, in this order. For each, put it on screen with ask, say it in a sentence or two with hex's pick if it has one, and listen. When they say a choice, answer sends it to the thread that asked; when they tap the card instead, a message tells you. Move on when they skip one. Say so when a choice costs money or goes out in their name.`,
      ...list,
    ].join("\n"),
    voice: `The caller wants to go through what's waiting on them, one at a time. Generate <|SpawnThinking|> now, then say you'll start with the first one: the backend brings each one up.`,
  };
}
