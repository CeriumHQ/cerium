import { usableStatus } from "@cerium/acp";
import { shareProbe, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import type { HarnessStatus } from "@cerium/protocol";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { inspectGrok } from "./catalog.ts";
import { PROVIDER, SIGNED_OUT, failure, grokHarness, grokManifest } from "./manifest.ts";
import { startGrokSession } from "./session.ts";
import { readGrokUsage } from "./usage.ts";

export class GrokAdapter extends Context.Service<GrokAdapter, HarnessAdapter>()(
  "cerium/adapters/grok/GrokAdapter",
) {
  /** Requires ChildProcessSpawner, FileSystem and Path, as provided by NodeServices.layer. */
  static readonly layer = Layer.effect(
    GrokAdapter,
    Effect.gen(function* () {
      const platform = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      >();
      const inspect = inspectGrok().pipe(Effect.provide(platform));
      const probes = yield* shareProbe(inspect.pipe(Effect.map(({ status }) => status)));
      const requireLogin = (status: HarnessStatus) => usableStatus(grokHarness, status);
      return GrokAdapter.of({
        provider: PROVIDER,
        hubInstructions: {
          files: [
            { path: "AGENTS.md", primary: true },
            { path: "AGENT.md" },
            { path: "CLAUDE.md" },
            { path: "CLAUDE.local.md", supplemental: true },
          ],
          folders: [{ path: ".claude/rules", suffix: ".md", recursive: true }],
        },
        manifest: grokManifest,
        probe: probes.fresh,
        listModels: inspect.pipe(
          Effect.tap(({ status }) => requireLogin(status)),
          Effect.map(({ models }) => models),
        ),
        usage: probes.kept.pipe(
          Effect.flatMap(requireLogin),
          Effect.flatMap((status) =>
            status.auth._tag === "LoggedIn" && status.auth.method === "apiKey"
              ? Effect.succeedNone
              : readGrokUsage(status.executablePath).pipe(Effect.provide(platform)),
          ),
        ),
        startSession: (options: SessionOptions) =>
          probes.kept.pipe(
            Effect.flatMap(requireLogin),
            Effect.flatMap(({ executablePath }) =>
              startGrokSession(executablePath, options).pipe(Effect.provide(platform)),
            ),
            Effect.map((session) => probes.watchSignIn(session, SIGNED_OUT)),
          ),
        // The CLI's ACP and headless paths persist sessions and load Grok's configuration.
        complete: () => Effect.fail(failure("Grok Build has no isolated, unsaved helper completion mode")),
      });
    }),
  );
}
