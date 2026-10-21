// Calls the running development backend over its RPC endpoint, like the UI does.
//
// Usage: node apps/backend/scripts/rpc-smoke.ts   (after `bun run dev:backend`)

import { CeriumRpcs } from "@cerium/rpc";
import { NodeRuntime, NodeSocket } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { readFileSync } from "node:fs";

const { url, token } = JSON.parse(readFileSync(".cerium-dev/connection.json", "utf8")) as {
  url: string;
  token: string;
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(CeriumRpcs);
  const threads = yield* client.ListThreads();
  yield* Console.log(`threads: ${threads.length}`);
  for (const status of yield* client.HarnessStatuses()) {
    yield* Console.log(
      status._tag === "HarnessInstalled"
        ? `${status.provider}: ${status.version} ${status.latestVersion === undefined ? "" : ` (${status.latestVersion} available)`}, ${status.auth._tag}`
        : `${status.provider}: not installed`,
    );
  }
}).pipe(
  Effect.scoped,
  Effect.provide(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(NodeSocket.layerWebSocket(`${url}?token=${token}`)),
      Layer.provide(RpcSerialization.layerJson),
    ),
  ),
);

NodeRuntime.runMain(program);
