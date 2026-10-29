import type { AgentEvent, ProviderId } from "@cerium/protocol";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { OrchestratorError } from "./errors.ts";
import { entryOf, exchanges, splitConversation } from "./handoff.ts";
import { Adapters, OrchestratorConfig } from "./services.ts";

// A side question: a quick question about a thread, answered with the thread's conversation in view
// and then forgotten. Nothing reaches the thread's events or its running turn. A harness that can
// copy a session answers in a throwaway copy of the lead's own, which has seen everything the lead
// has and can look at the project; any other, or one whose copy fails (a session it can't copy
// before its first turn ends, say), answers a one-off completion told the conversation as text.

/** What a side question's answer is told: it answers, it isn't the agent, and it changes nothing. */
export const SIDE_INSTRUCTIONS =
  "The user asks a side question about this conversation while its agent carries on. You are not that" +
  " agent: answer the question briefly and directly from the conversation, and from the project's files" +
  " where you can read them. Don't carry on the conversation's task, don't change anything and don't" +
  " offer to; the answer is read once and forgotten.";

/** Added while the agent is mid-turn, which a copy of its session can only see the start of. */
const WORKING_NOTE =
  " The agent is working on the user's latest request right now: a request with no answer yet is in" +
  " progress, not skipped, and what it has done since is not in what you can see.";

/** What a side question is told: it answers, and when the agent is still at work, that it is. */
export const sideInstructions = (working: boolean) =>
  working ? SIDE_INSTRUCTIONS + WORKING_NOTE : SIDE_INSTRUCTIONS;

/** Said beside the question too, where it weighs more than the instructions. */
const WORKING_LINE =
  "The agent is still working on the user's latest request, whose answer isn't in what you see yet.";

/** How much of the conversation a side question is told word for word, in characters (about 6k tokens). */
const CONVERSATION_BUDGET = 24_000;
/** The most earlier side questions a follow-up carries, and the most of each answer. */
const MAX_EARLIER = 6;
const EARLIER_ANSWER = 3_000;
/** How long a copy of the session, which may read files, may take before the conversation is tried. */
const FORK_TIMEOUT = "120 seconds";
const COMPLETE_TIMEOUT = "90 seconds";

/** A side question already asked in the same pop-over, which a follow-up builds on. */
export interface SideExchange {
  readonly question: string;
  readonly answer: string;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} […]`);

const earlierText = (earlier: ReadonlyArray<SideExchange>) =>
  earlier.length === 0
    ? []
    : [
        "<earlier_side_questions>",
        ...earlier
          .slice(-MAX_EARLIER)
          .map((each) => `Q: ${each.question}\nA: ${clip(each.answer, EARLIER_ANSWER)}`),
        "</earlier_side_questions>",
        "",
      ];

/** The question to a copy of the lead's session, which already holds the conversation. */
export const forkPrompt = (question: string, earlier: ReadonlyArray<SideExchange>, working = false) =>
  [
    "A side question from the user, to answer briefly without carrying on your task or changing anything.",
    ...(working ? [WORKING_LINE] : []),
    "",
    ...earlierText(earlier),
    question,
  ].join("\n");

/**
 * The question to a one-off completion: the newest turns that fit, word for word, with a note of how
 * many older ones are left out.
 */
export const conversationPrompt = (
  live: ReadonlyArray<AgentEvent>,
  question: string,
  earlier: ReadonlyArray<SideExchange>,
  working = false,
) => {
  const { older, recent } = splitConversation(exchanges(live), CONVERSATION_BUDGET);
  return [
    ...(recent.length === 0
      ? ["There is no conversation yet."]
      : [
          "The conversation so far between the user and the agent, whose messages are marked [You]:",
          "",
          "<conversation>",
          ...(older.length === 0 ? [] : [`(${older.length} earlier turns are left out.)`, ""]),
          recent.map(entryOf).join("\n\n"),
          "</conversation>",
        ]),
    ...(working ? ["", WORKING_LINE] : []),
    "",
    ...earlierText(earlier),
    "The user's side question, to answer now:",
    question,
  ].join("\n");
};

/** What a side question is asked of. */
export interface SideQuestionInput {
  readonly provider: ProviderId;
  readonly model: string;
  /** The folder the thread's agents run in. */
  readonly cwd: string;
  /** The lead's harness session, when a copy of it holds the conversation. */
  readonly sessionId: string | undefined;
  /** The lead is mid-turn. */
  readonly working: boolean;
  /** The lead's live events. */
  readonly live: ReadonlyArray<AgentEvent>;
  readonly question: string;
  readonly earlier: ReadonlyArray<SideExchange>;
}

export class SideQuestions extends Context.Service<
  SideQuestions,
  {
    /** The answer to a side question; nothing of it is kept. */
    ask(input: SideQuestionInput): Effect.Effect<string, OrchestratorError>;
  }
>()("cerium/orchestrator/SideQuestions") {
  static readonly layer = Layer.effect(
    SideQuestions,
    Effect.gen(function* () {
      const adapters = yield* Adapters;
      const config = yield* OrchestratorConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The empty folder a one-off completion runs in, so no project's instructions load.
      const empty = config.titleDirectory ?? path.join(config.chatDirectory, ".titles");

      return SideQuestions.of({
        ask: Effect.fn("SideQuestions.ask")(function* (input) {
          const adapter = adapters.get(input.provider);
          if (adapter === undefined) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${input.provider} adapter is installed.`,
            });
          }
          if (adapter.sideQuestion !== undefined && input.sessionId !== undefined) {
            const answer = yield* adapter
              .sideQuestion({
                model: input.model,
                cwd: input.cwd,
                sessionId: input.sessionId,
                instructions: sideInstructions(input.working),
                prompt: forkPrompt(input.question, input.earlier, input.working),
              })
              .pipe(
                Effect.timeout(FORK_TIMEOUT),
                Effect.map((reply) => (reply.trim() === "" ? undefined : reply.trim())),
                Effect.tapCause((cause) =>
                  Effect.logWarning(`Couldn't ask a copy of a ${input.provider} session`, cause),
                ),
                Effect.orElseSucceed(() => undefined),
              );
            if (answer !== undefined) return answer;
          }
          yield* fs.makeDirectory(empty, { recursive: true }).pipe(Effect.ignore);
          return yield* adapter
            .complete({
              model: input.model,
              instructions: sideInstructions(input.working),
              prompt: conversationPrompt(input.live, input.question, input.earlier, input.working),
              cwd: empty,
            })
            .pipe(
              Effect.timeout(COMPLETE_TIMEOUT),
              Effect.map((reply) => reply.trim()),
              Effect.filterOrFail(
                (reply) => reply !== "",
                () =>
                  new OrchestratorError({ reason: "unavailable", message: "The model's answer was empty." }),
              ),
              Effect.mapError((error) =>
                error instanceof OrchestratorError
                  ? error
                  : new OrchestratorError({
                      reason: "unavailable",
                      message: error._tag === "TimeoutError" ? "No answer came in time." : error.message,
                    }),
              ),
            );
        }),
      });
    }),
  );
}
