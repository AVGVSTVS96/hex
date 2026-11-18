import { connect, createServer } from "node:net";
import type { Socket } from "node:net";

import { z } from "zod";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// A front for tests that passes every connection through to a store's address, and resets the connection the next request arrives on once armed, as a line that drops one call does.
export async function resetting(upstream: string) {
  const { hostname, port } = new URL(upstream);
  const open = new Set<Socket>();
  let armed = false;
  let resets = 0;

  const server = createServer((socket) => {
    open.add(socket);
    const far = connect(Number(port), hostname);
    open.add(far);

    socket.on("data", (chunk) => {
      if (armed) {
        armed = false;
        resets += 1;
        far.destroy();
        socket.resetAndDestroy();

        return;
      }

      far.write(chunk);
    });

    far.on("data", (chunk) => {
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
    arm: () => {
      armed = true;
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
