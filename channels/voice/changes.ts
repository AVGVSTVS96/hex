export class Changes {
  version = Date.now();
  private readonly waiting = new Set<() => void>();
  private readonly listeners = new Set<() => void>();

  changes(after: number, wait: number) {
    if (after !== this.version) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(done);
        resolve();
      };

      const timer = setTimeout(done, wait);
      this.waiting.add(done);
    });
  }

  listen(listener: () => void) {
    this.listeners.add(listener);

    return () => void this.listeners.delete(listener);
  }

  changed() {
    this.version = Math.max(this.version + 1, Date.now());

    for (const done of [...this.waiting, ...this.listeners]) {
      done();
    }
  }
}

export function oneAtATime(
  what: string,
  read: () => Promise<void>,
): () => Promise<Error | undefined> {
  let running: Promise<Error | undefined> | undefined;
  let again = false;

  return () => {
    if (running !== undefined) {
      again = true;

      return running;
    }

    running = (async () => {
      let failed: Error | undefined;

      do {
        again = false;
        failed = undefined;

        try {
          await read();
        } catch (error) {
          failed = error instanceof Error ? error : new Error(String(error));
          process.stderr.write(`voice: couldn't read ${what}: ${failed.message}\n`);
        }
      } while (again);

      running = undefined;

      return failed;
    })();

    return running;
  };
}
