import type { CompletionUsage } from "@cerium/harness";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import type { OpenCodeClient } from "../src/host.ts";
import { askOpenCodeSideQuestion, generatedUsage } from "../src/sideQuestion.ts";

const request = (onUsage?: (usage: CompletionUsage) => void) => ({
  model: "opencode/glm",
  cwd: "/work",
  sessionId: "ses_1",
  instructions: "Answer only; change nothing.",
  prompt: "Which file did you edit?",
  ...(onUsage ? { onUsage } : {}),
});

const clientAnswering = (reply: unknown, calls: Array<unknown>) =>
  ({
    session: {
      generate: (input: unknown) => {
        calls.push(input);
        return Promise.resolve(reply);
      },
    },
  }) as unknown as OpenCodeClient;

describe("OpenCode side questions", () => {
  it("ask the session's conversation through session.generate, with Cerium's instructions", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const calls: Array<unknown> = [];
        const usage: Array<CompletionUsage> = [];
        const answer = yield* askOpenCodeSideQuestion(
          clientAnswering(
            {
              text: "src/app.ts",
              tokens: { input: 90, output: 4, reasoning: 2, cache: { read: 300, write: 10 } },
              cost: 0.002,
            },
            calls,
          ),
          request((each) => usage.push(each)),
        );
        expect(answer).toBe("src/app.ts");
        expect(calls).toEqual([
          {
            sessionID: "ses_1",
            prompt: expect.stringContaining("Answer only; change nothing."),
          },
        ]);
        expect((calls[0] as { prompt: string }).prompt).toMatch(/Which file did you edit\?$/);
        expect(usage).toEqual([
          { inputTokens: 100, outputTokens: 6, cachedInputTokens: 300, costUsd: 0.002 },
        ]);
      }),
    ));

  it("records the call unreported when the server gives text only", () => {
    expect(generatedUsage({ text: "ok" })).toEqual({ inputTokens: 0, outputTokens: 0, unreported: true });
  });

  it("fails on an empty or malformed reply", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const empty = yield* askOpenCodeSideQuestion(clientAnswering({ text: " " }, []), request()).pipe(
          Effect.flip,
        );
        expect(empty.message).toBe("OpenCode's reply was empty");
        const malformed = yield* askOpenCodeSideQuestion(clientAnswering({ nope: 1 }, []), request()).pipe(
          Effect.flip,
        );
        expect(malformed.message).toBe("Unexpected `session.generate` response");
      }),
    ));
});
