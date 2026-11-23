import { DeviceRpcs, ShellUpdateRequest, type RemoteUpdates } from "@cerium/rpc";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { checkRelease, prepareRelease, type AvailableRelease } from "./update.ts";

export function agentsWorking(connection: { url: string; token: string }) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(DeviceRpcs);
      return Option.getOrElse(yield* Stream.runHead(client.WatchWorking()), () => true);
    }).pipe(
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            Socket.layerWebSocket(`${connection.url}?token=${encodeURIComponent(connection.token)}`),
          ),
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
          Layer.provide(RpcSerialization.layerJson),
        ),
      ),
      Effect.scoped,
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => true),
    ),
  );
}

const isRequest = Schema.is(ShellUpdateRequest);

/** The supervisor owns a remote update after the phone disconnects. Only an offered version can be applied. */
export function remoteUpdates(options: {
  version: string;
  channel: "stable" | "nightly";
  root: string | undefined;
  send: (state: RemoteUpdates) => void;
  working: () => Promise<boolean>;
  restart: () => void;
  check?: typeof checkRelease;
  prepare?: typeof prepareRelease;
}) {
  let offer: AvailableRelease | undefined;
  let staged: Awaited<ReturnType<typeof prepareRelease>> | undefined;
  let operation: Promise<void> | undefined;
  const controller = new AbortController();
  let closed = false;
  let checked = false;
  let state: RemoteUpdates = {
    version: options.version,
    channel: options.channel,
    buildChannel: options.channel,
    autoDownload: false,
    manual: !options.root,
    restart: "idle",
    status: { kind: options.root ? "checking" : "unsupported" },
  };
  function publish(status: RemoteUpdates["status"], restart: RemoteUpdates["restart"] = "idle") {
    state = { ...state, status, restart };
    if (!closed) options.send(state);
  }
  async function check() {
    checked = true;
    publish({ kind: "checking" });
    try {
      offer = await (options.check ?? checkRelease)(options.version, options.channel);
      publish(
        offer ? { kind: "available", version: offer.version } : { kind: "current", checkedAt: Date.now() },
      );
    } catch {
      offer = undefined;
      publish({ kind: "unreachable", reason: "offline", checkedAt: Date.now() });
    }
  }
  async function apply(root: string, release: AvailableRelease) {
    const version = release.version;
    try {
      if (!staged) {
        publish({ kind: "downloading", version, percent: 0 }, "requested");
        staged = await (options.prepare ?? prepareRelease)(
          root,
          release,
          (percent) => {
            publish({ kind: "downloading", version, percent }, "requested");
          },
          controller.signal,
        );
      }
      if (closed) return;
      if (await options.working()) return publish({ kind: "ready", version }, "working");
      if (closed) return;
      publish({ kind: "installing", version }, "requested");
      await staged.activate(() => {});
      await staged.discard();
      staged = undefined;
      if (!closed) options.restart();
    } catch {
      await staged?.discard();
      staged = undefined;
      publish({ kind: "failed", version, stage: "install" });
    }
  }
  return {
    async receive(message: unknown) {
      if (!isRequest(message) || closed) return;
      const { command } = message;
      options.send(state);
      if (!options.root || operation) return;
      if (
        command?.kind === "apply" &&
        offer?.version === command.version &&
        state.status.kind !== "installing"
      )
        operation = apply(options.root, offer);
      else if ((!command && !checked) || (command?.kind === "check" && !staged)) operation = check();
      else return;
      try {
        await operation;
      } finally {
        operation = undefined;
      }
    },
    async close() {
      closed = true;
      controller.abort();
      await operation;
      await staged?.discard();
    },
  };
}
