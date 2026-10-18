import { Effect, Option, Schema, SchemaTransformation } from "effect";

// Reading what another version of Cerium wrote (docs/architecture.md §14.1). Machines, browsers and
// the relay run different versions, and newer ones add values, events and fields. What an older
// version can't read mustn't hide a thread or end a feed: an enum that grows reads its unknown
// values as a fallback, and a list or feed skips the items it can't read.

/** A schema that reads a value this version doesn't know as `fallback`. */
export const withFallback = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  schema.pipe(Schema.catchDecoding(() => Effect.succeedSome(fallback)));

/** A list that skips the items it can't read, rather than failing as a whole. */
export const LenientArray = <S extends Schema.Codec<unknown, unknown>>(item: S) => {
  const decodeItem = Schema.decodeUnknownOption(item);
  const encodeItem = Schema.encodeSync(item);
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(item)),
      SchemaTransformation.transform({
        decode: (items): ReadonlyArray<S["Type"]> =>
          items.flatMap((each) => Option.toArray(decodeItem(each))),
        encode: (items): ReadonlyArray<unknown> => items.map((each) => encodeItem(each)),
      }),
    ),
  );
};

/**
 * One item of a feed, read as `undefined` when this version can't read it, so the feed carries on.
 * Readers skip the `undefined`s.
 */
export const Skippable = <S extends Schema.Codec<unknown, unknown>>(item: S) => {
  const decodeItem = Schema.decodeUnknownOption(item);
  const encodeItem = Schema.encodeSync(item);
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.UndefinedOr(Schema.toType(item)),
      SchemaTransformation.transform({
        decode: (value) => Option.getOrUndefined(decodeItem(value)),
        encode: (value) => (value === undefined ? undefined : encodeItem(value)),
      }),
    ),
  );
};
