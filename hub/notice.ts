import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { present } from "./present.ts";

// A self-hosted Bot API server stands in for Telegram's at TELEGRAM_API_ROOT: https://core.telegram.org/bots/api#using-a-local-bot-api-server
export const TELEGRAM_API = present(process.env.TELEGRAM_API_ROOT)
  ? process.env.TELEGRAM_API_ROOT
  : "https://api.telegram.org";

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the owner hears straight from Telegram's API, in General's chat, when hex can't tell it there itself because its store doesn't take what hex writes. down: hex can't start, said once until it's back, through the same marker as bin/hex's own notice (state/down.<host>), so General hears once it's back. Whether it was sent.
export async function tellOwner(
  text: string,
  { down, api = TELEGRAM_API }: { down?: string; api?: string } = {},
) {
  const marker = down === undefined ? undefined : join(down, `down.${hostname()}`);

  if (marker !== undefined && existsSync(marker)) {
    return false;
  }

  const { TELEGRAM_BOT_TOKEN: token, HEX_MAIN_THREAD: chat } = process.env;

  if (!present(token) || !present(chat)) {
    process.stderr.write(`hub: no Telegram to tell the owner: ${text}\n`);

    return false;
  }

  try {
    const sent = await fetch(`${api}/bot${token}/sendMessage`, {
      method: "POST",
      body: new URLSearchParams({
        chat_id: chat,
        text: marker === undefined ? text : `${text} General hears here once it's back.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (sent.ok && marker !== undefined) {
      writeFileSync(marker, `${Math.floor(Date.now() / 1000)}\n`);
    }

    return sent.ok;
  } catch (error) {
    process.stderr.write(`hub: couldn't tell the owner (${String(error)}): ${text}\n`);

    return false;
  }
}

// oxlint-disable-next-line no-comments/no-comments -- a fact the code can't show
// What the owner hears when a hub waits for a store that doesn't answer it as it starts: why, and that it starts once the store does.
export const cantStart = (state: string) => (why: string) =>
  void tellOwner(`hex can't start on ${hostname()}: ${why}. It starts once its store answers.`, {
    down: state,
  });
