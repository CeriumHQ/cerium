/** Narrowing for the loosely typed JSON ACP agents send. Nothing here throws. */

export type JsonRecord = Readonly<Record<string, unknown>>;

/** A JSON object, or `undefined` for anything else (arrays included). */
export const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;

/** A non-empty string, or `undefined`. */
export const string = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** An array, or an empty one for anything else. */
export const array = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

/** A token or byte count: a non-negative safe integer, or `undefined`. */
export const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
