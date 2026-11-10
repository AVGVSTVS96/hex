import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

const PERSONALITY = ["default", "friend", "brief", "warm", "playful"] as const;
const PACE = ["relaxed", "normal", "brisk"] as const;

type Option = { label: string; line: string };

export const PERSONALITIES: Record<(typeof PERSONALITY)[number], Option> = {
  default: { label: "Default", line: "" },
  friend: {
    label: "Friend",
    line: "Personality: a sharp friend who knows their whole setup. Warm and casual, with contractions and plain words, and a little dry humor when it fits. No filler, flattery or cheerleading.",
  },
  brief: {
    label: "Brief",
    line: "Personality: brief and matter-of-fact. Lead with the answer, in as few words as carry it. No small talk, recaps, thanks-for-waiting lines or offers.",
  },
  warm: {
    label: "Warm",
    line: "Personality: warm and patient. Encouraging without gushing; when the caller sounds stressed, slow down and focus on the next step.",
  },
  playful: {
    label: "Playful",
    line: "Personality: playful and quick, with light teasing and riffs on ideas, while every fact stays exact.",
  },
};

export const PACES: Record<(typeof PACE)[number], Option> = {
  relaxed: {
    label: "Relaxed",
    line: "Pace: slow and deliberate. Lengthen the spoken syllables themselves while keeping the voice natural, with only brief pauses between sentences.",
  },
  normal: { label: "Normal", line: "" },
  brisk: {
    label: "Brisk",
    line: "Pace: brisk. Speak at your fastest clear, fluent pace, with rapid connected articulation and minimal pauses. Keep every word complete and intelligible, and keep that speed to the end.",
  },
};

export const Style = z.object({
  voice: z
    .string()
    .regex(/^[a-z]+$|^voice_\w+$/u)
    .exactOptional(),
  personality: z.enum(PERSONALITY).exactOptional(),
  pace: z.enum(PACE).exactOptional(),
  words: z.string().max(600).exactOptional(),
});

export type VoiceStyle = z.output<typeof Style>;

function list(choices: Record<string, Option>) {
  return Object.entries(choices).map(([id, { label }]) => ({ id, label }));
}

export function options() {
  return { personalities: list(PERSONALITIES), paces: list(PACES) };
}

const file = (dir: string) => join(dir, "settings.json");

export function readStyle(dir: string): VoiceStyle {
  try {
    const parsed = Style.safeParse(JSON.parse(readFileSync(file(dir), "utf-8")));

    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeStyle(dir: string, change: VoiceStyle): VoiceStyle {
  const { words, ...rest } = { ...readStyle(dir), ...change };

  const next: VoiceStyle = {
    ...rest,
    ...(words !== undefined && words.trim() !== "" && { words: words.trim() }),
  };

  const temp = `${file(dir)}.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);

  renameSync(temp, file(dir));

  return next;
}

export function styleLines({ personality, pace, words }: VoiceStyle) {
  return [
    personality && PERSONALITIES[personality].line,
    pace && PACES[pace].line,
    words !== undefined && `In the caller's own words, how to talk: ${words}`,
  ].filter((line): line is string => Boolean(line));
}
