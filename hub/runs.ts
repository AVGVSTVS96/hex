export type Runs = ReturnType<typeof threadRuns>;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// The threads the hub holds state for, in the order it first did, so a look across threads goes in that order whichever owner's part of their state it reads. Each owner keeps its own part, made as it first needs it, and forgetting a thread drops every part of it at once.
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
