/* oxlint-disable unicorn/prefer-event-target -- the fakes stand in for @discordjs/voice's objects, which are EventEmitters */
import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import * as real from "@discordjs/voice";
import { engine } from "@hex/hub";
import type { VoiceLine } from "@hex/hub";
import { until } from "@hex/hub/testing";
import { Client } from "discord.js";
import OpusScript from "opusscript";

const OWNER = "2000";

type JoinOptions = Parameters<typeof real.joinVoiceChannel>[0];

type FakeConnection = EventEmitter & {
  state: { status: real.VoiceConnectionStatus };
  voice: PassThrough;
  subscribed?: real.AudioPlayer;
  listening?: string;
  subscribe: (to: real.AudioPlayer) => void;
  receiver: { subscribe: (user: string) => PassThrough };
  destroy: () => void;
};

const joined: { options: JoinOptions; connection: FakeConnection }[] = [];
const resources: PassThrough[] = [];

const player = Object.assign(real.createAudioPlayer(), {
  play: (resource: real.AudioResource) => {
    if (!(resource.playStream instanceof PassThrough)) {
      throw new TypeError("speaker plays a stream of its own making");
    }

    resources.push(resource.playStream);
  },
});

function fakeConnection(): FakeConnection {
  const voice = new PassThrough({ objectMode: true });

  const emitter: FakeConnection = Object.assign(new EventEmitter(), {
    state: { status: real.VoiceConnectionStatus.Ready },
    voice,
    subscribe: (to: real.AudioPlayer) => {
      emitter.subscribed = to;
    },
    receiver: {
      subscribe: (user: string) => {
        emitter.listening = user;

        return voice;
      },
    },
    destroy: () => {
      emitter.state.status = real.VoiceConnectionStatus.Destroyed;
      emitter.emit(real.VoiceConnectionStatus.Destroyed);
    },
  });

  return emitter;
}

void mock.module("@discordjs/voice", () => ({
  ...real,
  joinVoiceChannel: (options: JoinOptions) => {
    const made = fakeConnection();
    joined.push({ options, connection: made });

    return made;
  },
  entersState: async () => {},
  createAudioPlayer: () => player,
  createAudioResource: (stream: PassThrough) => ({ playStream: stream }),
}));

const { narrow, widen, speaker, listener, voiceCalls } = await import("./voice.ts");

const pcm = (...values: number[]) => {
  const buffer = Buffer.alloc(values.length * 2);

  for (const [i, sample] of values.entries()) {
    buffer.writeInt16LE(sample, i * 2);
  }

  return buffer;
};

const repeat = (value: number, times: number) => Array.from({ length: times }, () => value);

function readAudio(stream: PassThrough, size?: number): Buffer {
  const chunk: unknown = stream.read(size);

  if (!Buffer.isBuffer(chunk)) {
    throw new TypeError("the stream had no audio to read");
  }

  return chunk;
}

function nth<T>(items: T[], index: number): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`there's no item ${index}`);
  }

  return item;
}

const samples = (buffer: Buffer) =>
  Array.from({ length: buffer.length / 2 }, (_, i) => buffer.readInt16LE(i * 2));

const tick = (value: number) => pcm(...repeat(value, 2400)).toString("base64");

test("Discord's 48 kHz stereo becomes the engine's 24 kHz mono, and back, each new sample halfway to the next", () => {
  expect(samples(narrow(pcm(100, 300, 200, 200, -50, -150, 0, 0)))).toEqual([200, -50]);
  expect(samples(widen(pcm(0, 100)))).toEqual([0, 0, 50, 50, 100, 100, 100, 100]);
});

