import { PassThrough } from "node:stream";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  EndBehaviorType,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { AudioPlayer, AudioReceiveStream } from "@discordjs/voice";
import { engine } from "@hex/hub";
import type { Held } from "@hex/hub";
import type { Client, VoiceBasedChannel } from "discord.js";
import OpusScript from "opusscript";

const DISCORD_STEREO_RATE = 48_000;
const ENGINE_MONO_RATE = 24_000;
const TICK = 100;
const SILENCE = Buffer.alloc((ENGINE_MONO_RATE * 2 * TICK) / 1000);
const JITTER_CUSHION = Buffer.alloc((DISCORD_STEREO_RATE * 4 * TICK) / 1000);
const PAUSE = 300;
const QUIET = 64;

export function narrow(pcm: Buffer): Buffer {
  const out = Buffer.alloc(Math.floor(pcm.length / 4));

  for (let i = 0, o = 0; o < out.length; i += 8, o += 2) {
    out.writeInt16LE(
      Math.floor(
        (pcm.readInt16LE(i) +
          pcm.readInt16LE(i + 2) +
          pcm.readInt16LE(i + 4) +
          pcm.readInt16LE(i + 6)) /
          4,
      ),
      o,
    );
  }

  return out;
}

export function widen(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(samples * 8);

  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);

    const between = Math.floor(
      (sample + (i + 1 < samples ? pcm.readInt16LE(i * 2 + 2) : sample)) / 2,
    );

    out.writeInt16LE(sample, i * 8);
    out.writeInt16LE(sample, i * 8 + 2);
    out.writeInt16LE(between, i * 8 + 4);
    out.writeInt16LE(between, i * 8 + 6);
  }

  return out;
}

function silent(pcm: Buffer): boolean {
  for (let i = 0; i < pcm.length; i += 2) {
    if (Math.abs(pcm.readInt16LE(i)) > QUIET) {
      return false;
    }
  }

  return true;
}

const failed = (what: string) => (cause: unknown) => {
  process.stderr.write(`discord hub: ${what}: ${String(cause)}\n`);
};

export function speaker(player: AudioPlayer) {
  let stretch: PassThrough | undefined;
  let quiet = 0;
  player.on(AudioPlayerStatus.Idle, () => (stretch = undefined));

  return (audio: string) => {
    const pcm = Buffer.from(audio, "base64");
    quiet = silent(pcm) ? quiet + pcm.length / 48 : 0;

    if (quiet > PAUSE) {
      stretch?.end();
      stretch = undefined;

      return;
    }

    if (!stretch && quiet) {
      return;
    }

    if (!stretch) {
      stretch = new PassThrough();
      stretch.write(JITTER_CUSHION);
      player.play(createAudioResource(stretch, { inputType: StreamType.Raw }));
    }

    stretch.write(widen(pcm));
  };
}

export function listener(hear: (audio: string) => void) {
  const decoder = new OpusScript(DISCORD_STEREO_RATE, 2, OpusScript.Application.VOIP);
  let heard = Date.now();

  const quiet = setInterval(() => {
    if (Date.now() - heard < TICK) {
      return;
    }

    heard = Date.now();
    hear(SILENCE.toString("base64"));
  }, TICK);

  return {
    packet(opus: Buffer) {
      heard = Date.now();

      try {
        hear(narrow(Buffer.from(decoder.decode(opus))).toString("base64"));
      } catch (error) {
        failed("dropped a voice packet that wouldn't decode")(error);
      }
    },
    close() {
      clearInterval(quiet);
      decoder.delete();
    },
  };
}

type Live = { ear?: ReturnType<typeof listener>; voice?: AudioReceiveStream };

export function voiceCalls(client: Client, owner: (user: string) => boolean) {
  let current: { channel: string; end: () => void } | undefined;

  async function call(channel: VoiceBasedChannel, user: string) {
    const take = engine.take;

    if (!take) {
      return void process.stderr.write(
        "discord hub: the voice app isn't running, so a voice channel takes no calls\n",
      );
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    let held: Held | undefined;
    const live: Live = {};
    let over = false;

    const end = () => {
      if (over) {
        return;
      }

      over = true;

      if (current?.end === end) {
        current = undefined;
      }

      held?.hangUp();
      live.voice?.destroy();
      live.ear?.close();

      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
    };

    current = { channel: channel.id, end };
    // A disconnect that's a move or a region change reconnects on its own: https://discordjs.guide/voice/voice-connections#handling-disconnects
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]).catch(end);
    });
    connection.on(VoiceConnectionStatus.Destroyed, end);
    connection.on("error", (error) => {
      failed("the voice connection failed")(error);
      end();
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      failed(`couldn't join #${channel.name}`)(error);

      end();

      return;
    }

    if (over) {
      return;
    }

    const player = createAudioPlayer({ behaviors: { maxMissedFrames: 50 } });
    player.on("error", failed("the voice's audio failed"));
    connection.subscribe(player);

    try {
      held = take(
        "discord",
        `They joined you in the Discord voice channel ${channel.name}. Answer briefly, then listen.`,
        { play: speaker(player), end },
      );
    } catch (error) {
      process.stderr.write(`discord hub: ${String(error)}\n`);

      end();

      return;
    }

    const ear = listener(held.hear);
    live.ear = ear;

    const voice = connection.receiver.subscribe(user, {
      end: { behavior: EndBehaviorType.Manual },
    });

    live.voice = voice;
    voice.on("data", (opus: Buffer) => {
      ear.packet(opus);
    });
    voice.on("error", failed("voice receive failed"));
    process.stderr.write(`discord hub: on a call in #${channel.name}\n`);
  }

  client.on("voiceStateUpdate", (before, after) => {
    if (!owner(after.id) || before.channelId === after.channelId) {
      return;
    }

    if (current && current.channel === before.channelId) {
      current.end();
    }

    if (after.channel && !current) {
      void call(after.channel, after.id).catch(failed("voice call failed"));
    }
  });
}
