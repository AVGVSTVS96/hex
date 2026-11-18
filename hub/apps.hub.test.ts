import { expect, test } from "bun:test";

import { begin, clients, mirror, move, say, writable } from "./apps.ts";
import {
  heard,
  partialHub,
  SESSION,
  dir,
  hub,
  start,
  settles,
  launched,
  session,
  registry,
  stored,
} from "./hub.testing.ts";
import { pictureId } from "./pictures.ts";
import { file } from "./store.ts";
import { until } from "./until.ts";

test("begin opens a thread on another client and starts its session on a prompt, or on a message it delivers under the thread's name", async () => {
  await start({ agents: [] });
  const placed: (string | undefined)[][] = [];
  clients.set("elsewhere", {
    hub,
    place: (name, where, about) => {
      placed.push([name, where, about]);

      return Promise.resolve({
        thread: `chat:${placed.length + 8}`,
        link: `https://chat/${placed.length + 8}`,
      });
    },
  });

  try {
    expect(
      await begin("elsewhere", "Anchors", "look at the anchors", {
        about: "From Discord",
        where: "desk",
      }),
    ).toEqual({ thread: "chat:9", link: "https://chat/9" });
    expect((await launched()).at(-1)).toBe("look at the anchors");
    await begin("elsewhere", "Relay", {
      content: "fix the relay",
      author: "prompt",
      meta: { user: "hex voice" },
    });
    expect(placed).toEqual([
      ["Anchors", "desk", "From Discord"],
      ["Relay", undefined, undefined],
    ]);
    expect((await until(() => registry()["chat:10"])).name).toBe("Relay");
    const { received } = await session("chat:10");
    await until(() => received.length);
    expect(received[0]).toMatchObject({ content: "fix the relay", meta: { user: "hex voice" } });
    expect(await settles(begin("nowhere", "Anchors", "x"))).toMatchObject({
      status: "rejected",
      reason: new Error("nowhere isn't connected; threads open in elsewhere"),
    });
  } finally {
    clients.delete("elsewhere");
  }
});

test("a move that copies forks the session there and leaves the thread here", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  const forked: unknown[][] = [];
  clients.set("elsewhere", {
    hub: partialHub({
      fork: (...args: unknown[]) => {
        forked.push(args);
      },
    }),
    place: () => Promise.resolve({ thread: "far:1", link: "https://far/1" }),
  });

  try {
    expect(await move(hub, "chat:7", "elsewhere", "Anchors", undefined, true)).toBe(
      "https://far/1",
    );
    await until(() => forked.length);
    expect(forked).toEqual([
      [
        "far:1",
        "Anchors",
        SESSION,
        'This conversation just moved to elsewhere, into the thread "Anchors". Your elsewhere tools now post there. Carry on where you left off.',
        undefined,
      ],
    ]);
    expect(registry()["chat:7"]).toEqual({ name: "Desk anchors", session: SESSION });
  } finally {
    clients.delete("elsewhere");
  }
});

test("a move backfills the thread there with its chat before its session resumes there", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  stored([{ author: "owner", body: "anchors?" }]);
  const steps: unknown[][] = [];
  clients.set("elsewhere", {
    hub: partialHub({
      fork: (...args: unknown[]) => {
        steps.push(["fork", args[0]]);
      },
    }),
    place: () => Promise.resolve({ thread: "far:1", link: "https://far/1" }),
    backfill: (thread, turns) => {
      steps.push(["backfill", thread, turns]);

      return Promise.resolve();
    },
  });

  try {
    await move(hub, "chat:7", "elsewhere", "Anchors", undefined, true);
    await until(() => steps.length === 2);
    expect(steps).toEqual([
      ["backfill", "far:1", [{ from: "me", text: "anchors?" }]],
      ["fork", "far:1"],
    ]);
  } finally {
    clients.delete("elsewhere");
  }
});

test("a move to a client that shows only its own turns hands it the session to resume with the next message there", async () => {
  await start({
    registry: {
      "chat:7": { name: "Desk anchors", session: SESSION },
      "chat:8": { name: "Desk bolts", session: "22222222-0000-4000-8000-000000000000" },
    },
  });
  const steps: unknown[][] = [];
  clients.set("elsewhere", {
    hub: partialHub({
      adopt: (...args: unknown[]) => {
        steps.push(["adopt", ...args]);
      },
      follow: (...args: unknown[]) => {
        steps.push(["follow", ...args]);
      },
    }),
    place: () => Promise.resolve({ thread: "far:1", link: "https://far/1" }),
    waits: true,
  });

  try {
    await move(hub, "chat:8", "elsewhere", "Bolts");
    await move(hub, "chat:7", "elsewhere", "Anchors", undefined, true);
    await until(() => steps.length === 2);
    expect(steps).toContainEqual([
      "adopt",
      "far:1",
      "Bolts",
      "22222222-0000-4000-8000-000000000000",
      undefined,
      undefined,
    ]);
    expect(steps).toContainEqual(["follow", "far:1", "Anchors", SESSION, undefined]);
  } finally {
    clients.delete("elsewhere");
  }
});

