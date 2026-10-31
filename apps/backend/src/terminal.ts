import type { ThreadId } from "@cerium/protocol";
import {
  CeriumError,
  TerminalRpcs,
  type TerminalId,
  type CommandTerminal,
  type TerminalInfo,
  type TerminalOutput,
  type TerminalSize,
} from "@cerium/rpc";
import { localUrlsIn, withoutEscapes } from "@cerium/browser/url";
import { Store, type StoreError } from "@cerium/store";
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, PubSub, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir, release } from "node:os";

import { ThreadEnv } from "./threadEnv.ts";
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

// The terminals of work threads, and of projects a new thread is being written for. Each owns a
// shell on a pseudoterminal, started in its thread's (or project's) folder, and a screen that remembers what the shell printed (terminalScreen.ts): a viewer attaches to
// a terminal rather than owning it, so reloading the window, or opening the thread on a phone, finds
// the shell as it was. Every terminal ends when the backend stops.
//
// A terminal can also run one command of a harness's own, such as its sign-in, for Settings: it
// belongs to no thread, starts in the home folder, and isn't listed with the threads' terminals.

/** How many terminals one thread (or project) may have, and the backend in all. */
export const MAX_PER_THREAD = 8;
export const MAX_TERMINALS = 32;

/** Output reaching viewers is gathered for this long, so a busy shell sends a few large pieces. */
const BATCH_MS = 10;
/** Output waiting to be read by the screen at which the shell is made to wait. */
const PAUSE_ABOVE = 4_000_000;
const RESUME_BELOW = 1_000_000;
/** How many pieces of output a viewer may lag behind before it is given the screen again. */
const BACKLOG_PIECES = 512;
/**
 * How long a viewer that keeps falling behind waits after one redraw before the next: drawing a long
 * scrollback holds the backend up, and one that can't keep up would have it drawn over and over.
 */
const REDRAW_MS = 1_000;

/**
 * Scripts a project runs in terminals of its threads', one kind at a time: "Setup" and "Run" here
 * name and tell apart a script's terminal from a plain shell's on the drawer. The kind's terminal
 * replaces the kind's last one, so running again stops the old server first. A plain shell's name
 * stands for its tab; a script's kind itself does.
 */
export const SCRIPT_LABELS = ["Setup", "Run"] as const;
export type ScriptLabel = (typeof SCRIPT_LABELS)[number];

/**
 * Addresses a dev server serves itself at in the shell's output, read as the terminal's viewer reads
 * them: only hosts the same machine's browser can reach, as `Url` output pieces. Sites a page links to
 * read the same, so no more is taken. `partial` output can stop partway through one, which waits.
 */
const urlsIn = (output: string, partial = false): ReadonlyArray<string> =>
  localUrlsIn(withoutEscapes(output), partial);

/**
 * An address as a browser on this machine reaches it: a server that listens on every interface prints
 * `0.0.0.0`, which only some systems let a browser open.
 */
export const reachableUrl = (url: string): string =>
  url.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, "$1localhost");

/** The first address a script's terminal printed in a run: where the project says it is serving. */
export interface TerminalServed {
  readonly id: TerminalId;
  readonly threadId: ThreadId;
  /** The script it runs ("Setup" or "Run"). */
  readonly script: string;
  readonly url: string;
}

/** What a terminal's screen holds, as plain text, and the first address its run printed. */
export interface TerminalText {
  readonly text: string;
  readonly url?: string;
}

/** What goes to the viewers of a terminal, numbered so that a viewer can tell when it missed some. */
type Piece =
  | { readonly _tag: "Data"; readonly seq: number; readonly data: string }
  | { readonly _tag: "Url"; readonly seq: number; readonly url: string }
  | { readonly _tag: "Ended"; readonly seq: number; readonly code?: number };

