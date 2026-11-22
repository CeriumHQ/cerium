import type { AccountState, DeviceId } from "@cerium/protocol";
import { CeriumError, ShellUpdateState, type RemoteUpdates, type UpdateCommand } from "@cerium/rpc";
import { Effect, Option, Queue, Schema, Stream } from "effect";

import type { ParentPort } from "./shell.ts";

const isState = Schema.is(ShellUpdateState);

/** Each subscriber gets the shell's current state first, including after a reconnect. */
export const watchDesktopUpdates = (port: ParentPort | undefined) => {
  if (!port) return Stream.succeed(null);
  return Stream.callback<RemoteUpdates>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const receive = ({ data }: { data: unknown }) => {
            if (isState(data)) Queue.offerUnsafe(queue, data.updates);
          };
          port.on("message", receive);
          port.postMessage({ type: "desktopUpdate", command: null });
          return receive;
        }),
        (receive) => Effect.sync(() => port.off("message", receive)),
      ),
    { bufferSize: 1, strategy: "sliding" },
  );
};

/** Pin the action to the computer the user chose even if the client switches tunnels. */
export const runDesktopUpdate = (
  account: Stream.Stream<AccountState>,
  port: ParentPort | undefined,
  deviceId: DeviceId,
  command: UpdateCommand,
) =>
  Effect.gen(function* () {
    const state = Option.getOrUndefined(yield* Stream.runHead(account));
    if (state?._tag !== "SignedIn" || state.deviceId !== deviceId)
      return yield* new CeriumError({ message: "Select this computer again before updating it." });
    if (!port) return yield* new CeriumError({ message: "This installation needs a local update." });
    port.postMessage({ type: "desktopUpdate", command });
  });
