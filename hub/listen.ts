export const PORT = Number(process.env.HEX_PORT ?? 8789);

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
