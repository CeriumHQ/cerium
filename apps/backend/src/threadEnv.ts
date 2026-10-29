import { ThreadId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Context, Effect, Layer, Option, Semaphore } from "effect";
import { createServer } from "node:net";

// What a work thread's scripts and terminals know of the thread they run for: `CERIUM_*` variables,
// so a project's setup, run and teardown, and the commands its agents type, can keep threads out of
// each other's way. The chief of them is `CERIUM_PORT`, the first of a small block of ports no other
// thread has and nothing on the machine was listening on when the thread was given it.

/** How many consecutive ports a thread's block holds: `CERIUM_PORT` to `CERIUM_PORT + 9`. */
export const PORT_BLOCK = 10;

/** Blocks start in this range, which sits below where operating systems hand out their own ports. */
const FIRST_PORT = 20_000;
const END_PORT = 32_760;

/** How many blocks the range holds. */
const BLOCKS = Math.floor((END_PORT - FIRST_PORT) / PORT_BLOCK);

/** A thread's id as a number to start looking for its block at, so threads rarely meet in one. */
const startOf = (threadId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < threadId.length; index++) {
    hash = Math.imul(hash ^ threadId.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash % BLOCKS;
};

/**
 * The first port of the first block, looking from where `threadId` starts and round the range, that no
 * thread holds (`taken`) and `free` says nothing listens on; undefined when every block is spoken for.
 */
export const pickBlock = async (
  threadId: string,
  taken: ReadonlySet<number>,
  free: (first: number) => Promise<boolean>,
): Promise<number | undefined> => {
  const start = startOf(threadId);
  for (let step = 0; step < BLOCKS; step++) {
    const first = FIRST_PORT + ((start + step) % BLOCKS) * PORT_BLOCK;
    if (!taken.has(first) && (await free(first))) return first;
  }
  return undefined;
};

/** Whether nothing listens on `port` of `host`. A host this machine has no address for can't be in use. */
const listensNowhere = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      // In use, or reserved (Windows keeps ranges for Hyper-V and the like): not for a thread.
      resolve(error.code !== "EADDRINUSE" && error.code !== "EACCES");
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

/** Whether every port of the block starting at `first` is free on the addresses dev servers bind. */
export const blockIsFree = async (first: number): Promise<boolean> => {
  for (let port = first; port < first + PORT_BLOCK; port++) {
    for (const host of ["127.0.0.1", "0.0.0.0", "::1"]) {
      if (!(await listensNowhere(port, host))) return false;
    }
  }
  return true;
};

/** The variables for a thread, from what is known of it. */
export const environmentOf = (thread: {
  readonly id: string;
  readonly cwd: string;
  /** The project's own folder: the thread's `cwd` when it doesn't run in a worktree. */
  readonly root: string;
  readonly branch?: string;
  readonly port?: number;
}): Record<string, string> => ({
  CERIUM_THREAD_ID: thread.id,
  CERIUM_ROOT_PATH: thread.root,
  CERIUM_WORKSPACE_PATH: thread.cwd,
  ...(thread.branch === undefined ? {} : { CERIUM_BRANCH: thread.branch }),
  ...(thread.port === undefined ? {} : { CERIUM_PORT: String(thread.port) }),
});

export class ThreadEnv extends Context.Service<
  ThreadEnv,
  {
    /**
     * The `CERIUM_*` variables of a work thread, giving it its block of ports the first time it asks;
     * none for a thread without a folder (a chat) or one that isn't there.
     */
    of(threadId: ThreadId): Effect.Effect<Record<string, string>>;
    /** The first port of the block a work thread has, or undefined for a thread that has none to have. */
    port(threadId: ThreadId): Effect.Effect<number | undefined>;
  }
>()("cerium/backend/ThreadEnv") {
  /** Requires `Store`. `free` replaces how a block is found free, for tests. */
  static readonly layer = (options: { readonly free?: (first: number) => Promise<boolean> } = {}) =>
    Layer.effect(
      ThreadEnv,
      Effect.gen(function* () {
        const store = yield* Store;
        /** One block is picked at a time, so threads starting together don't pick the same one. */
        const picking = yield* Semaphore.make(1);

        /** The thread, when it is a work thread with a folder: only those have anything to run. */
        const workThread = (threadId: ThreadId) =>
          store.getThread(threadId).pipe(
            Effect.map((found) => {
              const thread = Option.getOrUndefined(found);
              return thread?.mode === "work" && thread.cwd !== undefined
                ? { ...thread, cwd: thread.cwd }
                : undefined;
            }),
            Effect.orElseSucceed(() => undefined),
          );

        const port = Effect.fn("ThreadEnv.port")(function* (threadId: ThreadId) {
          if ((yield* workThread(threadId)) === undefined) return undefined;
          const held = yield* store.threadPort(threadId);
          if (held !== null) return held;
          return yield* picking.withPermits(1)(
            Effect.gen(function* () {
              // Another thread of the queue may have given it one while this waited.
              const again = yield* store.threadPort(threadId);
              if (again !== null) return again;
              const taken = new Set(yield* store.threadPorts);
              const first = yield* Effect.promise(() =>
                pickBlock(threadId, taken, options.free ?? blockIsFree),
              );
              return first === undefined ? undefined : yield* store.giveThreadPort(threadId, first);
            }),
          );
        });

        return ThreadEnv.of({
          port: (threadId) => port(threadId).pipe(Effect.orElseSucceed(() => undefined)),
          of: Effect.fn("ThreadEnv.of")(function* (threadId: ThreadId) {
            const thread = yield* workThread(threadId);
            if (thread === undefined) return {};
            const first = yield* port(threadId).pipe(Effect.orElseSucceed(() => undefined));
            return environmentOf({
              id: thread.id,
              cwd: thread.cwd,
              root: thread.worktree?.project ?? thread.cwd,
              ...(thread.worktree === undefined ? {} : { branch: thread.worktree.branch }),
              ...(first === undefined ? {} : { port: first }),
            });
          }),
        });
      }),
    );

  /** For tests that need no variables. */
  static readonly none = Layer.succeed(ThreadEnv, {
    of: () => Effect.succeed({}),
    port: () => Effect.succeed(undefined),
  });
}
