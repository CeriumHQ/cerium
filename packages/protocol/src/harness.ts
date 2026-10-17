import { Schema } from "effect";

import { ProviderId } from "./ids.ts";

/** How the installed harness version relates to the adapter's tested range. */
export const VersionStatus = Schema.Literals(["supported", "untested", "tooOld"]);
export type VersionStatus = typeof VersionStatus.Type;

export const LoggedIn = Schema.TaggedStruct("LoggedIn", {
  /** e.g. "claude.ai", "apiKey". Never a credential. */
  method: Schema.optionalKey(Schema.NonEmptyString),
  /** Subscription plan when the harness reports one; drives concurrency defaults. */
  plan: Schema.optionalKey(Schema.NonEmptyString),
});

export const LoggedOut = Schema.TaggedStruct("LoggedOut", {
  /** The harness's own login command for Cerium to run in its terminal. */
  loginCommand: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * The harness's SDK signs in through its own page in the browser instead (`LoginHarness`). The SDK
   * keeps what the sign-in creates; Cerium only starts it.
   */
  browserLogin: Schema.optionalKey(Schema.Boolean),
});

export const AuthStatus = Schema.Union([LoggedIn, LoggedOut]);
export type AuthStatus = typeof AuthStatus.Type;

export const HarnessMissing = Schema.TaggedStruct("HarnessMissing", {
  provider: ProviderId,
  installHint: Schema.NonEmptyString,
});

export const HarnessInstalled = Schema.TaggedStruct("HarnessInstalled", {
  provider: ProviderId,
  executablePath: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  versionStatus: VersionStatus,
  auth: AuthStatus,
});

/** How a browser sign-in is going, as the harness's SDK reports it. */
export const LoginProgress = Schema.Union([
  /** The page the user signs in on; the UI opens it in their browser. */
  Schema.TaggedStruct("OpenUrl", { url: Schema.NonEmptyString }),
  Schema.TaggedStruct("SignedIn", {}),
]);
export type LoginProgress = typeof LoginProgress.Type;

/** Result of probing the user's machine for a provider's harness. */
export const HarnessStatus = Schema.Union([HarnessMissing, HarnessInstalled]);
export type HarnessStatus = typeof HarnessStatus.Type;
