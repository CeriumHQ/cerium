import type { ThreadId } from "@cerium/protocol";
import {
  CeriumError,
  TerminalRpcs,
  type TerminalId,
  type TerminalInfo,
  type TerminalOutput,
  type TerminalSize,
} from "@cerium/rpc";
import { Store, type StoreError } from "@cerium/store";
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, PubSub, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { release } from "node:os";

import { openScreen, type Screen } from "./terminalScreen.ts";
import { Ptys, TerminalError, type Pty } from "./terminalPty.ts";
import {
  chooseShell,
  exitCodeOf,
  terminalEnv,
  windowsBuild,
  type ShellChoice,
  type ShellHost,
} from "./terminalShell.ts";

export { TerminalError };

// The terminals of work threads. Each owns a shell on a pseudoterminal, started in its thread's
// folder, and a screen that remembers what the shell printed (terminalScreen.ts): a viewer attaches to
// a terminal rather than owning it, so reloading the window, or opening the thread on a phone, finds
// the shell as it was. Every terminal ends when the backend stops.

/** How many terminals one thread may have, and the backend in all. */
export const MAX_PER_THREAD = 8;
export const MAX_TERMINALS = 32;

/** Output reaching viewers is gathered for this long, so a busy shell sends a few large pieces. */
const BATCH_MS = 10;
/** Output waiting to be read by the screen at which the shell is made to wait. */
const PAUSE_ABOVE = 4_000_000;
const RESUME_BELOW = 1_000_000;
/** How many pieces of output a viewer may lag behind before it is given the screen again. */
const BACKLOG_PIECES = 512;

/** What goes to the viewers of a terminal, numbered so that a viewer can tell when it missed some. */
type Piece =
  | { readonly _tag: "Data"; readonly seq: number; readonly data: string }
  | { readonly _tag: "Ended"; readonly seq: number; readonly code?: number };

/** A terminal that is open. Mutated only by the callbacks and methods below, never from outside. */
interface Entry {
  readonly id: TerminalId;
  readonly threadId: ThreadId;
  readonly shell: ShellChoice;
  readonly cwd: string;
  readonly openedAt: number;
  /** 1 for the first shell, and one more with every restart. */
  run: number;
  readonly windowsBuild: number | undefined;
  readonly screen: Screen;
  readonly output: PubSub.PubSub<Piece>;
  pty: Pty | undefined;
  size: TerminalSize;
  exitCode: number | undefined;
  /** The number of the last piece sent; 0 before any. */
  seq: number;
  /** The number of the piece that told the shell ended, once it has. */
  endedAt: number | undefined;
  closed: boolean;
  /** Output the shell printed that isn't sent yet, and the timer that will send it. */
  pending: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastSent: number;
  /** Characters the screen was given and hasn't read yet, and whether the shell is held for it. */
  unread: number;
  paused: boolean;
}

const refuse = (error: TerminalError | StoreError) => new CeriumError({ message: error.message });

const infoOf = (entry: Entry): TerminalInfo => ({
  id: entry.id,
  threadId: entry.threadId,
  shell: entry.shell.name,
  cwd: entry.cwd,
  openedAt: entry.openedAt,
  run: entry.run,
  ...(entry.windowsBuild === undefined ? {} : { windowsBuild: entry.windowsBuild }),
  ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
});

const exists = (file: string) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

export class Terminals extends Context.Service<
  Terminals,
  {
    /** Every terminal, now and after every change. */
    readonly changes: Stream.Stream<ReadonlyArray<TerminalInfo>>;
    readonly list: Effect.Effect<ReadonlyArray<TerminalInfo>>;
    /** Opens a shell in a work thread's folder. */
    open(threadId: ThreadId, size: TerminalSize): Effect.Effect<TerminalInfo, TerminalError | StoreError>;
    /** The terminal's screen as it is now, then its output as it comes, until the shell ends. */
    attach(id: TerminalId, size: TerminalSize): Stream.Stream<TerminalOutput, TerminalError>;
    write(id: TerminalId, data: string): Effect.Effect<void, TerminalError>;
    resize(id: TerminalId, size: TerminalSize): Effect.Effect<void, TerminalError>;
    /** Starts a new shell in a terminal whose shell has ended. */
    restart(id: TerminalId, size: TerminalSize): Effect.Effect<TerminalInfo, TerminalError>;
    /** Ends the shell and what it started, and forgets the terminal. */
    close(id: TerminalId): Effect.Effect<void, TerminalError>;
    /** Closes every terminal of a thread, as when it's deleted. */
    closeThread(threadId: ThreadId): Effect.Effect<void>;
  }
