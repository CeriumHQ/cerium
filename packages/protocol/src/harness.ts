import { Schema } from "effect";

import { ProviderId } from "./ids.ts";
import { AccessMode } from "./orchestration.ts";

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

/**
 * A one-time step the harness needs on this machine before its agents can run commands in some access
 * modes, such as Muse's Windows sandbox. Cerium tells the user and shows the harness's own command.
 */
export const HarnessSetup = Schema.Struct({
  /** What the step sets up, e.g. "Windows sandbox". */
  name: Schema.NonEmptyString,
  /** The harness's own words for what is missing. */
  reason: Schema.NonEmptyString,
  /** The harness's command that does the step. */
  command: Schema.NonEmptyString,
  /** The command must run in a terminal opened as administrator. */
  elevated: Schema.Boolean,
  /** The access modes whose commands fail until it's done. */
  blocks: Schema.Array(AccessMode),
});
export type HarnessSetup = typeof HarnessSetup.Type;

export const HarnessInstalled = Schema.TaggedStruct("HarnessInstalled", {
  provider: ProviderId,
  executablePath: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  versionStatus: VersionStatus,
  auth: AuthStatus,
  setup: Schema.optionalKey(HarnessSetup),
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
