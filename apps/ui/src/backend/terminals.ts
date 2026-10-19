import { CeriumError, type TerminalId } from "@cerium/rpc";
import { Effect, Option, Queue, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { inputPieces } from "../features/terminal/model.ts";
import { TerminalSession } from "../features/terminal/session.ts";
import { Backend } from "./client.ts";
import { machineAtom } from "./machine.ts";

// The driven machine's terminals. Their shells live in its backend; this side keeps each one's
// emulator (features/terminal/session.ts) and the two pumps between: output from the backend into it,
// and what's typed, and its size, back out.

/**
 * Every terminal on the machine, now and after every change. Read again when the window drives
 * another machine, and subscribed again after a lost connection.
 */
export const terminalsAtom = Backend.runtime
  .atom((get) => {
    get(machineAtom);
    return Stream.unwrap(Backend.use((client) => Effect.succeed(client("WatchTerminals", undefined)))).pipe(
      Stream.retry(Schedule.spaced("1 second")),
    );
  })
  .pipe(Atom.keepAlive);

export const openTerminal = Backend.mutation("OpenTerminal");
export const restartTerminal = Backend.mutation("RestartTerminal");
export const closeTerminal = Backend.mutation("CloseTerminal");

/** How long an emulator is kept after nothing shows it, so going back to its thread finds it as it was. */
const KEPT = "3 minutes";

/** How long a terminal waits for its container to give it a size before it draws at the one it has. */
const SIZE_WAIT = "500 millis";

/** Input goes to the backend in pieces this long, which it takes in one call. */
const INPUT_PIECE = 32 * 1024;

/**
 * A terminal's emulator, fed by the backend for as long as something shows it (and a while after),
 * keyed by the terminal and which shell it is (`id:run`): a restarted terminal is a new session. It
 * attaches once the emulator has a size, draws the backend's screen, then follows the output; a lost
 * connection attaches again to a fresh screen, and a terminal that has closed stops.
 */
export const terminalSessionAtom = Atom.family((key: string) =>
  Backend.runtime
    .atom((get) =>
      Effect.gen(function* () {
        const client = yield* Backend;
        const id = key.slice(0, key.lastIndexOf(":")) as TerminalId;
        const known = Option.getOrUndefined(AsyncResult.value(get.once(terminalsAtom)))?.find(
          (terminal) => terminal.id === id,
        );

        const typed = yield* Queue.unbounded<string>();
        const sizes = yield* Queue.sliding<{ readonly cols: number; readonly rows: number }>(1);
        const session = new TerminalSession({
          windowsBuild: known?.windowsBuild,
          onInput: (data) => void Queue.offerUnsafe(typed, data),
          onSize: (size) => void Queue.offerUnsafe(sizes, size),
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => session.dispose()));

        // What's typed goes in order, a call at a time, and whatever piled up meanwhile goes together.
        yield* Queue.takeAll(typed).pipe(
          Effect.flatMap((pieces) =>
            Effect.forEach(
              inputPieces(pieces.join(""), INPUT_PIECE),
              (data) => client("WriteTerminal", { id, data }),
              { discard: true },
            ),
          ),
          Effect.ignore,
          Effect.forever,
          Effect.forkScoped,
        );

        // Dragging the drawer fits the emulator at every pixel; the shell hears of the size it settles on.
        yield* Stream.fromQueue(sizes).pipe(
          Stream.debounce("120 millis"),
          Stream.runForEach((size) => client("ResizeTerminal", { id, size }).pipe(Effect.ignore)),
          Effect.forkScoped,
        );

        let finished = false;
        const follow = Effect.gen(function* () {
          yield* Effect.promise(() => session.sized).pipe(Effect.timeoutOption(SIZE_WAIT));
          const output = yield* client(
            "AttachTerminal",
            { id, size: session.size() },
            { asQueue: true, streamBufferSize: 1024 },
          );
          yield* Stream.fromQueue(output).pipe(
            Stream.runForEachArray((batch) =>
              Effect.sync(() => {
                for (const each of batch) {
                  if (each === undefined) continue;
                  switch (each._tag) {
                    case "Screen":
                      session.reset();
                      session.write(each.data);
                      break;
                    case "Data":
                      session.write(each.data);
                      break;
                    case "Exit":
                      finished = true;
                      session.end();
                      break;
                  }
                }
              }),
            ),
          );
        }).pipe(
          Effect.scoped,
          // A terminal the backend no longer has is not coming back.
          Effect.catchIf(
            (error): error is CeriumError => error instanceof CeriumError,
            () => Effect.sync(() => void (finished = true)),
          ),
          Effect.ignore,
        );
        // A stream that ends without the shell's end was cut off; so is one that failed.
        yield* follow.pipe(
          Effect.repeat({ schedule: Schedule.spaced("1 second"), until: () => finished }),
          Effect.forkScoped,
        );

        return session;
      }),
    )
    .pipe(Atom.setIdleTTL(KEPT)),
);
