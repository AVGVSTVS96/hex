import {
  appInterval,
  defineApp,
  defineProvider,
  mutation,
  type MutationContext,
  object,
  query,
  type QueryContext,
  router,
  secrets,
  string,
  type Webhook,
  type WebhookContext,
} from "apps";

const telegram = defineProvider({
  name: "Telegram bot",
  hosts: ["api.telegram.org"],
  auth: {
    bot: secrets({ label: "Bot token", fields: object({ token: string({ minLength: 1 }) }) }),
  },
});

const requirements = { app: { accounts: { telegram } } };
type App = MutationContext<typeof requirements, "app">;

const MINUTE = 60_000;
const DOWN_AFTER = 4 * MINUTE;
const HANDOVER = 2 * MINUTE;
const RECENT = 1.5 * MINUTE;

type Machine = { machine: string; first_at: number; last_at: number };
type Told = { down: number; twice: number; chat: string; thread: string; checked: number };

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / MINUTE))} min`;

async function tell(ctx: App, { chat, thread }: Told, text: string) {
  const { token } = ctx.app.accounts.telegram.fields;
  const response = await ctx.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      ...(thread && { message_thread_id: Number(thread) }),
    }),
  });
  if (!response.ok)
    throw new Error(`Telegram answered ${response.status}: ${await response.text()}`);
}

async function signed(secret: string, request: Request, body: string) {
  const id = request.headers.get("webhook-id") ?? "";
  const timestamp = request.headers.get("webhook-timestamp") ?? "";
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const expected = `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
  return (request.headers.get("webhook-signature") ?? "").split(" ").includes(expected);
}

const empty = object({});
const pulse = {
  account: { app: "telegram" },
  config: empty,
  state: empty,
  setup: {
    instructions:
      "Set hex's HEX_PULSE_URL to this callback URL and HEX_PULSE_SECRET to the signing secret, in the environment hex's hub runs with, then restart hex.",
    signingSecret: "executor",
  },
  async handle(ctx, { request, secret }) {
    const body = await request.text();
    if (!(await signed(secret, request, body)))
      return new Response("bad signature", { status: 401 });
    const machine = String(JSON.parse(body).machine ?? "").slice(0, 64);
    if (!machine) return new Response("no machine", { status: 400 });
    const now = Date.now();
    ctx.sql.exec(
      `INSERT INTO machines (machine, first_at, last_at) VALUES (?, ?, ?)
       ON CONFLICT (machine) DO UPDATE SET
         first_at = CASE WHEN last_at < ? THEN excluded.first_at ELSE first_at END,
         last_at = excluded.last_at`,
      machine,
      now,
      now,
      now - DOWN_AFTER,
    );
    return new Response(null, { status: 204 });
  },
} satisfies Webhook<WebhookContext<typeof requirements, "app">, typeof empty, typeof empty>;

const check = mutation(
  {
    description:
      "Compare hex's latest pulses with now and tell Telegram when hex went down, came back, or runs on two machines.",
    input: empty,
  },
  async (ctx: App) => {
    const now = Date.now();
    ctx.sql.exec("DELETE FROM machines WHERE last_at < ?", now - 7 * 24 * 60 * MINUTE);
    const machines = ctx.sql
      .exec<Machine>("SELECT machine, first_at, last_at FROM machines ORDER BY last_at DESC")
      .toArray();
    const told = ctx.sql.exec<Told>("SELECT down, twice, chat, thread, checked FROM told").one();
    ctx.sql.exec("UPDATE told SET checked = ?", now);
    const watched = now - told.checked <= DOWN_AFTER;
    const [latest] = machines;
    if (!latest || !told.chat) return "no pulse or no chat yet";

    const quiet = now - latest.last_at;
    if (quiet > DOWN_AFTER && !told.down && watched) {
      await tell(
        ctx,
        told,
        `hex is down: its hub has sent no pulse for ${minutes(quiet)}. Last heard from ${latest.machine}.`,
      );
      ctx.sql.exec("UPDATE told SET down = ?", latest.last_at);
    } else if (quiet <= DOWN_AFTER && told.down) {
      await tell(
        ctx,
        told,
        `hex is back, on ${latest.machine}, after ${minutes(latest.first_at - told.down)} down.`,
      );
      ctx.sql.exec("UPDATE told SET down = 0");
    }

    const running = machines.filter(
      (m) => now - m.last_at < RECENT && m.last_at - m.first_at >= HANDOVER,
    );
    if (running.length > 1 && !told.twice) {
      await tell(
        ctx,
        told,
        `Two hex hubs are running at once, on ${running.map((m) => m.machine).join(" and ")}. Both read Telegram, so messages can go to either.`,
      );
      ctx.sql.exec("UPDATE told SET twice = 1");
    } else if (machines.filter((m) => now - m.last_at < RECENT).length < 2 && told.twice) {
      if (quiet < RECENT)
        await tell(ctx, told, `Only one hex hub runs again, on ${latest.machine}.`);
      ctx.sql.exec("UPDATE told SET twice = 0");
    }
    return quiet > DOWN_AFTER ? "down" : "up";
  },
);

const alertTo = mutation(
  {
    description:
      "Choose the Telegram chat, and the topic in it (empty for none), that hex-watch tells.",
    input: object({ chat: string({ minLength: 1 }), thread: string() }),
  },
  async (ctx: MutationContext<typeof requirements>, { chat, thread }) => {
    ctx.sql.exec("UPDATE told SET chat = ?, thread = ?", chat, thread);
    return { chat, thread };
  },
);

const forget = mutation(
  {
    description:
      "Forget a machine that no longer runs hex, such as a retired one or a drill, so status stops listing it.",
    input: object({ machine: string({ minLength: 1 }) }),
  },
  async (ctx: MutationContext<typeof requirements>, { machine }) => {
    ctx.sql.exec("DELETE FROM machines WHERE machine = ?", machine);

    return machine;
  },
);

const status = query(
  {
    description:
      "Is hex up? Each machine whose hex hub has pulsed this week, when it started and last pulsed, and whether the watch has said hex is down.",
    input: empty,
  },
  async (ctx: QueryContext<typeof requirements>) => {
    const now = Date.now();
    const machines = ctx.sql
      .exec<Machine>("SELECT machine, first_at, last_at FROM machines ORDER BY last_at DESC")
      .toArray();
    const told = ctx.sql.exec<Told>("SELECT down, twice, chat, thread FROM told").one();
    return {
      up: machines.some((m) => now - m.last_at <= DOWN_AFTER),
      machines: machines.map((m) => ({
        machine: m.machine,
        running: new Date(m.first_at).toISOString(),
        lastPulse: new Date(m.last_at).toISOString(),
        secondsAgo: Math.round((now - m.last_at) / 1000),
      })),
      toldDown: told.down > 0,
      toldTwoHubs: told.twice > 0,
      alertsTo: { chat: told.chat, thread: told.thread },
    };
  },
);

export default defineApp(requirements, {
  tools: router({ status, check, alertTo, forget }),
  webhooks: { pulse },
  schedules: { watch: appInterval({ minutes: 1 }, check, {}) },
});
