const truthy = <T>(value: T): value is NonNullable<T> => Boolean(value);

export async function until<T>(check: () => T, timeout = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    const value = check();

    if (truthy(value)) {
      return value;
    }

    await Bun.sleep(20);
  }

  throw new Error("timed out");
}
