import type { Judge } from "./jev.ts";

const CALL =
  "A phone call between the caller and hex, their voice assistant. `asked` is what was said when the caller last handed hex something to do, which hex is working on now. `said` is what the caller said since, as speech recognition heard it; it may be cut off mid-sentence.";

const QUESTION =
  "Is the caller, in `said`, calling off what they asked for in `asked`, so hex should stop that work now? Telling hex not to do it, that it's not needed, or to cancel, stop or forget it counts. Adding to it, changing a detail of it, asking about it, or saying something unrelated is not.";

const SURE = 0.8;

export type Stopping = ReturnType<typeof stopping>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* Only words said while hex works on a handoff go to Jev, and a stop goes on the first sure answer,
   even for half a sentence: hex rereads the words before it acts on them, so a wrong stop costs a
   few seconds, and a late one lets the work happen. */
export function stopping(
  judge: Judge,
  stop: (delegation: string) => void,
  failed: (error: Error) => void,
) {
  let working: { delegation: string; asked: string } | undefined;
  let said = "";
  let asking = false;

  const decide = async () => {
    const handoff = working;

    if (asking || !handoff || said.trim() === "") {
      return;
    }

    asking = true;
    const asked = said;
    let wants: number;

    try {
      wants = await judge({ call: CALL, asked: handoff.asked, said: asked }, QUESTION);
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));

      return;
    } finally {
      asking = false;
    }

    if (working === handoff && wants >= SURE) {
      working = undefined;
      stop(handoff.delegation);
    } else if (said !== asked) {
      await decide();
    }
  };

  return {
    handed(delegation: string, asked: string) {
      working = { delegation, asked };
      said = "";
    },
    answered(delegation: string) {
      if (working?.delegation === delegation) {
        working = undefined;
      }
    },
    heard(text: string) {
      if (working) {
        said += text;
        void decide();
      }
    },
  };
}
