import { Cause } from "effect";

/**
 * What stopped the backend, as the desktop shell shows it: `databaseOpen` and `databaseMigrate` for
 * the store, `listen` for the server, `startup` for anything else before it listened, and `crash` for
 * anything after.
 */
export type BackendFailureKind = "databaseOpen" | "databaseMigrate" | "listen" | "startup" | "crash";

/** Sent to the shell over the utility process's port as the backend stops on a failure. */
export interface BackendFailed {
  readonly _tag: "BackendFailed";
  readonly kind: BackendFailureKind;
  /** The failure's own words, its causes' after it: shown on this machine only. */
  readonly message: string;
}

/** How deep a chain of causes is followed into the message. */
const CAUSE_DEPTH = 4;

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && typeof (error as { _tag?: unknown })._tag === "string"
    ? (error as { _tag: string })._tag
    : undefined;

/** An error's message and its causes', each once, joined with ": ". */
export const messageChain = (error: unknown): string => {
  const parts: Array<string> = [];
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
    const message =
      typeof current === "object"
        ? "message" in current
          ? String((current as { message: unknown }).message)
          : ""
        : String(current as string | number | boolean | bigint | symbol);
    if (message !== "" && !parts.includes(message)) parts.push(message);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.join(": ") || "Unknown error";
};

/** What kind of failure `error` is, given whether the backend had started listening. */
export const failureKind = (error: unknown, listening: boolean): BackendFailureKind => {
  const tag = tagOf(error);
  const message = error instanceof Error ? error.message : "";
  if (tag === "StoreError" && message.startsWith("Could not migrate")) return "databaseMigrate";
  if (tag === "StoreError" && message.startsWith("Could not open")) return "databaseOpen";
  if (tag === "ServeError") return "listen";
  return listening ? "crash" : "startup";
};

/** The message the shell gets for a backend stopped by `cause`. */
export const backendFailed = (cause: Cause.Cause<unknown>, listening: boolean): BackendFailed => {
  const error = Cause.squash(cause);
  return { _tag: "BackendFailed", kind: failureKind(error, listening), message: messageChain(error) };
};
