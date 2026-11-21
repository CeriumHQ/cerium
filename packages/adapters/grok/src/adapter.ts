import {
  findExecutable,
  listAcpSessions,
  probeWorkspace,
  readAcpSession,
  record,
  requireExecutable,
  usableStatus,
} from "@cerium/acp";
import { shareProbe, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import type { HarnessStatus } from "@cerium/protocol";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { authenticate, connectGrok, inspectGrok } from "./catalog.ts";
import { askGrokSideQuestion, forkGrokSession, replayMeta } from "./history.ts";
import { makeGrokHub, readGrokMcpStatus } from "./hub.ts";
import { PROVIDER, SIGNED_OUT, failure, grokHarness, grokManifest } from "./manifest.ts";
import { startGrokSession } from "./session.ts";
import { grokTranslator } from "./translate.ts";
import { readGrokUsage } from "./usage.ts";

export class GrokAdapter extends Context.Service<GrokAdapter, HarnessAdapter>()(
  "cerium/adapters/grok/GrokAdapter",
) {
  /** Requires ChildProcessSpawner, FileSystem and Path, as provided by NodeServices.layer. */
  static readonly layer = Layer.effect(
    GrokAdapter,
    Effect.gen(function* () {
      const platform = Context.pick(
        ChildProcessSpawner.ChildProcessSpawner,
        FileSystem.FileSystem,
        Path.Path,
      )(yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>());
      const executable = findExecutable("grok").pipe(
        Effect.flatMap((cli) => requireExecutable(grokHarness, cli)),
        Effect.provide(platform),
      );
      const hub = yield* makeGrokHub(executable);
      const path = yield* Path.Path;
      const liveMcp = new Set<{
        readonly cwd: string;
        readonly status: ReturnType<typeof readGrokMcpStatus>;
      }>();
      const history = Effect.gen(function* () {
        const cli = yield* executable;
        const cwd = yield* probeWorkspace(grokHarness);
        const acp = yield* connectGrok(cli, cwd, "read-only", false);
        yield* authenticate(acp);
        return acp;
      });
      const inspect = inspectGrok().pipe(Effect.provide(platform));
      const probes = yield* shareProbe(inspect.pipe(Effect.map(({ status }) => status)));
      const requireLogin = (status: HarnessStatus) => usableStatus(grokHarness, status);
      return GrokAdapter.of({
        provider: PROVIDER,
        listSkills: hub.listSkills,
        hub: {
          ...hub.hub,
          support: { ...hub.hub.support, status: true },
          status: (project) =>
            Effect.suspend(
              () =>
                [...liveMcp].findLast((entry) => entry.cwd === path.resolve(project))?.status ??
                Effect.succeed([]),
            ),
        },
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
        fork: (request) =>
          history.pipe(
            Effect.flatMap((acp) => forkGrokSession(acp, request)),
            Effect.scoped,
            Effect.provide(platform),
          ),
        sideQuestion: (request) =>
          history.pipe(
            Effect.flatMap((acp) => askGrokSideQuestion(acp, request)),
            Effect.scoped,
            Effect.provide(platform),
          ),
        listSessions: history.pipe(
          Effect.flatMap((acp) => listAcpSessions(acp)),
          Effect.scoped,
          Effect.provide(platform),
        ),
        readSession: (session) =>
          history.pipe(
            Effect.flatMap((acp) =>
              readAcpSession(acp, session, grokTranslator(), {
                meta: replayMeta,
                promptInfo: (update) => {
                  const id = record(update["_meta"])?.["promptIndex"];
                  return typeof id === "number" ? { id } : {};
                },
              }),
            ),
            Effect.scoped,
            Effect.provide(platform),
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
              startGrokSession(executablePath, options, (acp, sessionId) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    const entry = {
                      cwd: path.resolve(options.cwd),
                      status: readGrokMcpStatus(acp, sessionId),
                    };
                    liveMcp.add(entry);
                    return entry;
                  }),
                  (entry) =>
                    Effect.sync(() => {
                      liveMcp.delete(entry);
                    }),
                ).pipe(Effect.asVoid),
              ).pipe(Effect.provide(platform)),
            ),
            Effect.map((session) => probes.watchSignIn(session, SIGNED_OUT)),
          ),
        // The CLI's ACP and headless paths persist sessions and load Grok's configuration.
        complete: () => Effect.fail(failure("Grok Build has no isolated, unsaved helper completion mode")),
      });
    }),
  );
}