test("the voice plays in stretches of speech: silence before it is skipped, a short pause stays, and a long one ends the stretch, so Discord stops showing the bot speaking", () => {
  resources.length = 0;
  const play = speaker(player);
  play(tick(0));
  expect(resources).toHaveLength(0);
  play(tick(5000));
  expect(resources).toHaveLength(1);
  const stretch = nth(resources, 0);
  const cushion = readAudio(stretch, 19_200);
  expect(samples(cushion).every((sample) => sample === 0)).toBe(true);
  expect(samples(readAudio(stretch)).slice(0, 4)).toEqual([5000, 5000, 5000, 5000]);

  for (let i = 0; i < 3; i++) {
    play(tick(0));
  }

  expect(stretch.writableEnded).toBe(false);
  play(tick(0));
  expect(stretch.writableEnded).toBe(true);
  play(tick(0));
  play(tick(4000));
  expect(resources).toHaveLength(2);
  player.emit(real.AudioPlayerStatus.Idle);
  play(tick(4000));
  expect(resources).toHaveLength(3);
});

test("the owner's voice is decoded and sent on at 24 kHz, and quiet is sent as silence, since Discord sends nothing while they're quiet and the voice model takes its turn on hearing silence", async () => {
  const heard: Buffer[] = [];
  const ear = listener((audio) => void heard.push(Buffer.from(audio, "base64")));
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
  ear.packet(Buffer.from(encoder.encode(pcm(...repeat(1000, 1920)), 960)));
  expect(heard[0]).toHaveLength(960);
  await until(() => heard.length > 1);
  expect(heard[1]).toHaveLength(4800);
  expect(samples(nth(heard, 1)).every((sample) => sample === 0)).toBe(true);
  ear.close();
  encoder.delete();
});

test("the owner joining a voice channel calls hex there through the call engine, and leaving hangs up and leaves", async () => {
  const client = new Client({ intents: [] });

  const emit = (event: string, ...args: object[]) =>
    EventEmitter.prototype.emit.call(client, event, ...args);

  const heard: string[] = [];
  const calls: { greeting: string; line: VoiceLine; hungUp: boolean }[] = [];
  engine.take = (from, greeting, line) => {
    expect(from).toBe("discord");
    const call = { greeting, line, hungUp: false };
    calls.push(call);

    return { hear: (audio) => void heard.push(audio), hangUp: () => void (call.hungUp = true) };
  };

  voiceCalls(client, (user) => user === OWNER);

  const channel = {
    id: "6000",
    name: "General",
    guild: { id: "3000", voiceAdapterCreator: () => ({}) },
  };

  const state = (channelId: string | null, id = OWNER) => ({
    id,
    channelId,
    channel: channelId === null || channelId === "" ? null : channel,
  });

  emit("voiceStateUpdate", state(null, "8888"), state("6000", "8888"));
  emit("voiceStateUpdate", state(null), state("6000"));
  const call = await until(() => calls[0]);
  expect(joined).toHaveLength(1);
  expect(nth(joined, 0).options).toMatchObject({
    channelId: "6000",
    guildId: "3000",
    selfDeaf: false,
  });
  expect(call.greeting).toBe(
    "They joined you in the Discord voice channel General. Answer briefly, then listen.",
  );
  const { connection } = nth(joined, 0);
  expect(connection.listening).toBe(OWNER);
  expect(connection.subscribed).toBe(player);

  const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
  connection.voice.write(Buffer.from(encoder.encode(pcm(...repeat(800, 1920)), 960)));
  await until(() => heard.length);
  encoder.delete();

  emit("voiceStateUpdate", state("6000"), state("6000"));
  expect(call.hungUp).toBe(false);
  emit("voiceStateUpdate", state("6000"), state(null));
  expect(call.hungUp).toBe(true);
  expect(connection.state.status).toBe(real.VoiceConnectionStatus.Destroyed);

  emit("voiceStateUpdate", state(null), state("6000"));
  const next = await until(() => calls[1]);
  next.line.end();
  expect(nth(joined, 1).connection.state.status).toBe(real.VoiceConnectionStatus.Destroyed);
  delete engine.take;
});
