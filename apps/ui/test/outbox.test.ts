import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { AtomRegistry } from "effect/reactivity";

import type { OutgoingMessage } from "../src/features/composer/composerTypes.ts";
import type { Draft } from "../src/features/composer/draft.ts";
import { draftsAtom } from "../src/features/composer/drafts.ts";
import {
  cancelMessage,
  enqueue,
  entriesFor,
  flushOutbox,
  nextToSend,
  outboxAtom,
  outboxReady,
  parseOutbox,
  queueMessage,
  restoredDraft,
  restoreToDraft,
  retryMessage,
  serializeOutbox,
  shouldQueue,
  withStatus,
  type Outbox,
} from "../src/features/composer/outbox.ts";

const message = (text: string): OutgoingMessage => ({ text, attachments: [], mentions: [] });
const segments = (text: string): Draft["segments"] => [{ kind: "text", text }];
const thread = { machine: "desk", threadId: "t1" };

const fill = (...texts: ReadonlyArray<string>): Outbox =>
  texts.reduce<Outbox>(
    (outbox, text, index) => enqueue(outbox, thread, message(text), segments(text), index, text)[0],
    [],
  );

let storage: Map<string, string>;
let original: PropertyDescriptor | undefined;
let originalWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  storage = new Map();
  original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  // The drafts listen for other tabs' edits.
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("when a message waits", () => {
  it("waits while the machine is anything but connected, and goes once a lead can take it", () => {
    expect(shouldQueue("reconnecting")).toBe(true);
    expect(shouldQueue("unreachable")).toBe(true);
    expect(shouldQueue("connected")).toBe(false);
    expect(outboxReady("connected", undefined)).toBe(false);
    expect(outboxReady("connected", "lead")).toBe(true);
    expect(outboxReady("reconnecting", "lead")).toBe(false);
  });
});

describe("the outbox as data", () => {
  it("keeps each thread's messages in the order they were written", () => {
    const outbox = enqueue(
      fill("one", "two"),
      { machine: "desk", threadId: "t2" },
      message("x"),
      [],
      9,
      "x",
    )[0];
    expect(entriesFor(outbox, "desk", "t1").map((entry) => entry.text)).toEqual(["one", "two"]);
    expect(entriesFor(outbox, "desk", "t2").map((entry) => entry.text)).toEqual(["x"]);
    expect(nextToSend(outbox, "desk", "t1")?.id).toBe("one");
  });

  it("holds the rest back while the oldest is sending or failed", () => {
    expect(nextToSend(withStatus(fill("one", "two"), "one", "sending"), "desk", "t1")).toBeUndefined();
    expect(nextToSend(withStatus(fill("one", "two"), "one", "failed", "No."), "desk", "t1")).toBeUndefined();
  });

  it("reads back what it stored, and treats a message left sending as failed", () => {
    const outbox = withStatus(fill("one", "two"), "one", "sending");
    const restored = parseOutbox(serializeOutbox(outbox));
    expect(restored[0]).toMatchObject({ id: "one", status: "failed" });
    expect(restored[0]?.error).toBeDefined();
    expect(restored[1]).toEqual(outbox[1]);
  });

  it("drops an entry that no longer reads without losing the others", () => {
    const stored = JSON.stringify([...fill("one"), { id: "broken" }]);
    expect(parseOutbox(stored).map((entry) => entry.id)).toEqual(["one"]);
    expect(parseOutbox("not json")).toEqual([]);
  });

  it("gives a message back after what the draft holds", () => {
    const [entry] = fill("later");
    expect(restoredDraft(undefined, entry!).segments).toEqual(segments("later"));
    const draft: Draft = { segments: segments("now"), attachments: [] };
    expect(restoredDraft(draft, entry!).segments).toEqual([
      ...segments("now"),
      { kind: "text", text: "\n\n" },
      ...segments("later"),
    ]);
  });
});

