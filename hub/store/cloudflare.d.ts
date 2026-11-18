// The part of Cloudflare's Durable Object API the store's object uses (https://developers.cloudflare.com/durable-objects/api/), declared here so hex checks without Cloudflare's packages.
declare module "cloudflare:workers" {
  type State = {
    // oxlint-disable-next-line typescript/consistent-type-imports -- an ambient module's declarations can't import by a relative path, and a top-level import would make this file a module that augments instead of declares
    readonly storage: import("./storage.ts").Storage;
    acceptWebSocket: (socket: WebSocket) => void;
    getWebSockets: () => { send: (data: string) => void; close: () => void }[];
    setWebSocketAutoResponse: (pair: InstanceType<typeof WebSocketRequestResponsePair>) => void;
  };

  export type Id = { toString: () => string };

  export type Namespace = {
    idFromName: (name: string) => Id;
    get: (id: Id) => { fetch: (request: Request) => Promise<Response> };
  };

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: State;
    protected readonly env: Env;
    constructor(ctx: State, env: Env);
  }
}

declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket };

declare const WebSocketRequestResponsePair: new (
  request: string,
  response: string,
) => { readonly request: string; readonly response: string };
