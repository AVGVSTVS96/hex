export type Runs = ReturnType<typeof threadRuns>;

export function threadRuns() {
  const held = new Set<string>();
  const forgets: ((thread: string) => void)[] = [];

  function part<Part>(make: () => Part) {
    const parts = new Map<string, Part>();
    forgets.push((thread) => {
      parts.delete(thread);
    });

    function of(thread: string): Part {
      let made = parts.get(thread);

      if (made === undefined) {
        held.add(thread);
        parts.set(thread, (made = make()));
      }

      return made;
    }

    function* all(): Generator<[string, Part]> {
      for (const thread of held) {
        const made = parts.get(thread);

        if (made !== undefined) {
          yield [thread, made];
        }
      }
    }

    return { of, get: (thread: string) => parts.get(thread), all };
  }

  function forget(thread: string) {
    held.delete(thread);

    for (const drop of forgets) {
      drop(thread);
    }
  }

  return { part, threads: () => held.values(), forget };
}
