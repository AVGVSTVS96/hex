const truthy = <T>(value: T): value is NonNullable<T> => Boolean(value);

export async function until<T>(check: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (;;) {
    const value = await check();

    if (truthy(value)) {
      return value;
    }

    await Bun.sleep(20);
  }
}
