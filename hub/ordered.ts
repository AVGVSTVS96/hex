const ignore = (): void => undefined;

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Steps taken one at a time for each key, in the order they were given: each starts once the one before it for that key has settled, however that went, and a key with nothing left to take is forgotten.
export function ordered() {
  const last = new Map<string, Promise<unknown>>();

  return async <T>(key: string, step: () => Promise<T>): Promise<T> => {
    const earlier = last.get(key);

    const mine = (async () => {
      await earlier;

      return await step();
    })();

    const settled = mine.catch(ignore);
    last.set(key, settled);

    try {
      return await mine;
    } finally {
      if (last.get(key) === settled) {
        last.delete(key);
      }
    }
  };
}
