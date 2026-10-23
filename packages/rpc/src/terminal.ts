import { EpochMillis, LenientArray, Skippable, ThreadId } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";

// The terminals a machine runs for its work threads, and for its projects before a thread starts
// there. The backend owns each pseudoterminal, so a
// terminal looks the same in the desktop window and on a phone or browser driving the machine, and
// keeps running when the window closes.

export const TerminalId = Schema.NonEmptyString.pipe(Schema.brand("cerium/TerminalId"));
export type TerminalId = typeof TerminalId.Type;

/** A terminal's size in character cells; whoever fits it last decides the shell's. */
export const TerminalSize = Schema.Struct({
  cols: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
});
export type TerminalSize = typeof TerminalSize.Type;

/** The most one `WriteTerminal` carries; a larger paste is sent in pieces. */
export const MAX_TERMINAL_WRITE = 64 * 1024;

export const TerminalInfo = Schema.Struct({
  id: TerminalId,
  /**
   * The work thread it belongs to, whose folder it started in. Absent for a project's terminal, which
   * viewers before `RPC_VERSION` 22 leave out of the list.
   */
  threadId: Schema.optionalKey(ThreadId),
  /** The project folder it belongs to, as it was opened for a new thread there. Since `RPC_VERSION` 22. */
  project: Schema.optionalKey(Schema.String),
  /** The shell's name as its tab shows it, such as "PowerShell" or "zsh". */
  shell: Schema.String,
  cwd: Schema.String,
  openedAt: EpochMillis,
  /** Which shell this is: 1 for the first, and one more with every restart, after which a viewer attaches again. */
  run: Schema.Int,
  /**
   * The Windows build whose ConPTY runs the shell, which reflows lines on its own: a viewer's emulator
   * has to know, to leave the wrapping to it. Absent elsewhere.
   */
  windowsBuild: Schema.optionalKey(Schema.Int),
  /** The shell's exit code, once it has ended; absent while it runs. */
  exitCode: Schema.optionalKey(Schema.Int),
});
export type TerminalInfo = typeof TerminalInfo.Type;

/**
 * A terminal running one command of a harness's own, such as its sign-in (`RunHarnessCommand`). It
 * belongs to no thread and isn't listed; its viewer attaches, writes, resizes and closes it by its id.
 */
export const CommandTerminal = Schema.Struct({
  id: TerminalId,
  /** As `TerminalInfo.windowsBuild`. */
  windowsBuild: Schema.optionalKey(Schema.Int),
});
export type CommandTerminal = typeof CommandTerminal.Type;

/** What an attached viewer receives, in order. */
export const TerminalOutput = Schema.Union([
  /**
   * The terminal as it is now, including its recent scrollback, to draw after clearing the view. The
   * first thing sent, and sent again when the viewer fell too far behind to follow or the shell was
   * restarted.
   */
  Schema.TaggedStruct("Screen", { data: Schema.String }),
  /** More output for the view to write. */
  Schema.TaggedStruct("Data", { data: Schema.String }),
  /** The shell ended, or the terminal was closed (no code). Nothing follows. */
  Schema.TaggedStruct("Exit", { code: Schema.optionalKey(Schema.Int) }),
]);
export type TerminalOutput = typeof TerminalOutput.Type;

/** What a machine serves about its terminals; merged into `MachineRpcs`. */
export const TerminalRpcs = RpcGroup.make(
  /** Every terminal on the machine, now and after every change: opened, closed, ended or restarted. */
  Rpc.make("WatchTerminals", { success: LenientArray(TerminalInfo), stream: true }),
  /**
   * Opens a shell in a work thread's folder, or in `project`, a folder a new thread would start in
   * (since `RPC_VERSION` 22). Refused for a chat, a thread without a folder, a project that isn't a
   * folder, or one that already has as many terminals as it may.
   */
  Rpc.make("OpenTerminal", {
    payload: {
      threadId: Schema.optionalKey(ThreadId),
      project: Schema.optionalKey(Schema.String),
      size: TerminalSize,
    },
    success: TerminalInfo,
    error: CeriumError,
  }),
  /**
   * A terminal's output, starting with its screen as it is now; resizes the terminal to `size`.
   * Unsubscribing detaches and leaves the shell running. One of a kind the viewer's version doesn't
   * know arrives as `undefined`.
   */
  Rpc.make("AttachTerminal", {
    payload: { id: TerminalId, size: TerminalSize },
    success: Skippable(TerminalOutput),
    stream: true,
    error: CeriumError,
  }),
  /** Types into a terminal. A terminal that has ended ignores it. */
  Rpc.make("WriteTerminal", {
    payload: { id: TerminalId, data: Schema.String.check(Schema.isMaxLength(MAX_TERMINAL_WRITE)) },
    error: CeriumError,
  }),
  Rpc.make("ResizeTerminal", { payload: { id: TerminalId, size: TerminalSize }, error: CeriumError }),
  /** Starts a new shell in a terminal that has ended, on its tab and with a clear screen. */
  Rpc.make("RestartTerminal", {
    payload: { id: TerminalId, size: TerminalSize },
    success: TerminalInfo,
    error: CeriumError,
  }),
  /** Ends the shell and everything it started, and forgets the terminal. */
  Rpc.make("CloseTerminal", { payload: { id: TerminalId }, error: CeriumError }),
);
