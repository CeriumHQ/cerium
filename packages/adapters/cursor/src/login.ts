import { Cursor } from "@cursor/sdk";
import { HarnessFailure } from "@cerium/harness";
import type { LoginProgress } from "@cerium/protocol";
import { Effect, Queue, Stream } from "effect";

/** How the key the sign-in creates is named in the user's Cursor dashboard, where they can revoke it. */
const KEY_NAME = "Cerium";

/**
 * The SDK's own browser sign-in. Cursor creates a named, expiring user API key and the SDK saves it in
 * its credential file (`~/.cursor/sdk/auth.json`), where sessions find it. `login` also returns the
 * key; it is dropped here unread. Interrupting the stream aborts the SDK's wait for the browser.
 */
export const cursorLogin: Stream.Stream<LoginProgress, HarnessFailure> = Stream.callback<
  LoginProgress,
  HarnessFailure
>((queue) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: (signal) =>
        Cursor.auth.login({
          openBrowser: false,
          onLoginUrl: (url) => Queue.offerUnsafe(queue, { _tag: "OpenUrl", url }),
          signal,
          apiKeyName: KEY_NAME,
        }),
      catch: (cause) =>
        new HarnessFailure({ provider: "cursor", message: "Cursor sign-in didn't finish", cause }),
    });
    yield* Queue.offer(queue, { _tag: "SignedIn" });
    yield* Queue.end(queue);
  }),
);
