import type { ThreadId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { createServer } from "node:net";

import { blockIsFree, environmentOf, PORT_BLOCK, pickBlock, ThreadEnv } from "../src/threadEnv.ts";

// The ports a thread's scripts share out, and the variables that tell them of the thread.

const everythingFree = () => Promise.resolve(true);

describe("pickBlock", () => {
  it("picks a block of ten ports in the range below the operating system's own", async () => {
    const first = await pickBlock("thr_a", new Set(), everythingFree);
    expect(first).toBeGreaterThanOrEqual(20_000);
    expect(first! + PORT_BLOCK).toBeLessThanOrEqual(32_760);
    expect((first! - 20_000) % PORT_BLOCK).toBe(0);
  });

  it("picks the same block for the same thread, and mostly others for other threads", async () => {
    const picks = await Promise.all(
      ["thr_a", "thr_a", "thr_b", "thr_c", "thr_d"].map((id) => pickBlock(id, new Set(), everythingFree)),
    );
    expect(picks[0]).toBe(picks[1]);
    expect(new Set(picks).size).toBeGreaterThan(2);
  });

  it("moves on from a block another thread holds, and one something listens on", async () => {
    const own = (await pickBlock("thr_a", new Set(), everythingFree))!;
    const held = await pickBlock("thr_a", new Set([own]), everythingFree);
    expect(held).not.toBe(own);
    const busy = await pickBlock("thr_a", new Set(), (first) => Promise.resolve(first !== own));
    expect(busy).not.toBe(own);
  });

  it("wraps round the range, and gives up when no block is left", async () => {
    const asked: Array<number> = [];
    const none = await pickBlock("thr_a", new Set(), (first) => {
      asked.push(first);
      return Promise.resolve(false);
    });
    expect(none).toBeUndefined();
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked.length).toBe(1_276);
  });
});

describe("blockIsFree", () => {
  it("sees a port something listens on", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await blockIsFree(port - 3)).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("environmentOf", () => {
  it("names the thread, its project and its folder, and the branch and ports it has", () => {
    expect(
      environmentOf({ id: "thr_a", cwd: "/w/app", root: "/p/app", branch: "cerium/fix", port: 20010 }),
    ).toEqual({
      CERIUM_THREAD_ID: "thr_a",
      CERIUM_ROOT_PATH: "/p/app",
      CERIUM_WORKSPACE_PATH: "/w/app",
      CERIUM_BRANCH: "cerium/fix",
      CERIUM_PORT: "20010",
    });
    expect(environmentOf({ id: "thr_a", cwd: "/p/app", root: "/p/app" })).toEqual({
      CERIUM_THREAD_ID: "thr_a",
      CERIUM_ROOT_PATH: "/p/app",
      CERIUM_WORKSPACE_PATH: "/p/app",
    });
  });
});

const withEnv = <A, E>(effect: Effect.Effect<A, E, ThreadEnv | Store>) =>
  effect.pipe(
    Effect.provide(
      ThreadEnv.layer({ free: everythingFree }).pipe(
        Layer.provideMerge(Store.layer({ filename: ":memory:" })),
      ),
    ),
    Effect.scoped,
  );

describe("ThreadEnv", () => {
  it.effect("gives each work thread a block of its own and keeps it for the thread's life", () =>
    withEnv(
      Effect.gen(function* () {
        const store = yield* Store;
        const env = yield* ThreadEnv;
        const ids = ["thr_1", "thr_2", "thr_3"] as ThreadId[];
        for (const id of ids) {
          yield* store.createThread({
            id,
            title: id,
            mode: "work",
            cwd: `/w/${id}`,
            worktree: { project: "/p", root: `/w/${id}`, branch: `cerium/${id}`, base: "main" },
            createdAt: 1,
            updatedAt: 1,
          });
        }
        const first = yield* Effect.forEach(ids, (id) => env.of(id), { concurrency: "unbounded" });
        const ports = first.map((each) => Number(each["CERIUM_PORT"]));
        assert.strictEqual(new Set(ports).size, 3);
        assert.deepStrictEqual(yield* Effect.forEach(ids, (id) => env.port(id)), ports);
        assert.deepStrictEqual(
          (yield* Effect.forEach(ids, (id) => env.of(id))).map((each) => Number(each["CERIUM_PORT"])),
          ports,
        );
        assert.strictEqual(first[0]!["CERIUM_ROOT_PATH"], "/p");
        assert.strictEqual(first[0]!["CERIUM_WORKSPACE_PATH"], "/w/thr_1");
        // Deleting the thread frees its block for another.
        yield* store.deleteThread(ids[0]!);
        assert.notInclude(yield* store.threadPorts, ports[0]);
        assert.strictEqual((yield* store.threadPorts).length, 2);
      }),
    ),
  );

  it.effect("has no variables for a chat or a thread that isn't there", () =>
    withEnv(
      Effect.gen(function* () {
        const store = yield* Store;
        const env = yield* ThreadEnv;
        yield* store.createThread({
          id: "thr_chat" as ThreadId,
          title: "Chat",
          mode: "chat",
          createdAt: 1,
          updatedAt: 1,
        });
        assert.deepStrictEqual(yield* env.of("thr_chat" as ThreadId), {});
        assert.deepStrictEqual(yield* env.of("thr_missing" as ThreadId), {});
        assert.isUndefined(yield* env.port("thr_chat" as ThreadId));
        assert.isNull(yield* store.threadPort("thr_chat" as ThreadId));
      }),
    ),
  );
});
