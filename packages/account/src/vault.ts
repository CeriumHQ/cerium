import { Context, Schema, type Effect } from "effect";

// Where a device keeps its Cerium sign-in: the one credential Cerium holds, its own
// (docs/architecture.md §14.2). A desktop's backend keeps it with the shell or in a file; the web
// client in the browser's local storage (§14.10).

/** The sign-in couldn't be read or saved; `message` is written for the user. */
export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  message: Schema.String,
}) {}

export class Vault extends Context.Service<
  Vault,
  {
    /** The saved sign-in, if there is one. */
    readonly read: Effect.Effect<string | undefined, VaultError>;
    /** Saves the sign-in, or forgets it with `undefined`. */
    write(value: string | undefined): Effect.Effect<void, VaultError>;
  }
>()("cerium/account/Vault") {}
