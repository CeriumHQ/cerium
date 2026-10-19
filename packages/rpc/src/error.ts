import { Schema } from "effect";

/** A request the backend refused; `message` is written for the user. */
export class CeriumError extends Schema.TaggedError<CeriumError>()("CeriumError", {
  message: Schema.String,
}) {}