>()("cerium/backend/Terminals") {
  /**
   * Requires `Store`, `FileSystem`, `Path` and `Ptys`. `shell` replaces the machine's default; `version`
   * is the build, which shells see as `TERM_PROGRAM_VERSION`. `batchMs` and `backlog` replace how long
   * output is gathered and how many pieces a viewer may lag by, for tests.
   */
  static readonly layer = (options: {
    readonly version: string;
    readonly shell?: ShellChoice;
    readonly batchMs?: number;
    readonly backlog?: number;
  }) =>
    Layer.effect(
      Terminals,
      Effect.gen(function* () {
        const store = yield* Store;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ptys = yield* Ptys;

        const entries = new Map<TerminalId, Entry>();
        // Whoever subscribes is first told the list as it stands.
        const listed = yield* PubSub.unbounded<ReadonlyArray<TerminalInfo>>({ replay: 1 });
        PubSub.publishUnsafe(listed, []);
        const host: ShellHost = { platform: process.platform, env: process.env, exists };
        const build = windowsBuild(process.platform, release());

        const currentList = () => [...entries.values()].map(infoOf);
        const publishList = () => {
          PubSub.publishUnsafe(listed, currentList());
        };

        // A viewer that lags drops the oldest pieces, which only the publishing that handles a full
        // PubSub does (`publishUnsafe` would drop the newest).
        const run = Effect.runSyncWith(yield* Effect.context<never>());
        const send = (entry: Entry, piece: Piece) => run(PubSub.publish(entry.output, piece));

        const find = (id: TerminalId): Effect.Effect<Entry, TerminalError> => {
          const entry = entries.get(id);
          return entry === undefined || entry.closed
            ? Effect.fail(new TerminalError({ message: "That terminal has closed." }))
            : Effect.succeed(entry);
        };

        /** Sends what the shell printed since the last piece to the screen and the viewers. */
        const flush = (entry: Entry) => {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          entry.timer = undefined;
          const data = entry.pending;
          if (data === "") return;
          entry.pending = "";
          entry.lastSent = performance.now();
          entry.unread += data.length;
          try {
            entry.screen.write(data, () => {
              entry.unread -= data.length;
              if (entry.paused && entry.unread < RESUME_BELOW) {
                entry.paused = false;
                entry.pty?.resume();
              }
            });
          } catch {
            // A screen that refuses output (disposed, or overwhelmed) must not stop the viewers.
            entry.unread -= data.length;
          }
          send(entry, { _tag: "Data", seq: ++entry.seq, data });
          // A shell that prints faster than the screen reads waits for it, rather than piling up output.
          if (!entry.paused && entry.unread > PAUSE_ABOVE) {
            entry.paused = true;
            entry.pty?.pause();
          }
        };

        /** The first output after a quiet spell goes at once, so typing echoes without delay. */
        const feed = (entry: Entry, data: string) => {
          if (entry.closed) return;
          entry.pending += data;
          if (entry.timer !== undefined) return;
          const wait = (options.batchMs ?? BATCH_MS) - (performance.now() - entry.lastSent);
          if (wait <= 0) flush(entry);
          else entry.timer = setTimeout(() => flush(entry), wait);
        };

        const finish = (entry: Entry, code: number) => {
          flush(entry);
          if (entry.closed || entry.endedAt !== undefined) return;
          entry.pty = undefined;
          entry.exitCode = code;
          entry.endedAt = ++entry.seq;
          send(entry, { _tag: "Ended", seq: entry.endedAt, code });
          publishList();
        };

        const start = (entry: Entry) =>
          ptys
            .spawn(
              {
                file: entry.shell.file,
                args: entry.shell.args,
                cwd: entry.cwd,
                env: terminalEnv(process.env, options.version),
                cols: entry.size.cols,
                rows: entry.size.rows,
              },
              {
                onData: (data) => feed(entry, data),
                onExit: (exit) => finish(entry, exitCodeOf(exit)),
              },
            )
            .pipe(
              Effect.tap((pty) =>
                Effect.sync(() => {
                  entry.pty = pty;
                }),
              ),
            );

        /** The screen after everything the shell printed so far, and the number of the last piece it includes. */
        const snapshot = (entry: Entry) =>
          Effect.suspend(() => {
            const seq = entry.seq;
            return Effect.tryPromise({
              try: () => entry.screen.snapshot(),
              catch: () => new TerminalError({ message: "That terminal has closed." }),
            }).pipe(Effect.map((data) => ({ seq, data })));
          });

        const fit = (entry: Entry, size: TerminalSize) =>
          Effect.sync(() => {
            if (entry.size.cols === size.cols && entry.size.rows === size.rows) return;
            entry.size = size;
            try {
              entry.screen.resize(size.cols, size.rows);
              entry.pty?.resize(size.cols, size.rows);
            } catch {
              // Resizing a shell that has just ended has nothing left to do.
            }
          });

        const dispose = (entry: Entry) =>
          Effect.gen(function* () {
            if (entry.closed) return;
            entry.closed = true;
            entries.delete(entry.id);
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.timer = undefined;
            send(entry, { _tag: "Ended", seq: ++entry.seq });
            publishList();
            if (entry.pty !== undefined) yield* entry.pty.kill;
            entry.pty = undefined;
            yield* Effect.sync(() => entry.screen.dispose()).pipe(Effect.ignore);
          });

        // Every terminal ends with the backend.
        yield* Effect.addFinalizer(() =>
          Effect.forEach([...entries.values()], dispose, { concurrency: "unbounded", discard: true }).pipe(
            Effect.timeout("5 seconds"),
            Effect.ignore,
          ),
        );

        const folderOf = Effect.fn("Terminals.folderOf")(function* (threadId: ThreadId) {
          const thread = Option.getOrUndefined(yield* store.getThread(threadId));
          if (thread === undefined)
            return yield* new TerminalError({ message: "That thread doesn't exist." });
          if (thread.mode !== "work" || thread.cwd === undefined) {
            return yield* new TerminalError({ message: "Only work threads have a terminal." });
          }
          const cwd = path.resolve(thread.cwd);
          const info = yield* fs.stat(cwd).pipe(Effect.option);
          if (Option.isNone(info)) return yield* new TerminalError({ message: `${cwd} doesn't exist.` });
          if (info.value.type !== "Directory") {
            return yield* new TerminalError({ message: `${cwd} isn't a folder.` });
          }
          return cwd;
        });

        const open = Effect.fn("Terminals.open")(function* (threadId: ThreadId, size: TerminalSize) {
          const cwd = yield* folderOf(threadId);
          const all = [...entries.values()];
          if (all.filter((entry) => entry.threadId === threadId).length >= MAX_PER_THREAD) {
            return yield* new TerminalError({
              message: `A thread can have ${MAX_PER_THREAD} terminals. Close one to open another.`,
            });
          }
          if (all.length >= MAX_TERMINALS) {
            return yield* new TerminalError({
              message: `Cerium runs ${MAX_TERMINALS} terminals at most. Close one to open another.`,
            });
          }
          const shell = options.shell ?? chooseShell(host);
          const screen = yield* Effect.tryPromise({
            try: () => openScreen({ ...size, windowsBuild: build }),
            catch: (cause) =>
              new TerminalError({
                message: `Terminals aren't available on this computer: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
          const output = yield* PubSub.sliding<Piece>(options.backlog ?? BACKLOG_PIECES);
          const entry: Entry = {
            id: `term_${randomUUID().replaceAll("-", "").slice(0, 12)}` as TerminalId,
            threadId,
            shell,
            cwd,
            openedAt: yield* Clock.currentTimeMillis,
            run: 1,
            windowsBuild: build,
            screen,
            output,
            pty: undefined,
            size,
            exitCode: undefined,
            seq: 0,
            endedAt: undefined,
            closed: false,
            pending: "",
            timer: undefined,
            lastSent: 0,
            unread: 0,
            paused: false,
          };
          yield* start(entry).pipe(Effect.tapError(() => Effect.sync(() => screen.dispose())));
          entries.set(entry.id, entry);
          publishList();
          return infoOf(entry);
        });

        /** What a viewer follows the output with: pieces in order, or the screen again once it missed any. */
        const follow = (
          entry: Entry,
          expected: number,
          piece: Piece,
        ): Effect.Effect<readonly [number, ReadonlyArray<TerminalOutput>], TerminalError> =>
          Effect.gen(function* () {
            if (piece.seq < expected) return [expected, []] as const;
            if (piece.seq === expected) {
              return piece._tag === "Data"
                ? ([expected + 1, [{ _tag: "Data", data: piece.data }]] as const)
                : ([expected + 1, [exitOf(piece.code)]] as const);
            }
            // It fell behind: draw the screen again from here.
            if (entry.closed) return [expected, [exitOf(undefined)]] as const;
            const fresh = yield* snapshot(entry);
            const screen: TerminalOutput = { _tag: "Screen", data: fresh.data };
            const over = entry.endedAt !== undefined && entry.endedAt <= fresh.seq;
            return [fresh.seq + 1, over ? [screen, exitOf(entry.exitCode)] : [screen]] as const;
          });

        const attach = (id: TerminalId, size: TerminalSize) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const entry = yield* find(id);
              yield* fit(entry, size);
              const subscription = yield* PubSub.subscribe(entry.output);
              const first = yield* snapshot(entry);
              const screen: TerminalOutput = { _tag: "Screen", data: first.data };
              if (entry.endedAt !== undefined && entry.endedAt <= first.seq) {
                return Stream.make(screen, exitOf(entry.exitCode));
              }
              const live: Stream.Stream<TerminalOutput, TerminalError> = Stream.fromSubscription(
                subscription,
              ).pipe(
                Stream.mapAccumEffect(
                  () => first.seq + 1,
                  (expected, piece) => follow(entry, expected, piece),
                ),
                Stream.takeUntil((output) => output._tag === "Exit"),
              );
              return Stream.concat(Stream.make(screen), live);
            }),
          );

        return Terminals.of({
          changes: Stream.fromPubSub(listed),
          list: Effect.sync(currentList),
          open,
          attach,
          write: (id, data) =>
            find(id).pipe(
              Effect.map((entry) => {
                // A shell that has ended has nowhere to put it.
                if (entry.pty !== undefined) entry.pty.write(data);
              }),
            ),
          resize: (id, size) => find(id).pipe(Effect.flatMap((entry) => fit(entry, size))),
          restart: (id, size) =>
            Effect.gen(function* () {
              const entry = yield* find(id);
              if (entry.pty !== undefined) {
                return yield* new TerminalError({ message: "That terminal is still running." });
              }
              yield* folderOf(entry.threadId).pipe(
                Effect.mapError((error) =>
                  error._tag === "TerminalError" ? error : new TerminalError({ message: error.message }),
                ),
              );
              const ended = { exitCode: entry.exitCode, endedAt: entry.endedAt };
              entry.size = size;
              entry.screen.resize(size.cols, size.rows);
              entry.screen.reset();
              entry.exitCode = undefined;
              entry.endedAt = undefined;
              entry.pending = "";
              entry.run++;
              // A shell that won't start leaves the terminal as it was: ended.
              yield* start(entry).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    Object.assign(entry, ended);
                    entry.run--;
                  }),
                ),
              );
              publishList();
              return infoOf(entry);
            }),
          close: (id) => find(id).pipe(Effect.flatMap(dispose)),
          closeThread: (threadId) =>
            Effect.forEach(
              [...entries.values()].filter((entry) => entry.threadId === threadId),
              dispose,
              { concurrency: "unbounded", discard: true },
            ),
        });
      }),
    );
}

const exitOf = (code: number | undefined): TerminalOutput =>
  code === undefined ? { _tag: "Exit" } : { _tag: "Exit", code };

/** Serves the terminal RPCs; spread into the machine's handlers. */
export const terminalHandlers = (terminals: Terminals["Service"]) =>
  TerminalRpcs.of({
    WatchTerminals: () => terminals.changes,
    OpenTerminal: ({ threadId, size }) => terminals.open(threadId, size).pipe(Effect.mapError(refuse)),
    AttachTerminal: ({ id, size }) => terminals.attach(id, size).pipe(Stream.mapError(refuse)),
    WriteTerminal: ({ id, data }) => terminals.write(id, data).pipe(Effect.mapError(refuse)),
    ResizeTerminal: ({ id, size }) => terminals.resize(id, size).pipe(Effect.mapError(refuse)),
    RestartTerminal: ({ id, size }) => terminals.restart(id, size).pipe(Effect.mapError(refuse)),
    CloseTerminal: ({ id }) => terminals.close(id).pipe(Effect.mapError(refuse)),
  });
