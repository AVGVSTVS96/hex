// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Requests going through again, for every hub in the process: a start went through when a session this process started connects, a turn when one ends with an answer. What waited on an outage carries on then.
export type Through = "start" | "turn";

const waiting: Record<Through, Set<() => void>> = { start: new Set(), turn: new Set() };

export function wentThrough(what: Through) {
  for (const carryOn of waiting[what]) {
    carryOn();
  }
}

export function whenThrough(what: Through, carryOn: () => void, signal: AbortSignal) {
  waiting[what].add(carryOn);
  signal.addEventListener(
    "abort",
    () => {
      waiting[what].delete(carryOn);
    },
    { once: true },
  );
}
