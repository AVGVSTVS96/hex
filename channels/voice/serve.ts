import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

import * as app from "./app.ts";
import { Board } from "./board.ts";
import * as engine from "./engine.ts";
import type { Hub } from "./engine.ts";
import { PORT, PUBLIC_HOST, env } from "./env.ts";
import { Media } from "./media.ts";
import page from "./page.html" with { type: "text" };
import { Questions } from "./questions.ts";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
/* One port for the call page, hex's apps and Twilio, since the apps know one address and token:
   calls go to the call engine (engine.ts), everything else the apps read and do to the app API
   (app.ts), and both read the same board, questions and photos. */

const TOKEN = env.VOICE_TOKEN;

const PUBLIC_HOSTNAME = filled(PUBLIC_HOST)
  ? URL.parse(`https://${PUBLIC_HOST}`)?.hostname
  : undefined;

function filled(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function allowed(request: Request) {
  return !filled(TOKEN) || same(request.headers.get("authorization") ?? "", `Bearer ${TOKEN}`);
}

function postedFromAnotherSiteOrRebound(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");

  return (
    !nameNoSiteCanPointHere(url.hostname) ||
    (request.method !== "GET" && origin !== null && URL.parse(origin)?.host !== url.host)
  );
}

function nameNoSiteCanPointHere(host: string) {
  return (
    isIP(host.replaceAll(/^\[|\]$/gu, "")) > 0 ||
    /^[^.]+$|(^|\.)localhost$|\.ts\.net$/u.test(host) ||
    host === PUBLIC_HOSTNAME
  );
}

function home(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const local = forwarded === null || forwarded === "";

  // oxlint-disable-next-line typescript/no-base-to-string -- imported with type "text", page is the file's text; Bun types every .html import as an HTML bundle
  const html = String(page);

  return new Response(html.replace("__VOICE_TOKEN__", local && filled(TOKEN) ? TOKEN : ""), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function serve(hub: Hub, state: string) {
  const shared = {
    board: new Board(state, dirname(state)),
    questions: new Questions(state),
    media: new Media(join(state, "voice", "media")),
  };

  app.startApp(state, shared);
  engine.startCalls(hub, state, { ...shared, topic: app.topicOf });

  return Bun.serve<engine.Phone>({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 40,
    fetch(request, server) {
      const { pathname } = new URL(request.url);

      if (pathname.startsWith("/twilio/")) {
        return engine.fromTwilio(request, server);
      }

      if (postedFromAnotherSiteOrRebound(request)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (pathname === "/") {
        return home(request);
      }

      if (!allowed(request)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }

      return engine.routes(request) ?? app.routes(request) ?? new Response("404", { status: 404 });
    },
    websocket: engine.phoneAudio,
  });
}