describe("outbox actions", () => {
  it("keeps queued messages through a reload", () => {
    queueMessage(AtomRegistry.make(), thread, message("hello"), segments("hello"));
    expect(
      AtomRegistry.make()
        .get(outboxAtom)
        .map((entry) => entry.text),
    ).toEqual(["hello"]);
  });

  it("cancels, retries, and restores to the draft", () => {
    const registry = AtomRegistry.make();
    const first = queueMessage(registry, thread, message("one"), segments("one"));
    const second = queueMessage(registry, thread, message("two"), segments("two"));
    registry.set(outboxAtom, withStatus(registry.get(outboxAtom), first.id, "failed", "No."));
    retryMessage(registry, first.id);
    expect(registry.get(outboxAtom)[0]).toMatchObject({ status: "queued" });
    expect(registry.get(outboxAtom)[0]?.error).toBeUndefined();
    expect(restoreToDraft(registry, second.id, "t1")).toBe(true);
    expect(registry.get(draftsAtom)["t1"]?.segments).toEqual(segments("two"));
    cancelMessage(registry, first.id);
    expect(registry.get(outboxAtom)).toEqual([]);
  });

  it("won't restore a message already on its way", () => {
    const registry = AtomRegistry.make();
    const entry = queueMessage(registry, thread, message("one"), segments("one"));
    registry.set(outboxAtom, withStatus(registry.get(outboxAtom), entry.id, "sending"));
    expect(restoreToDraft(registry, entry.id, "t1")).toBe(false);
    expect(registry.get(outboxAtom)).toHaveLength(1);
  });
});

describe("flushOutbox", () => {
  it("sends a thread's messages oldest first and leaves other threads alone", async () => {
    const registry = AtomRegistry.make();
    registry.set(
      outboxAtom,
      enqueue(fill("one", "two"), { machine: "desk", threadId: "t2" }, message("x"), [])[0],
    );
    const sent: Array<string> = [];
    const count = await flushOutbox(registry, {
      ...thread,
      send: async (outgoing) => {
        sent.push(outgoing.text);
        expect(registry.get(outboxAtom).find((entry) => entry.text === outgoing.text)?.status).toBe(
          "sending",
        );
      },
    });
    expect(count).toBe(2);
    expect(sent).toEqual(["one", "two"]);
    expect(registry.get(outboxAtom).map((entry) => entry.text)).toEqual(["x"]);
  });

  it("stops at a failure, keeping it and what follows in order", async () => {
    const registry = AtomRegistry.make();
    registry.set(outboxAtom, fill("one", "two"));
    const count = await flushOutbox(registry, {
      ...thread,
      send: () => Promise.reject(new Error("The lead is busy.")),
    });
    expect(count).toBe(0);
    expect(registry.get(outboxAtom)).toMatchObject([
      { id: "one", status: "failed", error: "The lead is busy." },
      { id: "two", status: "queued" },
    ]);
    expect(await flushOutbox(registry, { ...thread, send: async () => false })).toBe(0);
  });

  it("puts a message back in line when the line drops under it", async () => {
    const registry = AtomRegistry.make();
    registry.set(outboxAtom, fill("one"));
    let online = true;
    await flushOutbox(registry, {
      ...thread,
      ready: () => online,
      send: async () => {
        online = false;
        return false;
      },
    });
    expect(registry.get(outboxAtom)).toMatchObject([{ id: "one", status: "queued" }]);
  });

  it("runs once per thread at a time", async () => {
    const registry = AtomRegistry.make();
    registry.set(outboxAtom, fill("one"));
    let release = () => {};
    const sends: Array<string> = [];
    const send = (outgoing: OutgoingMessage) => {
      sends.push(outgoing.text);
      return new Promise<void>((resolve) => (release = resolve));
    };
    const first = flushOutbox(registry, { ...thread, send });
    expect(await flushOutbox(registry, { ...thread, send })).toBe(0);
    release();
    expect(await first).toBe(1);
    expect(sends).toEqual(["one"]);
  });
});
