import { randomUUID } from "node:crypto";
import type { CompletionUsage } from "@cerium/harness";
import type { AgentId, ProviderId } from "@cerium/protocol";
import { Context, Effect, Layer, Queue, Stream } from "effect";

export interface HelperReading {
  readonly agentId: AgentId;
  readonly provider: ProviderId;
  readonly model: string;
  readonly purpose: "title" | "summary" | "sideQuestion";
  readonly callId: string;
  readonly usage?: CompletionUsage;
}

/** SDK callbacks enqueue readings; the orchestrator owns persistence and publication. */
export class HelperUsage extends Context.Service<
  HelperUsage,
  {
    readonly events: Stream.Stream<HelperReading>;
    track(context: Omit<HelperReading, "usage" | "callId">): (usage: CompletionUsage) => void;
  }
>()("cerium/orchestrator/HelperUsage") {
  static readonly layer = Layer.effect(
    HelperUsage,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<HelperReading>();
      return HelperUsage.of({
        events: Stream.fromQueue(queue),
        track: (context) => {
          const callId = randomUUID();
          Queue.offerUnsafe(queue, { ...context, callId });
          return (usage) => {
            Queue.offerUnsafe(queue, { ...context, callId, usage });
          };
        },
      });
    }),
  );
}
