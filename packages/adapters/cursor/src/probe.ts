import { AuthenticationError, Cursor, CursorSdkError, type ModelListItem } from "@cursor/sdk";
import { classifyVersion, HarnessFailure } from "@cerium/harness";
import type { AuthStatus, HarnessStatus } from "@cerium/protocol";
import { Effect, FileSystem, Path, Schema } from "effect";

import { cursorManifest } from "./manifest.ts";
import { fetchModelCatalog } from "./models.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "cursor", message, cause });

const SdkPackage = Schema.Struct({ name: Schema.Literal("@cursor/sdk"), version: Schema.String });
const decodeSdkPackage = Schema.decodeUnknownEffect(Schema.fromJsonString(SdkPackage));

/** The SDK install sessions run on: its package directory and version. */
export const findCursorSdk = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entryUrl = yield* Effect.try(() => new URL(import.meta.resolve("@cursor/sdk")));
  // `dist/<format>/index.js` → the package root.
  const directory = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(entryUrl))));
  const { version } = yield* decodeSdkPackage(yield* fs.readFileString(path.join(directory, "package.json")));
  return { directory, version };
}).pipe(Effect.mapError(failure("Could not locate @cursor/sdk")));

/** "No credentials" (the SDK refuses before any request) or a rejected key. */
export const isUnauthenticated = (cause: unknown) =>
  cause instanceof AuthenticationError ||
  (cause instanceof CursorSdkError && cause.code === "unauthenticated");

/**
 * Whether the SDK can authenticate. Its stored login reports status without the key. Without one the
 * SDK may still use `CURSOR_API_KEY` from the environment, which Cerium never reads: an account request
 * (the model list) through the SDK's own credential lookup settles it.
 */
const cursorAuth = (catalog: Effect.Effect<ReadonlyArray<ModelListItem>, HarnessFailure>) =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => Cursor.auth.status(),
      catch: failure("Could not read the Cursor SDK's login status"),
    });
    if (stored.status === "logged-in")
      return { _tag: "LoggedIn", method: "cursorLogin" } satisfies AuthStatus;
    return yield* catalog.pipe(
      Effect.as<AuthStatus>({ _tag: "LoggedIn", method: "apiKey" }),
      Effect.catchIf(
        (error) => isUnauthenticated(error.cause),
        () => Effect.succeed<AuthStatus>({ _tag: "LoggedOut", browserLogin: true }),
      ),
    );
  });

/** Probes with the given model-list request, so the adapter can share one cached catalog. */
export const makeCursorProbe = (catalog: Effect.Effect<ReadonlyArray<ModelListItem>, HarnessFailure>) =>
  Effect.gen(function* () {
    const sdk = yield* findCursorSdk;
    return {
      _tag: "HarnessInstalled",
      provider: "cursor",
      executablePath: sdk.directory,
      version: sdk.version,
      versionStatus: classifyVersion(sdk.version, cursorManifest.harnessVersion),
      auth: yield* cursorAuth(catalog),
    } satisfies HarnessStatus;
  });

export const probeCursor = makeCursorProbe(fetchModelCatalog);
