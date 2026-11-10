import { z } from "zod";

export type Ask = (said: string, muted: boolean) => Promise<number>;

const Answer = z.object({
  answers: z.object({ wants: z.object({ noul: z.number() }) }),
});

const CALL =
  "A phone call between the caller and hex, their voice assistant. `said` is what the caller just said, as speech recognition heard it, and it may be cut off mid-sentence.";

const QUESTION = {
  mute: 'Is `said` a command to hex, the assistant on the call, to mute or go quiet now? "Mute yourself" and "mute" are such commands: the caller says "yourself" to mean hex. Talking about muting, asking how it works, or muting something else is not.',
  unmute:
    'hex is muted. Is `said` a command to hex, the assistant on the call, to unmute or talk again now? "Unmute" and "you can talk again" are such commands. Talking about unmuting, asking how it works, or unmuting something else is not.',
};

export function jev(key: string, model: string, url: string): Ask {
  return async (said, muted) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        state: { call: CALL, said },
        questions: {
          wants: { type: "noul", instructions: muted ? QUESTION.unmute : QUESTION.mute },
        },
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`Jev ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    return Answer.parse(await response.json()).answers.wants.noul;
  };
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* Only words that could be about muting go to Jev, so the rest of the call stays between the caller and OpenAI. */
const COULD_BE_ABOUT_MUTING = /mute|quiet|shh|hush|shut|silen|talk|speak|back/iu;

const SAME_BREATH = 2000;
const SURE = 0.7;

export type Muting = ReturnType<typeof muting>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* Speech recognition hands over a sentence a few words at a time, and "can we make it so you mute
   yourself" reads as a command until the rest arrives, so each answer stands only until Jev has
   read more of the same sentence; taking one back says so (`second`). */
export function muting(
  ask: Ask,
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

  const judge = async () => {
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
      wants = await ask(asked, before);
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));

      return;
    } finally {
      asking = false;
    }

    if (said === asked) {
      settle(wants >= SURE);
    } else {
      await judge();
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
      void judge();
    },
  };
}
