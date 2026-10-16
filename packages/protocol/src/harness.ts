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
  loginCommand: Schema.NonEmptyString,
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

/** Result of probing the user's machine for a provider's harness. */
export const HarnessStatus = Schema.Union([HarnessMissing, HarnessInstalled]);
export type HarnessStatus = typeof HarnessStatus.Type;
