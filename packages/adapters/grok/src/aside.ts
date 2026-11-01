import {
  AcpRequestError,
  METHOD_NOT_FOUND,
  metaAt,
  type AcpConnection,
  type LiveSessions,
} from "@cerium/adapter-acp";
import { HarnessFailure, type SideQuestionRequest } from "@cerium/harness";
import type { SkillInfo } from "@cerium/protocol";
import { Deferred, Duration, Effect, Option, Schema } from "effect";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "grok", message, cause });

/**
 * A side question, asked of the running session through Grok's own `/btw` (`x.ai/btw`): it answers
 * from the conversation so far, even mid-turn, and the session goes on as if it hadn't been asked.
 * Only a session this adapter runs can be asked; another falls back to a one-off completion.
 */
export const askAside = (live: LiveSessions, request: SideQuestionRequest) =>
  Effect.gen(function* () {
    const connection = live.get(request.sessionId);
    if (connection === undefined) {
      return yield* failure("The Grok session isn't running here")(request.sessionId);
    }
    const answer = yield* connection
      .request("_x.ai/btw", {
        sessionId: request.sessionId,
        question: `${request.instructions}\n\n${request.prompt}`,
      })
      .pipe(Effect.mapError(failure("Grok could not answer the side question")));
    const text = metaAt(answer, "result", "answer") ?? metaAt(answer, "answer");
    if (typeof text !== "string") return yield* failure("Grok's side answer was unreadable")(answer);
    return text;
  });

const Command = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  _meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
const decodeCommands = Schema.decodeUnknownOption(
  Schema.Struct({
    update: Schema.Struct({
      sessionUpdate: Schema.Literal("available_commands_update"),
      availableCommands: Schema.Array(Command),
    }),
  }),
);

/** Grok's slash commands that are skills: the ones with a definition file. */
export const skillsOf = (commands: ReadonlyArray<typeof Command.Type>): ReadonlyArray<SkillInfo> =>
  commands.flatMap((command): ReadonlyArray<SkillInfo> => {
    const path = command._meta?.["path"];
    if (typeof path !== "string" || path === "" || command.name === "") return [];
    const description = command.description?.trim();
    return [{ name: command.name, ...(description ? { description } : {}), path }];
  });

/** How long a new session takes to list its commands, at most. */
const LISTED_WITHIN = Duration.seconds(20);
/** Grok lists its commands in a few updates as they load; the list is whole once they stop. */
const SETTLED_AFTER = Duration.millis(750);

/**
 * The skills Grok would offer a session in `cwd`: a scratch session lists them as its slash commands,
 * then is deleted, so nothing of it stays in the user's history.
 */
export const listGrokSkills = (connection: AcpConnection, cwd: string) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    let latest: ReadonlyArray<SkillInfo> = [];
    let updates = 0;
    const created = yield* connection
      .request("session/new", { cwd, mcpServers: [], _meta: { yoloMode: false } })
      .pipe(Effect.mapError(failure("Grok could not open a session to list its skills")));
    const sessionId = metaAt(created, "sessionId");
    if (typeof sessionId !== "string") return yield* failure("Grok opened a session without an id")(created);
    const forget = Effect.gen(function* () {
      yield* connection.request("_x.ai/session/delete", { sessionId }).pipe(Effect.ignore);
      yield* connection.request("session/close", { sessionId }).pipe(Effect.ignore);
    });
    const settled: Effect.Effect<ReadonlyArray<SkillInfo>> = Effect.suspend(() => {
      const seen = updates;
      return Effect.sleep(SETTLED_AFTER).pipe(
        Effect.andThen(Effect.suspend(() => (updates === seen ? Effect.succeed(latest) : settled))),
      );
    });
    return yield* Effect.gen(function* () {
      yield* connection.attach(sessionId, {
        notification: (method, params) =>
          Option.match(method === "session/update" ? decodeCommands(params) : Option.none(), {
            onNone: () => Effect.void,
            onSome: ({ update }) =>
              Effect.suspend(() => {
                latest = skillsOf(update.availableCommands);
                updates++;
                return Deferred.succeed(first, undefined);
              }),
          }),
        request: (method) =>
          Effect.fail(
            new AcpRequestError({ method, code: METHOD_NOT_FOUND, message: "Nothing to ask here" }),
          ),
      });
      return yield* Deferred.await(first).pipe(
        Effect.andThen(settled),
        Effect.timeoutOrElse({ duration: LISTED_WITHIN, orElse: () => Effect.succeed(latest) }),
      );
    }).pipe(Effect.scoped, Effect.ensuring(forget));
  });
