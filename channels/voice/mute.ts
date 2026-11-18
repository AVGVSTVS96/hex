import type { Judge } from "./jev.ts";

const CALL =
  "A phone call between the caller and hex, their voice assistant. `said` is what the caller just said, as speech recognition heard it, and it may be cut off mid-sentence.";

const QUESTION = {
  mute: 'Is `said` a command to hex, the assistant on the call, to mute or go quiet now? "Mute yourself" and "mute" are such commands: the caller says "yourself" to mean hex. Talking about muting, asking how it works, or muting something else is not.',
  unmute:
    'hex is muted. Is `said` a command to hex, the assistant on the call, to unmute or talk again now? "Unmute" and "you can talk again" are such commands. Talking about unmuting, asking how it works, or unmuting something else is not.',
};

const COULD_BE_ABOUT_MUTING = /mute|quiet|shh|hush|shut|silen|talk|speak|back/iu;

const SAME_BREATH = 2000;
const SURE = 0.7;

export type Muting = ReturnType<typeof muting>;

export function muting(
  judge: Judge,
  flip: (muted: boolean, second: boolean) => void,
  failed: (error: Error) => void,
) {
  let muted = false;
  let before = false;
  let said = "";
  let end = Number.NEGATIVE_INFINITY;
  let asking = false;

  const settle = (wants: boolean) => {
    const now = wants !== before;

    if (now !== muted) {
      muted = now;
      flip(muted, muted === before);
    }
  };

  const decide = async () => {
    if (asking) {
      return;
    }

    if (!COULD_BE_ABOUT_MUTING.test(said)) {
      settle(false);

      return;
    }

    asking = true;
    const asked = said;
    let wants: number;

    try {
      wants = await judge({ call: CALL, said: asked }, before ? QUESTION.unmute : QUESTION.mute);
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));

      return;
    } finally {
      asking = false;
    }

    if (said === asked) {
      settle(wants >= SURE);
    } else {
      await decide();
    }
  };

  return {
    get muted() {
      return muted;
    },
    heard(text: string, start: number, until = start) {
      if (start - end > SAME_BREATH) {
        before = muted;
        said = "";
      }

      said += text;
      end = Math.max(end, until);
      void decide();
    },
  };
}
