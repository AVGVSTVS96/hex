const ignore = (): void => undefined;

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
