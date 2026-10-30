import { Skippable, ThreadId } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

// The browser a thread's agents drive and its user watches in the Preview pane. The desktop shell
// holds each thread's page; the backend's bus tools reach it through the desktop window's own
// connection: the window hosts the browser (`HostBrowser`), takes each call the agents make, has the
// shell run it, and answers (`AnswerBrowser`). A device with no shell, a browser or a phone, hosts
// none, and the agents are told so. Mirrors `BrowserCommand` in @cerium/browser.

/** Where an action lands: visible text or an accessible name, a CSS selector, or a point. */
export const BrowserTarget = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  selector: Schema.optionalKey(Schema.String),
  nth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  x: Schema.optionalKey(Schema.Finite),
  y: Schema.optionalKey(Schema.Finite),
});
export type BrowserTarget = typeof BrowserTarget.Type;

export const BrowserAction = Schema.Literals([
  "click",
  "doubleClick",
  "rightClick",
  "hover",
  "type",
  "fill",
  "press",
  "scroll",
  "drag",
  "wait",
  "waitGone",
  "sleep",
]);
export type BrowserAction = typeof BrowserAction.Type;

export const BrowserStep = Schema.Struct({
  ...BrowserTarget.fields,
  action: BrowserAction,
  value: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(BrowserTarget),
  ms: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
});
export type BrowserStep = typeof BrowserStep.Type;

const VisualReview = Schema.Struct({
  session: Schema.String,
  state: Schema.optionalKey(Schema.String),
  defect: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(Schema.String),
});

export const BrowserCommand = Schema.Union([
  Schema.TaggedStruct("Open", {
    url: Schema.optionalKey(Schema.String),
    go: Schema.optionalKey(Schema.Literals(["back", "forward", "reload"])),
  }),
  Schema.TaggedStruct("Read", { text: Schema.Boolean }),
  Schema.TaggedStruct("Act", {
    steps: Schema.Array(BrowserStep).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
    screenshot: Schema.Boolean,
    of: Schema.optionalKey(BrowserTarget),
    review: Schema.optionalKey(VisualReview),
  }),
  Schema.TaggedStruct("Screenshot", {
    fullPage: Schema.Boolean,
    of: Schema.optionalKey(BrowserTarget),
    review: Schema.optionalKey(VisualReview),
  }),
  Schema.TaggedStruct("Logs", {}),
]);
export type BrowserCommand = typeof BrowserCommand.Type;

/** One call an agent made, for the window hosting the browser to run in its thread's page. */
export const BrowserCall = Schema.Struct({
  requestId: Schema.NonEmptyString,
  threadId: ThreadId,
  command: BrowserCommand,
});
export type BrowserCall = typeof BrowserCall.Type;

/** What the call came to: what the agent reads, and a PNG (base64) when it asked for one. */
export const BrowserOutcome = Schema.Union([
  Schema.TaggedStruct("Done", { text: Schema.String, image: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct("Failed", { message: Schema.String }),
]);
export type BrowserOutcome = typeof BrowserOutcome.Type;

/** A desktop window's side of the browser; merged into `DeviceRpcs`, which no tunnel serves. */
export const BrowserHostRpcs = RpcGroup.make(
  /**
   * The window hosts its threads' browsers while subscribed: each call an agent makes arrives here,
   * to be answered with `AnswerBrowser`. One of a kind the window's version doesn't know arrives as
   * `undefined`, and goes unanswered until the backend's timeout. Since `RPC_VERSION` 31.
   */
  Rpc.make("HostBrowser", { success: Skippable(BrowserCall), stream: true }),
  /** Answers a `HostBrowser` call. Since `RPC_VERSION` 31. */
  Rpc.make("AnswerBrowser", { payload: { requestId: Schema.NonEmptyString, outcome: BrowserOutcome } }),
);
