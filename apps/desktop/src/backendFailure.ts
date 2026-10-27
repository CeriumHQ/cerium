// Why the backend stopped, as the UI shows it: what the backend said as it stopped
// (apps/backend/src/failure.ts), else how it exited, with the end of what it wrote to its log.

/** What kind of failure stopped the backend; `exited` when it stopped without saying why. */
export type BackendFailureKind =
  | "databaseOpen"
  | "databaseMigrate"
  | "listen"
  | "startup"
  | "crash"
  | "exited";

export interface BackendFailure {
  readonly kind: BackendFailureKind;
  readonly message: string;
  /** The end of the backend's output before it stopped, for the details the user can copy. */
  readonly log: string;
  /** When it stopped, in milliseconds since the epoch. */
  readonly at: number;
}

const KINDS: ReadonlySet<string> = new Set(["databaseOpen", "databaseMigrate", "listen", "startup", "crash"]);

/** The backend's `BackendFailed` message. */
export const isBackendFailed = (
  message: unknown,
): message is {
  readonly _tag: "BackendFailed";
  readonly kind: BackendFailureKind;
  readonly message: string;
} =>
  typeof message === "object" &&
  message !== null &&
  (message as { _tag?: unknown })._tag === "BackendFailed" &&
  KINDS.has(String((message as { kind?: unknown }).kind)) &&
  typeof (message as { message?: unknown }).message === "string";

/** How much of the backend's latest output is kept for a failure's details. */
const TAIL_CHARS = 6_000;

/** The latest output of the backend, at most `limit` characters, starting on a whole line. */
export const outputTail = (limit = TAIL_CHARS) => {
  let text = "";
  return {
    write: (chunk: Buffer | string) => {
      text += chunk.toString();
      if (text.length <= limit * 2) return;
      text = text.slice(-limit);
    },
    read: (): string => {
      const end = text.slice(-limit);
      const lineStart = end.length < text.length ? end.indexOf("\n") + 1 : 0;
      return end.slice(lineStart).trimEnd();
    },
    clear: () => {
      text = "";
    },
  };
};

/** The failure for a backend that exited with `code`, from what it said as it stopped, if anything. */
export const failureOnExit = (
  said: { readonly kind: BackendFailureKind; readonly message: string } | undefined,
  code: number,
  log: string,
  at: number,
): BackendFailure =>
  said === undefined
    ? { kind: "exited", message: `The backend exited with code ${code}.`, log, at }
    : { kind: said.kind, message: said.message, log, at };
