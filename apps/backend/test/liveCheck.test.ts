import { makeFakeAdapter } from "@cerium/harness/testing";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { checkHarness, renderResults, runLiveChecks } from "../scripts/live/check.ts";

describe("live checks", () => {
  it.live("pass when the turn finishes as expected, and report what the harness did", () =>
    Effect.gen(function* () {
      const fake = makeFakeAdapter("claude");
      const result = yield* checkHarness(fake.adapter, { prompt: "hi", expectReply: "reply to: hi" });
      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.model, "fake-model");
      assert.strictEqual(result.access, "auto");
      assert.strictEqual(result.reply, "reply to: hi");
      assert.deepStrictEqual(result.problems, []);
    }),
  );

  it.live("fail the default probe when its files are missing", () =>
    Effect.gen(function* () {
      const result = yield* checkHarness(makeFakeAdapter("codex").adapter, {});
      assert.strictEqual(result.status, "failed");
      assert.include(result.problems.join(" "), "Missing shell.txt, edit.txt.");
    }),
  );

  it.live("answer and record approval requests, failing past the allowed number", () =>
    Effect.gen(function* () {
      const fake = makeFakeAdapter("muse", { askPermission: true });
      const result = yield* checkHarness(fake.adapter, { prompt: "test", access: "ask", maxApprovals: 0 });
      assert.deepStrictEqual(result.approvals, [{ tool: "Bash", summary: "Run tests", answer: "deny" }]);
      assert.strictEqual(result.status, "failed");
      assert.include(result.problems.join(" "), "Asked for approval 1 times (allowed 0).");
    }),
  );

  it.live("stop at the deadline when the turn never finishes", () =>
    Effect.gen(function* () {
      const fake = makeFakeAdapter("cursor", { turnDuration: "1 minute" });
      const started = Date.now();
      const result = yield* checkHarness(fake.adapter, { prompt: "slow", timeoutSeconds: 1 });
      // Well short of the turn's minute, however busy the machine.
      assert.isBelow(Date.now() - started, 30_000);
      assert.strictEqual(result.status, "timedOut");
      assert.include(renderResults([result]), "TIMEOUT cursor (fake-model, auto)");
    }),
  );

  it.live("check only the harnesses asked for, side by side", () =>
    Effect.gen(function* () {
      const claude = makeFakeAdapter("claude");
      const codex = makeFakeAdapter("codex");
      const adapters = new Map([
        ["claude" as const, claude.adapter],
        ["codex" as const, codex.adapter],
      ]);
      const results = yield* runLiveChecks(adapters, { providers: ["codex", "muse"], prompt: "hi" });
      assert.deepStrictEqual(
        results.map((result) => result.provider),
        ["codex"],
      );
      assert.strictEqual(claude.sessions.length, 0);
    }),
  );
});
