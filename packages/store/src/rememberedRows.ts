import { Effect, Option } from "effect";

/** Cache list rows by identity; changing one agent must not decode every agent again. */
export const rememberedRows = <A extends { readonly id: string; readonly createdAt: number }, E>(
  fresh: Effect.Effect<ReadonlyArray<A>, E>,
  one: (id: A["id"]) => Effect.Effect<Option.Option<A>, E>,
  notify: Effect.Effect<void>,
) => {
  let kept: Option.Option<ReadonlyArray<A>> = Option.none();
  let writes = 0;
  return {
    read: Effect.suspend(() => {
      if (Option.isSome(kept)) return Effect.succeed(kept.value);
      const before = writes;
      return Effect.tap(fresh, (rows) =>
        Effect.sync(() => {
          if (writes === before) kept = Option.some(rows);
        }),
      );
    }),
    changed:
      (id: A["id"]) =>
      <B, E2, R>(write: Effect.Effect<B, E2, R>) =>
        Effect.tap(write, () =>
          Effect.gen(function* () {
            const before = ++writes;
            const previous = kept;
            kept = Option.none();
            if (Option.isSome(previous)) {
              const row = yield* one(id);
              if (writes === before) {
                const index = previous.value.findIndex((item) => item.id === id);
                const rows = [...previous.value];
                if (index >= 0) {
                  if (Option.isSome(row)) rows[index] = row.value;
                  else rows.splice(index, 1);
                } else if (Option.isSome(row)) {
                  rows.push(row.value);
                  rows.sort((a, b) => a.createdAt - b.createdAt);
                }
                kept = Option.some(rows);
              }
            }
            yield* notify;
          }),
        ),
    forget: <B, E2, R>(write: Effect.Effect<B, E2, R>) =>
      Effect.tap(write, () =>
        Effect.gen(function* () {
          writes++;
          kept = Option.none();
          yield* notify;
        }),
      ),
  };
};
