export async function until<T>(check: () => T, timeout = 5000): Promise<NonNullable<T>> {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(20)) {
    const value = check()
    if (value) return value
  }
  throw new Error('timed out')
}
