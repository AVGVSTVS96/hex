import { createHmac, randomUUID } from "node:crypto";
import { hostname } from "node:os";

const MINUTE = 60_000;

const ignore = (): void => undefined;

export const pulser = (url: string, secret: string, machine = hostname()) => {
  let last = Number.NEGATIVE_INFINITY;

  return async (now = Date.now()): Promise<boolean> => {
    if (url === "" || secret === "" || now - last < MINUTE) {
      return false;
    }

    last = now;

    const id = randomUUID();
    const timestamp = Math.floor(now / 1000);
    const body = JSON.stringify({ machine });

    const signature = createHmac("sha256", secret)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");

    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": `${timestamp}`,
        "webhook-signature": `v1,${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch(ignore);

    return true;
  };
};

const { HEX_PULSE_URL = "", HEX_PULSE_SECRET = "" } = process.env;

export const pulse = pulser(HEX_PULSE_URL, HEX_PULSE_SECRET);
