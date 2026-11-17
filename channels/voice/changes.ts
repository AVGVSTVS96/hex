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

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Runs one read at a time, so an older read never lands over a newer one: a call while one runs asks for one more after it, and resolves when that one ends. A read that fails is logged, so a listener that only starts it can't leave a rejection behind.
export function oneAtATime(what: string, read: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;

  return () => {
    if (running !== undefined) {
      again = true;

      return running;
    }

    running = (async () => {
      do {
        again = false;

        try {
          await read();
        } catch (error) {
          process.stderr.write(`voice: couldn't read ${what}: ${String(error)}\n`);
        }
      } while (again);

      running = undefined;
    })();

    return running;
  };
}
