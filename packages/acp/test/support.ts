import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Scope } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type AcpHarness } from "../src/index.ts";

export const harness: AcpHarness = {
  provider: "devin",
  label: "Fixture",
  installHint: "Install the fixture.",
  loginCommand: "fixture login",
  signedOut: "Fixture is not signed in.",
};

const agent = fileURLToPath(new URL("./fixtures/agent.mjs", import.meta.url));

/** A connection to the fixture agent in a scratch folder, and the log of every message it received. */
export const fixture = (env: Readonly<Record<string, string>> = {}, over: Partial<AcpHarness> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-acp-test-" });
    const logFile = join(cwd, "received.jsonl");
    const acp = yield* connect(
      { ...harness, ...over },
      { executable: process.execPath, args: [agent], cwd, env: { ACP_FIXTURE_LOG: logFile, ...env } },
      { meta: { client: "test" } },
    );
    const received = fs.readFileString(logFile).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((text) =>
        text
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Received),
      ),
    );
    return { acp, cwd, received };
  });

/** A message the fixture received. */
export interface Received {
  readonly method?: string;
  readonly id?: unknown;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly result?: Readonly<Record<string, unknown>>;
}

/** Runs a test's effect on Node's platform services, in a scope of its own. */
export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
