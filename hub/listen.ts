export const PORT = Number(process.env.HEX_PORT ?? 8789);

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// Each hub's channel under its plugin's name, behind the one HTTP listener serve.ts opens.
const channels = new Map<string, (request: Request) => Promise<Response>>();

export function mount(path: string, serve: (request: Request) => Promise<Response>) {
  channels.set(path, serve);

  return () => {
    if (channels.get(path) === serve) {
      channels.delete(path);
    }
  };
}

export function route(request: Request): Promise<Response> {
  return (
    channels.get(new URL(request.url).pathname)?.(request) ??
    Promise.resolve(new Response("Not Found", { status: 404 }))
  );
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// serve.ts's listener. A hub a stop left running holds the port until it has finished its call and exited, so the next one waits for the port instead of failing to start, which bin/hex would count against the commit. It tries each second, since nothing says the port is free: a connection to the old hub that hasn't sent anything is never accepted, so it can stay open after the hub exits.
export async function listen(port = PORT): Promise<ReturnType<typeof Bun.serve>> {
  for (let held = false; ; held = true) {
    try {
      const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: route });

      if (held) {
        process.stderr.write(`hub: port ${port} is free; starting\n`);
      }

      return server;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) {
        throw error;
      }
    }

    if (!held) {
      process.stderr.write(`hub: port ${port} is in use; this hub starts once it's free\n`);
    }

    await Bun.sleep(1000);
  }
}