/** A terminal that is open. Mutated only by the callbacks and methods below, never from outside. */
interface Entry {
  readonly id: TerminalId;
  /** The work thread it belongs to; none for a project's or a command's terminal. */
  readonly threadId: ThreadId | undefined;
  /** The project folder it belongs to, as the viewer named it; none for a thread's or a command's. */
  readonly project: string | undefined;
  /** What a command's terminal runs, such as "claude:login": running it again replaces this one. */
  readonly command: string | undefined;
  readonly shell: ShellChoice;
  readonly cwd: string;
  /** The `CERIUM_*` variables of its thread (`ThreadEnv`), set on every shell it starts. */
  readonly threadEnv: Readonly<Record<string, string>>;
  /** The project script it runs ("Setup" or "Run"), standing in for the shell's name on its tab. */
  readonly script: string | undefined;
  openedAt: number;
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
  /** The piece of its last output a URL could be cut at, scanned again with the next output. */
  tail: string;
  /** Addresses the output already told the viewers of, so each is told once. */
  urls: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastSent: number;
  /** Characters the screen was given and hasn't read yet, and whether the shell is held for it. */
  unread: number;
  paused: boolean;
}

const refuse = (error: TerminalError | StoreError) => new CeriumError({ message: error.message });

const infoOf = (entry: Entry): TerminalInfo => ({
  id: entry.id,
  ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }),
  ...(entry.project === undefined ? {} : { project: entry.project }),
  shell: entry.script ?? entry.shell.name,
  cwd: entry.cwd,
  openedAt: entry.openedAt,
  run: entry.run,
  ...(entry.windowsBuild === undefined ? {} : { windowsBuild: entry.windowsBuild }),
  ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
  ...(entry.script === undefined ? {} : { script: entry.script }),
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
    /**
     * Each script's first local address, as its output prints it, once per run: a run started again
     * prints a first one of its own.
     */
    readonly served: Stream.Stream<TerminalServed>;
    /**
     * The last `lines` lines a terminal's screen shows, as plain text, and the first local address
     * its output printed since it started. Works on a terminal whose shell has ended.
     */
    output(id: TerminalId, lines: number): Effect.Effect<TerminalText, TerminalError>;
    /** Opens a shell in a work thread's folder. */
    open(threadId: ThreadId, size: TerminalSize): Effect.Effect<TerminalInfo, TerminalError | StoreError>;
    /** Opens a shell in a project folder, for the new thread being written there. */
    openProject(project: string, size: TerminalSize): Effect.Effect<TerminalInfo, TerminalError>;
    /**
     * Runs one of a work thread's project's scripts in a terminal of the thread's own, in `cwd`,
     * whose tab shows `script` ("Setup" or "Run") instead of the shell's name. The same kind's
     * terminal there is replaced, so what ran before it stops first.
     */
    openScript(
      threadId: ThreadId,
      script: string,
      program: ShellChoice,
      cwd: string,
      size: TerminalSize,
    ): Effect.Effect<TerminalInfo, TerminalError>;
    /**
     * Runs one program in the home folder, in a terminal of no thread, replacing the one that ran the
     * same `command` before. Its viewer attaches, writes and closes it by its id, like any terminal.
     */
    run(
      command: string,
      program: ShellChoice,
      size: TerminalSize,
    ): Effect.Effect<CommandTerminal, TerminalError>;
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
   * Requires `Store`, `FileSystem`, `Path`, `Ptys` and `ThreadEnv`. `shell` replaces the machine's default; `version`
   * is the build, which shells see as `TERM_PROGRAM_VERSION`. `batchMs`, `backlog` and `redrawMs`
   * replace how long output is gathered, how many pieces a viewer may lag by and how often it is
   * drawn the screen again, for tests.
   */
  static readonly layer = (options: {
    readonly version: string;
    readonly shell?: ShellChoice;
    readonly batchMs?: number;
    readonly backlog?: number;
    readonly redrawMs?: number;
  }) =>
    Layer.effect(
      Terminals,
      Effect.gen(function* () {
        const store = yield* Store;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ptys = yield* Ptys;
        const threads = yield* ThreadEnv;

        const entries = new Map<TerminalId, Entry>();
        // Whoever subscribes is first told the list as it stands.
        const listed = yield* PubSub.unbounded<ReadonlyArray<TerminalInfo>>({ replay: 1 });
        PubSub.publishUnsafe(listed, []);
        const served = yield* PubSub.unbounded<TerminalServed>();
        const host: ShellHost = { platform: process.platform, env: process.env, exists };
        const build = windowsBuild(process.platform, release());

        const currentList = () =>
          [...entries.values()].flatMap((entry) =>
            entry.threadId === undefined && entry.project === undefined ? [] : [infoOf(entry)],
          );
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
          // A dev server's address goes beside the output that printed it, for a preview to open.
          // An address cut across two pieces is found when they join here, and one at the very end
          // waits to be finished; those on the screen are found again by the viewers that join later.
          const joined = `${entry.tail}${data}`;
          for (const url of urlsIn(joined, true)) {
            if (entry.urls.has(url)) continue;
            entry.urls.add(url);
            send(entry, { _tag: "Url", seq: ++entry.seq, url });
            if (entry.urls.size === 1 && entry.script !== undefined && entry.threadId !== undefined) {
              PubSub.publishUnsafe(served, {
                id: entry.id,
                threadId: entry.threadId,
                script: entry.script,
                url: reachableUrl(url),
              });
            }
          }
          entry.tail = joined.slice(-512);
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
                env: { ...terminalEnv(process.env, options.version), ...entry.threadEnv },
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

        /** `folder`, resolved, once it's a folder that exists. */
        const existingFolder = Effect.fn("Terminals.existingFolder")(function* (folder: string) {
          const cwd = path.resolve(folder);
          const info = yield* fs.stat(cwd).pipe(Effect.option);
          if (Option.isNone(info)) return yield* new TerminalError({ message: `${cwd} doesn't exist.` });
          if (info.value.type !== "Directory") {
            return yield* new TerminalError({ message: `${cwd} isn't a folder.` });
          }
          return cwd;
        });

        const folderOf = Effect.fn("Terminals.folderOf")(function* (threadId: ThreadId) {
          const thread = Option.getOrUndefined(yield* store.getThread(threadId));
          if (thread === undefined)
            return yield* new TerminalError({ message: "That thread doesn't exist." });
          if (thread.mode !== "work" || thread.cwd === undefined) {
            return yield* new TerminalError({ message: "Only work threads have a terminal." });
          }
          return yield* existingFolder(thread.cwd);
        });

        /** Starts `shell` in a new terminal, once there's room for one. */
        const create = Effect.fn("Terminals.create")(function* (fields: {
          readonly threadId?: ThreadId;
          readonly project?: string;
          readonly command?: string;
          readonly script?: string;
          readonly shell: ShellChoice;
          readonly cwd: string;
          readonly size: TerminalSize;
        }) {
          const { threadId, project, command, script, shell, cwd, size } = fields;
          const threadEnv = threadId === undefined ? {} : yield* threads.of(threadId);
          if (entries.size >= MAX_TERMINALS) {
            return yield* new TerminalError({
              message: `Cerium runs ${MAX_TERMINALS} terminals at most. Close one to open another.`,
            });
          }
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
            project,
            command,
            script,
            shell,
            cwd,
            threadEnv,
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
            tail: "",
            urls: new Set(),
            timer: undefined,
            lastSent: 0,
            unread: 0,
            paused: false,
          };
          yield* start(entry).pipe(Effect.tapError(() => Effect.sync(() => screen.dispose())));
          entries.set(entry.id, entry);
          publishList();
          return entry;
        });

        const open = Effect.fn("Terminals.open")(function* (threadId: ThreadId, size: TerminalSize) {
          const cwd = yield* folderOf(threadId);
          if ([...entries.values()].filter((entry) => entry.threadId === threadId).length >= MAX_PER_THREAD) {
            return yield* new TerminalError({
              message: `A thread can have ${MAX_PER_THREAD} terminals. Close one to open another.`,
            });
          }
          const shell = options.shell ?? chooseShell(host);
          return infoOf(yield* create({ threadId, shell, cwd, size }));
        });

        const openProject = Effect.fn("Terminals.openProject")(function* (
          project: string,
          size: TerminalSize,
        ) {
          const cwd = yield* existingFolder(project);
          if ([...entries.values()].filter((entry) => entry.project === project).length >= MAX_PER_THREAD) {
            return yield* new TerminalError({
              message: `A project can have ${MAX_PER_THREAD} terminals. Close one to open another.`,
            });
          }
          const shell = options.shell ?? chooseShell(host);
          return infoOf(yield* create({ project, shell, cwd, size }));
        });

        const openScript = Effect.fn("Terminals.openScript")(function* (
          threadId: ThreadId,
          script: string,
          program: ShellChoice,
          cwd: string,
          size: TerminalSize,
        ) {
          // The kind's own terminal is the one replaced: another kind's, and plain shells', run on.
          for (const earlier of [...entries.values()].filter(
            (entry) => entry.threadId === threadId && entry.script === script,
          )) {
            yield* dispose(earlier);
          }
          const folder = yield* existingFolder(cwd);
          // The room count reads without the one this replaces, which went just above.
          if (
            [...entries.values()].filter((entry) => entry.threadId === threadId).length + 1 >
            MAX_PER_THREAD
          ) {
            return yield* new TerminalError({
              message: `A thread can have ${MAX_PER_THREAD} terminals. Close one to open another.`,
            });
          }
          return infoOf(yield* create({ threadId, script, shell: program, cwd: folder, size }));
        });

        const runCommand = Effect.fn("Terminals.run")(function* (
          command: string,
          program: ShellChoice,
          size: TerminalSize,
        ) {
          const earlier = [...entries.values()].filter((entry) => entry.command === command);
          yield* Effect.forEach(earlier, dispose, { discard: true });
          const entry = yield* create({ command, shell: program, cwd: homedir(), size });
          return {
            id: entry.id,
            ...(entry.windowsBuild === undefined ? {} : { windowsBuild: entry.windowsBuild }),
          } satisfies CommandTerminal;
        });

        /**
         * What a viewer follows the output with: pieces in order, or the screen again once it missed
         * any. `viewer` is when it was last drawn the screen again; `urls` holds the addresses it has
         * been told of, from the output it followed and the screens it was drawn.
         */
        const follow = (
          entry: Entry,
          viewer: { redrawnAt: number },
          state: { expected: number; seen: Set<string> },
          piece: Piece,
        ): Effect.Effect<readonly [typeof state, ReadonlyArray<TerminalOutput>], TerminalError> =>
          Effect.gen(function* () {
            if (piece.seq < state.expected) return [state, []] as const;
            if (piece.seq === state.expected) {
              state.expected++;
              return [
                state,
                piece._tag === "Data"
                  ? [{ _tag: "Data", data: piece.data }]
                  : piece._tag === "Url"
                    ? freshUrl(state, piece.url)
                    : [exitOf(piece.code)],
              ] as const;
            }
            // It fell behind: draw the screen again from here, once it has waited out the last redraw.
            // What it misses meanwhile, the screen shows.
            const wait = viewer.redrawnAt + (options.redrawMs ?? REDRAW_MS) - performance.now();
            if (wait > 0) yield* Effect.sleep(wait);
            if (entry.closed) return [state, [exitOf(undefined)]] as const;
            const fresh = yield* snapshot(entry);
            viewer.redrawnAt = performance.now();
            state.expected = fresh.seq + 1;
            const screen: TerminalOutput = { _tag: "Screen", data: fresh.data };
            const over = entry.endedAt !== undefined && entry.endedAt <= fresh.seq;
            return [
              state,
              over
                ? [screen, ...freshUrls(state, fresh.data), exitOf(entry.exitCode)]
                : [screen, ...freshUrls(state, fresh.data)],
            ] as const;
          });

        /** The address as a piece for a viewer, or nothing when it was given that one already. */
        const freshUrl = (state: { seen: Set<string> }, url: string): ReadonlyArray<TerminalOutput> => {
          if (state.seen.has(url)) return [];
          state.seen.add(url);
          return [{ _tag: "Url", url }];
        };

        /** The addresses a screen still shows that its viewer hasn't been told of. */
        const freshUrls = (state: { seen: Set<string> }, data: string): ReadonlyArray<TerminalOutput> =>
          urlsIn(data).flatMap((url) => freshUrl(state, url));

        const attach = (id: TerminalId, size: TerminalSize) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const entry = yield* find(id);
              yield* fit(entry, size);
              const subscription = yield* PubSub.subscribe(entry.output);
              const first = yield* snapshot(entry);
              const screen: TerminalOutput = { _tag: "Screen", data: first.data };
              const state = { expected: first.seq + 1, seen: new Set<string>() };
              if (entry.endedAt !== undefined && entry.endedAt <= first.seq) {
                const urls = freshUrls(state, first.data);
                return Stream.make(screen, ...urls, exitOf(entry.exitCode));
              }
              const viewer = { redrawnAt: Number.NEGATIVE_INFINITY };
              const live: Stream.Stream<TerminalOutput, TerminalError> = Stream.fromSubscription(
                subscription,
              ).pipe(
                Stream.mapAccumEffect(
                  () => state,
                  (held, piece) => follow(entry, viewer, held, piece),
                ),
                Stream.takeUntil((output) => output._tag === "Exit"),
              );
              return Stream.concat(Stream.make(screen, ...freshUrls(state, first.data)), live);
            }),
          );

        return Terminals.of({
          changes: Stream.fromPubSub(listed),
          list: Effect.sync(currentList),
          served: Stream.fromPubSub(served),
          output: (id, lines) =>
            Effect.gen(function* () {
              const entry = yield* find(id);
              flush(entry);
              const text = yield* Effect.tryPromise({
                try: () => entry.screen.text(lines),
                catch: () => new TerminalError({ message: "That terminal has closed." }),
              });
              const first = entry.urls.values().next();
              return first.done === true ? { text } : { text, url: reachableUrl(first.value) };
            }),
          open,
          openProject,
          openScript,
          run: runCommand,
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
              const { threadId, project } = entry;
              if (threadId === undefined && project === undefined) {
                return yield* new TerminalError({ message: "That command has ended. Run it again instead." });
              }
              if (entry.pty !== undefined) {
                return yield* new TerminalError({ message: "That terminal is still running." });
              }
              yield* (threadId === undefined ? existingFolder(entry.cwd) : folderOf(threadId)).pipe(
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
              entry.tail = "";
              entry.urls.clear();
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
    OpenTerminal: ({ threadId, project, size }) =>
      (threadId !== undefined
        ? terminals.open(threadId, size)
        : project !== undefined
          ? terminals.openProject(project, size)
          : Effect.fail(new TerminalError({ message: "Say which thread or project the terminal is for." }))
      ).pipe(Effect.mapError(refuse)),
    AttachTerminal: ({ id, size }) => terminals.attach(id, size).pipe(Stream.mapError(refuse)),
    WriteTerminal: ({ id, data }) => terminals.write(id, data).pipe(Effect.mapError(refuse)),
    ResizeTerminal: ({ id, size }) => terminals.resize(id, size).pipe(Effect.mapError(refuse)),
    RestartTerminal: ({ id, size }) => terminals.restart(id, size).pipe(Effect.mapError(refuse)),
    CloseTerminal: ({ id }) => terminals.close(id).pipe(Effect.mapError(refuse)),
  });
