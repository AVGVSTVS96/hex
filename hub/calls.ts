import type { Runs } from "./runs.ts";

type VoiceCall = { adrift: boolean; readonly on: boolean };

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A voice call runs in this process (its call engine holds the caller's audio), so a restart waits for every thread on a call to hang up. A call whose engine has lost its link to it runs nothing here, and the next hub's engine picks it back up, so a restart doesn't wait on it.
const onCall = new Set<VoiceCall>();
const hungUp: (() => void)[] = [];

export function free(): Promise<void> {
  return new Promise((resolve) => {
    hungUp.push(resolve);
    settle();
  });
}

function settle() {
  if ([...onCall].every((call) => call.adrift)) {
    for (const resolve of hungUp.splice(0)) {
      resolve();
    }
  }
}

export type ThreadCalls = ReturnType<typeof threadCalls>;

export function threadCalls(runs: Runs) {
  const calls = runs.part((): VoiceCall => {
    const call: VoiceCall = {
      adrift: false,
      get on() {
        return onCall.has(call);
      },
    };

    return call;
  });

  function of(thread: string): { readonly on: boolean } {
    return calls.of(thread);
  }

  function joining(thread: string) {
    const call = calls.of(thread);

    return () => void onCall.add(call);
  }

  function drift(thread: string, away: boolean) {
    calls.of(thread).adrift = away;
    settle();
  }

  function hangUp(thread: string) {
    const call = calls.of(thread);
    onCall.delete(call);
    call.adrift = false;
    settle();
  }

  return { of, joining, drift, hangUp };
}
