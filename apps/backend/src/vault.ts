import { randomUUID } from "node:crypto";

import { Vault, VaultError } from "@cerium/account";
import { Deferred, Effect, FileSystem, Layer, Option, Path } from "effect";

import type { ParentPort } from "./shell.ts";

// Where the backend keeps this machine's Cerium sign-in: the one credential Cerium holds, its own
// (docs/architecture.md §14.2). The packaged shell encrypts it with Windows' data protection; a
// development backend keeps it in its data folder as it is.

/** What the backend asks the shell over its parent port, and what the shell answers. */
export interface VaultRequest {
  readonly type: "vault";
  readonly id: string;
  readonly op: "read" | "write";
  /** For a write: the new contents, or `null` to forget them. */
  readonly value?: string | null;
}

export interface VaultReply {
  readonly type: "vault";
  readonly id: string;
  readonly value?: string | null;
  readonly error?: string;
}

const isReply = (message: unknown): message is VaultReply =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "vault" &&
  typeof (message as { id?: unknown }).id === "string";

/** The packaged shell's vault, asked for over the backend's parent port. */
export const shellVault = (port: ParentPort) =>
  Layer.sync(Vault, () => {
    const waiting = new Map<string, (reply: VaultReply) => void>();
    port.on("message", ({ data }) => {
      if (!isReply(data)) return;
      waiting.get(data.id)?.(data);
      waiting.delete(data.id);
    });

    const ask = (request: Omit<VaultRequest, "type" | "id">) =>
      Effect.gen(function* () {
        const id = randomUUID();
        const answer = yield* Deferred.make<VaultReply>();
        waiting.set(id, (reply) => Deferred.doneUnsafe(answer, Effect.succeed(reply)));
        port.postMessage({ type: "vault", id, ...request } satisfies VaultRequest);
        const reply = yield* Deferred.await(answer).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.fail(new VaultError({ message: "Cerium's window didn't answer in time." })),
          }),
          Effect.ensuring(Effect.sync(() => waiting.delete(id))),
        );
        if (reply.error !== undefined) return yield* new VaultError({ message: reply.error });
        return reply;
      });

    return Vault.of({
      read: ask({ op: "read" }).pipe(Effect.map((reply) => reply.value ?? undefined)),
      write: (value) => ask({ op: "write", value: value ?? null }).pipe(Effect.asVoid),
    });
  });

/** A development backend's vault: a plain file. Requires `FileSystem` and `Path`. */
export const fileVault = (file: string) =>
  Layer.effect(
    Vault,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const failed = (message: string) => () => new VaultError({ message });
      return Vault.of({
        read: fs.readFileString(file).pipe(Effect.option, Effect.map(Option.getOrUndefined)),
        write: (value) =>
          value === undefined
            ? fs.remove(file, { force: true }).pipe(Effect.mapError(failed("Couldn't forget the sign-in.")))
            : fs
                .makeDirectory(path.dirname(file), { recursive: true })
                .pipe(
                  Effect.andThen(fs.writeFileString(file, value)),
                  Effect.mapError(failed("Couldn't save the sign-in.")),
                ),
      });
    }),
  );
