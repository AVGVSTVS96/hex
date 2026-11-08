import { connect } from "node:net";
import { join } from "node:path";

// oxlint-disable-next-line anti-slop/no-object-parameters -- questions.ts passes its messages on as object; the hub socket's request union belongs to the hub
export function relay(state: string, app: string, message: object) {
  const path = join(state, app, "hub.sock");

  return new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    socket.on("connect", () => {
      socket.end(`${JSON.stringify(message)}\n`, resolve);
    });
    socket.on("error", (error) => {
      reject(new Error(`hex's hub isn't answering at ${path} (${error.message})`));
    });
  });
}
