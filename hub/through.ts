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
