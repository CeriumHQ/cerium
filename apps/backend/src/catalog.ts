import { Adapters, Catalog, UserSettings, type CatalogEntry } from "@cerium/orchestrator";
import { rosterMembers, type ModelInfo, type ProviderId, type RosterMember } from "@cerium/protocol";
import { Context, Deferred, Duration, Effect, Layer, Scope } from "effect";

/** How long each harness may take to list its models. */
const LIST_TIMEOUT = "20 seconds";

/**
 * How long a harness that offered no models waits before a read of the catalog asks it again, in case
 * it was signed in outside Cerium meanwhile.
 */
const RELIST_AFTER = Duration.minutes(1);

/**
 * The roster's models as leads know them: by id, or `provider/id` where two harnesses list the same id.
 */
export const catalogEntries = (members: ReadonlyArray<RosterMember>): ReadonlyArray<CatalogEntry> =>
  members.map(({ model, use }): CatalogEntry => ({
    alias: members.some((other) => other.model !== model && other.model.id === model.id)
      ? `${model.provider}/${model.id}`
      : model.id,
    provider: model.provider,
    model: model.id,
    description: use,
  }));

/**
 * What every harness offers, kept current: listed as the backend starts, from whatever the UI reads of
 * a harness since, and again for a harness that offered nothing once it's signed in.
 */
export class OfferedModels extends Context.Service<
  OfferedModels,
  {
    /** Every harness's models, in the adapters' order; waits for the listing the backend starts with. */
    readonly all: Effect.Effect<ReadonlyArray<ModelInfo>>;
    /** Takes a harness's fresh list, such as the one the UI just read. */
    offer(provider: ProviderId, models: ReadonlyArray<ModelInfo>): Effect.Effect<void>;
    /**
     * Lists again, in the background, the harnesses that offered nothing: those of `ready` at once (they
     * were just found signed in), any other only once `RELIST_AFTER` has passed since its last try.
     */
    relistEmpty(ready?: ReadonlyArray<ProviderId>): Effect.Effect<void>;
  }
>()("cerium/backend/OfferedModels") {
  static readonly layer = Layer.effect(
    OfferedModels,
    Effect.gen(function* () {
      const adapters = yield* Adapters;
      const scope = yield* Scope.Scope;
      const offered = new Map<ProviderId, ReadonlyArray<ModelInfo>>();
      const triedAt = new Map<ProviderId, number>();
      const listing = new Set<ProviderId>();
      const started = yield* Deferred.make<void>();

      const all = Effect.sync(() => [...adapters.keys()].flatMap((provider) => offered.get(provider) ?? []));

      const list = (provider: ProviderId) =>
        Effect.suspend(() => {
          const adapter = adapters.get(provider);
          if (adapter === undefined || listing.has(provider)) return Effect.void;
          listing.add(provider);
          triedAt.set(provider, Date.now());
          return adapter.listModels.pipe(
            Effect.timeout(LIST_TIMEOUT),
            Effect.orElseSucceed((): ReadonlyArray<ModelInfo> => []),
            Effect.map((models) => void offered.set(provider, models)),
            Effect.ensuring(Effect.sync(() => listing.delete(provider))),
          );
        });

      yield* Effect.forEach([...adapters.keys()], list, { concurrency: "unbounded", discard: true }).pipe(
        Effect.ensuring(Deferred.succeed(started, undefined)),
        Effect.forkIn(scope),
      );

      return OfferedModels.of({
        all: Deferred.await(started).pipe(Effect.andThen(all)),
        offer: (provider, models) => Effect.sync(() => void offered.set(provider, models)),
        relistEmpty: (ready = []) =>
          Effect.suspend(() => {
            if (!Deferred.isDoneUnsafe(started)) return Effect.void;
            const now = Date.now();
            const due = [...adapters.keys()].filter(
              (provider) =>
                (offered.get(provider)?.length ?? 0) === 0 &&
                (ready.includes(provider) ||
                  now - (triedAt.get(provider) ?? 0) >= Duration.toMillis(RELIST_AFTER)),
            );
            return due.length === 0
              ? Effect.void
              : Effect.forEach(due, list, { concurrency: "unbounded", discard: true }).pipe(
                  Effect.forkIn(scope),
                  Effect.asVoid,
                );
          }),
      });
    }),
  );
}

/**
 * The catalog leads spawn from without asking: the roster (Settings → Agents) applied to what the
 * harnesses offer now, read afresh each time, so a roster change or a harness signed in reaches the
 * next spawn.
 */
export const CatalogLive = Layer.effect(
  Catalog,
  Effect.gen(function* () {
    const offered = yield* OfferedModels;
    const settings = yield* UserSettings;
    return Catalog.of({
      entries: Effect.gen(function* () {
        const models = yield* offered.all;
        yield* offered.relistEmpty();
        const { roster } = yield* settings.get;
        return catalogEntries(rosterMembers(roster, models));
      }),
      models: offered.all,
    });
  }),
);
