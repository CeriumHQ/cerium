import { Schema } from "effect";

export const UpdateChannel = Schema.Literals(["stable", "nightly"]);
export type UpdateChannel = typeof UpdateChannel.Type;
const version = { version: Schema.String };
export const UpdateStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unsupported") }),
  Schema.Struct({ kind: Schema.Literal("checking") }),
  Schema.Struct({ kind: Schema.Literal("current"), checkedAt: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("available"), ...version }),
  Schema.Struct({ kind: Schema.Literal("downloading"), ...version, percent: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("ready"), ...version }),
  Schema.Struct({ kind: Schema.Literal("installing"), ...version }),
  Schema.Struct({
    kind: Schema.Literal("unreachable"),
    reason: Schema.Literals(["offline", "unpublished"]),
    checkedAt: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    ...version,
    stage: Schema.optionalKey(Schema.Literal("install")),
  }),
]);
export type UpdateStatus = typeof UpdateStatus.Type;

export const Updates = Schema.Struct({
  ...version,
  channel: UpdateChannel,
  buildChannel: UpdateChannel,
  status: UpdateStatus,
  manual: Schema.Boolean,
  autoDownload: Schema.Boolean,
});
export type Updates = typeof Updates.Type;

export const RemoteUpdates = Schema.Struct({
  ...Updates.fields,
  /** The desktop owns a requested restart even after the phone disconnects. */
  restart: Schema.Literals(["idle", "requested", "working"]),
});
export type RemoteUpdates = typeof RemoteUpdates.Type;

export const UpdateCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("check") }),
  Schema.Struct({ kind: Schema.Literal("apply"), ...version }),
]);
export type UpdateCommand = typeof UpdateCommand.Type;

/** Private messages on the desktop shell's utility-process port. */
export const ShellUpdateRequest = Schema.Struct({
  type: Schema.Literal("desktopUpdate"),
  command: Schema.Union([UpdateCommand, Schema.Null]),
});
export const ShellUpdateState = Schema.Struct({
  type: Schema.Literal("desktopUpdateState"),
  updates: RemoteUpdates,
});
