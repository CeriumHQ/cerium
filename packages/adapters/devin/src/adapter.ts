import {
  acpTimestamp,
  usableStatus as acpUsableStatus,
  listAcpSessions,
  probeWorkspace,
  readAcpSession,
  record,
  requireExecutable,
  string,
} from "@cerium/acp";
import { shareProbe, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import type { HarnessStatus } from "@cerium/protocol";
import { Clock, Context, Deferred, Duration, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { makeDevinHub } from "./hub.ts";
import { PROVIDER, SIGNED_OUT, devinHarness, devinManifest, failure } from "./manifest.ts";
import { modelIds, toModelInfos, type Variant } from "./models.ts";
import { connectDevin, discoverDevin, findDevinExecutable, sweepVariants } from "./probe.ts";
import { startDevinSession } from "./session.ts";
import { listDevinSkills } from "./skills.ts";
import { DevinTranslator } from "./translate.ts";
import { readDevinUsage } from "./usage.ts";

/** How long a sweep's efforts and speeds are trusted before the next listing reads them again. */
const SWEEP_FRESH_MS = Duration.toMillis(Duration.minutes(30));
/** How long a listing waits for a sweep that knows nothing yet; the backend allows 20 seconds in all. */
const FIRST_SWEEP_WAIT = "12 seconds";

/**
 * Defaults to finding the user's `devin` on PATH and reading their Devin settings from where the CLI
 * keeps them. A caller may supply either path instead.
 */
export const makeDevinAdapter = (executable?: string, userConfig?: string) =>
  Effect.gen(function* () {
    // Only these services: the layer's whole context would also carry its Scope, which would then
    // replace the scope a session is started in, and keep its `devin acp` running after it closes.
    const platform = Context.pick(
      ChildProcessSpawner.ChildProcessSpawner,
      FileSystem.FileSystem,
      Path.Path,
    )(yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>());
    const scope = yield* Effect.scope;
    const hub = yield* makeDevinHub(userConfig);
    const cli = Effect.gen(function* () {
      return yield* requireExecutable(devinHarness, executable ?? (yield* findDevinExecutable));
    }).pipe(Effect.provide(platform));
    const history = Effect.gen(function* () {
      const path = yield* cli;
      const cwd = yield* probeWorkspace(devinHarness);
      return yield* connectDevin(path, cwd, userConfig);
    });
    const discover = discoverDevin(executable).pipe(Effect.provide(platform));
    const probes = yield* shareProbe(discover.pipe(Effect.map(({ status }) => status)));

    /** The installed, signed-in CLI status, or why there is none. */
    const usableStatus = (status: HarnessStatus) => acpUsableStatus(devinHarness, status);
    const usable = (status: HarnessStatus) =>
      usableStatus(status).pipe(Effect.map((installed) => installed.executablePath));

    // Devin reports a model's efforts and speeds only once a session switches to it, a round trip each.
    // A background sweep reads them all and keeps them, so listings stay quick after the first.
    const variants = new Map<string, Variant>();
    let swept = new Set<string>();
    let sweptAt = Number.NEGATIVE_INFINITY;
    let sweeping: Deferred.Deferred<void> | undefined;
    const ensureSweep = (path: string, models: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (sweeping !== undefined) return sweeping;
        if (now - sweptAt < SWEEP_FRESH_MS && models.every((id) => swept.has(id))) return undefined;
        const done = yield* Deferred.make<void>();
        sweeping = done;
        swept = new Set(models);
        sweptAt = now;
        yield* sweepVariants(path, models, (id, variant) => variants.set(id, variant)).pipe(
          Effect.provide(platform),
          Effect.ignore,
          Effect.ensuring(
            Effect.suspend(() => {
              sweeping = undefined;
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkIn(scope),
        );
        return done;
      }).pipe(Effect.uninterruptible);

    const listModels = Effect.gen(function* () {
      const { status, config } = yield* discover;
      const path = yield* usable(status);
      const models = modelIds(config);
      const pending = yield* ensureSweep(path, models);
      if (pending !== undefined && !models.some((id) => variants.has(id))) {
        yield* Deferred.await(pending).pipe(Effect.timeout(FIRST_SWEEP_WAIT), Effect.ignore);
      }
      return toModelInfos(config, variants);
    });

    return {
      provider: PROVIDER,
      hub: hub.hub,
      hubInstructions: {
        files: [
          { path: "AGENTS.md", primary: true },
          { path: "AGENTS.local.md", supplemental: true },
          { path: "AGENT.md" },
          { path: "CLAUDE.md" },
          { path: ".devin/global_rules.md" },
        ],
        folders: [{ path: ".devin/rules", suffix: ".md" }],
      },
      manifest: devinManifest,
      probe: probes.fresh,
      listModels,
      listSkills: (cwd) =>
        history.pipe(
          Effect.flatMap((acp) => listDevinSkills(acp, cwd, () => hub.listSkills(cwd))),
          Effect.scoped,
          Effect.provide(platform),
        ),
      listSessions: history.pipe(
        Effect.flatMap((acp) =>
          listAcpSessions(acp, (row) => {
            const meta = record(row["_meta"]);
            if (meta?.["cognition.ai/hasUserMessages"] === false) return false;
            const createdAt = acpTimestamp(meta?.["cognition.ai/createdAt"]);
            return createdAt === undefined ? {} : { createdAt };
          }),
        ),
        Effect.scoped,
        Effect.provide(platform),
      ),
      readSession: (session) =>
        history.pipe(
          Effect.flatMap((acp) =>
            readAcpSession(acp, session, new DevinTranslator(), {
              promptInfo: (update) => {
                const meta = record(update["_meta"]);
                const id = string(meta?.["cognition.ai/eventId"]);
                const at = acpTimestamp(meta?.["cognition.ai/timestamp"]);
                return { ...(id === undefined ? {} : { id }), ...(at === undefined ? {} : { at }) };
              },
            }),
          ),
          Effect.scoped,
          Effect.provide(platform),
        ),
      usage: probes.kept.pipe(
        Effect.flatMap(usableStatus),
        Effect.flatMap(({ version }) => readDevinUsage(version).pipe(Effect.provide(platform))),
      ),
      // Devin's ACP sessions load the user's rules and are saved; there is no private completion.
      complete: () => Effect.fail(failure("Devin does not support private background completions")),
      startSession: (options: SessionOptions) =>
        probes.kept.pipe(
          Effect.flatMap(usable),
          Effect.flatMap((path) =>
            startDevinSession(path, options, userConfig).pipe(Effect.provide(platform)),
          ),
          Effect.map((session) => probes.watchSignIn(session, SIGNED_OUT)),
        ),
    } satisfies HarnessAdapter;
  });

export class DevinAdapter extends Context.Service<DevinAdapter, HarnessAdapter>()(
  "cerium/adapters/devin/DevinAdapter",
) {
  /** Requires the platform's ChildProcessSpawner, FileSystem and Path (e.g. NodeServices.layer). */
  static readonly layer = Layer.effect(DevinAdapter, makeDevinAdapter());
}
