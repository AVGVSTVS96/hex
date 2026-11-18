import { connect, createServer } from "node:net";
import type { Socket } from "node:net";

import { z } from "zod";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A front for tests that passes every connection through to a store's address, and once armed resets the connection the next request arrives on, as a line that drops one call does: before the call reaches the store, or once the store has answered it, so the call landed and only its reply was lost.
export async function resetting(upstream: string) {
  const { hostname, port } = new URL(upstream);
  const open = new Set<Socket>();
  let armed: "asked" | "answered" | undefined;
  let left = 0;
  let resets = 0;

  const server = createServer((socket) => {
    open.add(socket);
    const far = connect(Number(port), hostname);
    open.add(far);

    const reset = () => {
      left -= 1;
      armed = left > 0 ? armed : undefined;
      resets += 1;
      far.destroy();
      socket.resetAndDestroy();
    };

    socket.on("data", (chunk) => {
      if (armed === "asked") {
        reset();

        return;
      }

      far.write(chunk);
    });

    far.on("data", (chunk) => {
      if (armed === "answered") {
        reset();

        return;
      }

      socket.write(chunk);
    });

    const ends = (one: Socket, other: Socket) => {
      const end = () => {
        other.destroy();
        open.delete(one);
      };

      one.on("close", end);
      one.on("error", end);
    };

    ends(socket, far);
    ends(far, socket);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port: at } = z.object({ port: z.number() }).parse(server.address());

  return {
    url: `http://127.0.0.1:${at}`,
    arm: (when: "asked" | "answered" = "asked", times = 1) => {
      armed = when;
      left = times;
    },
    resets: () => resets,
    stop: async () => {
      for (const socket of open) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