test("a mirror opens a backfilled copy that follows the session, and leaves the thread here", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION, cwd: "/work/anchors" } },
  });
  stored([{ author: "hex", body: "Anchors are in." }]);
  const steps: unknown[][] = [];
  clients.set("elsewhere", {
    hub: partialHub({
      follow: (...args: unknown[]) => {
        steps.push(["follow", ...args]);
      },
    }),
    place: (name, where, about, cwd) => {
      steps.push(["place", name, where, about, cwd]);

      return Promise.resolve({ thread: "far:1", link: "https://far/1" });
    },
    backfill: (thread, turns) => {
      steps.push(["backfill", thread, turns]);

      return Promise.resolve();
    },
  });

  try {
    expect(await mirror(hub, "chat:7", "elsewhere", "open-source")).toBe("https://far/1");
    expect(steps).toEqual([
      ["place", "Desk anchors", "open-source", undefined, "/work/anchors"],
      ["backfill", "far:1", [{ from: "hex", text: "Anchors are in." }]],
      ["follow", "far:1", "Desk anchors", SESSION, "/work/anchors"],
    ]);
    expect(registry()["chat:7"]).toEqual({
      name: "Desk anchors",
      session: SESSION,
      cwd: "/work/anchors",
    });
  } finally {
    clients.delete("elsewhere");
  }
});

test("a channel that shows another's threads waits for that client to join, and goes on at once when it's already here", async () => {
  let joined = false;

  const waiting = (async () => {
    await clients.joined("elsewhere");
    joined = true;
  })();

  await Bun.sleep(10);
  expect(joined).toBe(false);

  try {
    clients.set("elsewhere", { hub, place: () => Promise.resolve({ thread: "", link: "" }) });
    await waiting;
    await clients.joined("elsewhere");
  } finally {
    clients.delete("elsewhere");
  }
});

test("the owner's words written in another client reach the thread's session and show where it lives in the order written, once however often they're sent", async () => {
  await start({
    registry: { "chat:7": { name: "Desk anchors", session: SESSION } },
    agents: [{ sessionId: SESSION, pid: 42 }],
  });
  const { received, send } = await session("chat:7");
  const shown: unknown[][] = [];
  clients.set("telegram", {
    hub,
    place: () => Promise.resolve({ thread: "", link: "" }),
    backfill: (thread, turns) => {
      shown.push([thread, turns]);

      return Promise.resolve();
    },
  });

  try {
    const words = { content: "anchors?", key: "kb-1", meta: { user: "keyboard" } };
    expect(await say("telegram", "chat:7", words)).toBe(true);
    expect(await say("telegram", "chat:7", words)).toBe(true);
    expect(
      await say("telegram", "chat:7", { ...words, content: "and the docs", key: "kb-2" }),
    ).toBe(true);
    await until(() => received.length === 1 && shown.length === 2);
    await send({ type: "state", thread: "chat:7", busy: false });
    await until(() => received.length === 2);
    expect(heard(received).map((each) => each.content)).toEqual(["anchors?", "and the docs"]);
    expect(file(dir).messages.get("telegram:kb-1")).toMatchObject({ author: "owner" });
    expect(
      await say("telegram", "chat:7", {
        content: "this one\n(photo)",
        key: "app-1",
        meta: { media: "photo p1", files: "/m/p1.jpg" },
      }),
    ).toBe(true);
    expect(
      await say("telegram", "chat:7", {
        content: "and this",
        key: "kb-3",
        meta: { image_path: "/s/p2.jpg" },
      }),
    ).toBe(true);
    expect(
      await say("telegram", "chat:7", {
        content: "(album of 2)",
        key: "kb-4",
        meta: { image_path: "/s/p3.jpg; /s/p4.png" },
      }),
    ).toBe(true);
    await until(() => shown.length === 5);
    expect(shown.slice(3)).toEqual([
      [
        "chat:7",
        [
          {
            from: "me",
            text: "and this",
            media: [{ id: pictureId("telegram:kb-3", 0), kind: "photo", file: "/s/p2.jpg" }],
          },
        ],
      ],
      [
        "chat:7",
        [
          {
            from: "me",
            text: "",
            media: [
              { id: pictureId("telegram:kb-4", 0), kind: "photo", file: "/s/p3.jpg" },
              { id: pictureId("telegram:kb-4", 1), kind: "photo", file: "/s/p4.png" },
            ],
          },
        ],
      ],
    ]);
    expect(shown.slice(0, 3)).toEqual([
      ["chat:7", [{ from: "me", text: "anchors?" }]],
      ["chat:7", [{ from: "me", text: "and the docs" }]],
      [
        "chat:7",
        [
          {
            from: "me",
            text: "this one\n(photo)",
            media: [{ id: "p1", kind: "photo", file: "/m/p1.jpg" }],
          },
        ],
      ],
    ]);
  } finally {
    clients.delete("telegram");
  }
});

test("words written in another client can't reach a thread no app holds, or one whose app shows only its own turns", async () => {
  await start({ registry: { "chat:7": { name: "Desk anchors", session: SESSION } } });
  clients.set("telegram", {
    hub,
    place: () => Promise.resolve({ thread: "", link: "" }),
    waits: true,
  });

  try {
    const words = { content: "anchors?", key: "kb-1", meta: {} };
    expect(writable("telegram", "chat:7")).toBe(false);
    expect(await say("telegram", "chat:7", words)).toBe(false);
    expect(await say("nowhere", "chat:7", words)).toBe(false);
    clients.set("telegram", { hub, place: () => Promise.resolve({ thread: "", link: "" }) });
    expect(writable("telegram", "chat:7")).toBe(true);
    expect(writable("telegram", "chat:8")).toBe(false);
    expect(file(dir).messages.get("telegram:kb-1")).toBeNull();
  } finally {
    clients.delete("telegram");
  }
});
