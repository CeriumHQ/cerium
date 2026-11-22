import { describe, expect, it } from "@effect/vitest";

import type { OutboxEntry } from "../src/features/composer/outbox.ts";
import {
  collapsedHeader,
  outboxMessages,
  queueHeader,
  type Queue,
  type QueuedMessage,
} from "../src/features/composer/QueueTray.tsx";

const message = (id: string, status?: QueuedMessage["status"]): QueuedMessage => ({
  kind: "user",
  id,
  text: id,
  attachments: [],
  mentions: [],
  ...(status ? { status } : {}),
});

const queue = (overrides: Partial<Queue>): Queue => ({
  messages: [message("one")],
  ended: false,
  ...overrides,
});

describe("the queue tray's header", () => {
  it("says what the machine's own queue waits for", () => {
    expect(queueHeader(queue({}), false)).toBe("Queued for the agent's next step");
    expect(queueHeader(queue({ ended: true }), false)).toBe("Goes with your next message");
    expect(queueHeader(queue({}), true)).toBe("Sending now…");
  });

  it("says what messages kept on this device wait for", () => {
    const kept = [message("one", "queued")];
    expect(queueHeader(queue({ messages: kept, held: "reconnecting" }), false)).toBe("Waiting to reconnect");
    expect(queueHeader(queue({ messages: kept, held: "offline", machine: "studio-mac" }), false)).toBe(
      "Waits for studio-mac",
    );
    expect(queueHeader(queue({ messages: kept, held: "offline" }), false)).toBe("Waiting for computer");
  });

  it("says they're going once one is on its way, held or not", () => {
    const flushing = [message("one", "sending"), message("two", "queued")];
    expect(queueHeader(queue({ messages: flushing }), false)).toBe("Sending…");
    expect(queueHeader(queue({ messages: flushing, held: "offline", machine: "studio-mac" }), false)).toBe(
      "Sending…",
    );
  });

  it("folds to a count, and the machine when it has one, while the keyboard is up", () => {
    expect(collapsedHeader(2, "studio-mac")).toBe("2 queued · studio-mac");
    expect(collapsedHeader(1, undefined)).toBe("1 queued");
  });
});

describe("the outbox in the tray", () => {
  it("lists each waiting message with where it is on its way", () => {
    const entry = (id: string, status: OutboxEntry["status"], error?: string): OutboxEntry => ({
      id,
      machine: "desk",
      threadId: "t1",
      segments: [{ kind: "text", text: id }],
      text: id,
      attachments: [],
      mentions: [],
      createdAt: 0,
      status,
      ...(error ? { error } : {}),
    });
    expect(outboxMessages([entry("a", "queued"), entry("b", "failed", "Not sent.")])).toEqual([
      { kind: "user", id: "a", text: "a", attachments: [], mentions: [], status: "queued" },
      {
        kind: "user",
        id: "b",
        text: "b",
        attachments: [],
        mentions: [],
        status: "failed",
        error: "Not sent.",
      },
    ]);
  });
});
