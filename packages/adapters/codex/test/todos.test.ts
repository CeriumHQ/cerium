import { EventPayload, type TodoItem } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import type { ServerNotification } from "../src/protocol/ServerNotification.ts";
import { CodexTranslator } from "../src/translate.ts";

// SYNTHETIC: none of the models Codex 0.163.0 offers (gpt-6-luna, gpt-5.6-luna, gpt-5.6-terra) is given
// the `update_plan` tool, so no `turn/plan/updated` could be recorded. These notifications are built
// from the generated `TurnPlanUpdatedNotification` type; replace them with a recording once a model
// that plans exists.

const THREAD = "thr_1";

const planned = (
  plan: ReadonlyArray<{ readonly step: string; readonly status: "pending" | "inProgress" | "completed" }>,
  explanation: string | null = null,
): ServerNotification => ({
  method: "turn/plan/updated",
  params: { threadId: THREAD, turnId: "turn_1", explanation, plan: [...plan] },
});

const run = (...notifications: ReadonlyArray<ServerNotification>) => {
  const translator = new CodexTranslator();
  // A session that has started, so notifications of other threads can be told apart.
  translator.started({ thread: { id: THREAD }, model: "gpt-6-luna", reasoningEffort: null } as never);
  return notifications.flatMap((notification) => translator.translate(notification));
};

const lists = (payloads: ReadonlyArray<EventPayload>) =>
  payloads.flatMap((payload) => (payload._tag === "TodosUpdated" ? [payload] : []));

const compact = (items: ReadonlyArray<TodoItem>) => items.map((each) => `${each.status}:${each.text}`);

describe("CodexTranslator on turn/plan/updated", () => {
  it("reports the whole plan at every update, with the reason it changed", () => {
    const events = run(
      planned([
        { step: "Read the failing test", status: "inProgress" },
        { step: "Fix the race", status: "pending" },
      ]),
      planned(
        [
          { step: "Read the failing test", status: "completed" },
          { step: "Fix the race", status: "inProgress" },
          { step: "Add a regression test", status: "pending" },
        ],
        "The fix needs a test",
      ),
    );
    const payloads = events.map((event) => event.payload);
    for (const event of events) {
      expect(Schema.is(EventPayload)(event.payload)).toBe(true);
      expect(event.raw).toMatchObject({ method: "turn/plan/updated" });
    }
    expect(lists(payloads).map((each) => compact(each.items))).toEqual([
      ["inProgress:Read the failing test", "pending:Fix the race"],
      ["completed:Read the failing test", "inProgress:Fix the race", "pending:Add a regression test"],
    ]);
    expect(lists(payloads).map((each) => each.explanation)).toEqual([undefined, "The fix needs a test"]);
  });

  it("leaves out an update that changes nothing, but not a new reason for the same plan", () => {
    const plan = [{ step: "One", status: "pending" }] as const;
    const payloads = run(
      planned(plan),
      planned(plan),
      planned(plan, "Still the plan"),
      planned(plan, " "),
    ).map((event) => event.payload);
    expect(lists(payloads).map((each) => each.explanation)).toEqual([undefined, "Still the plan", undefined]);
  });

  it("reports a plan emptied", () => {
    const payloads = run(planned([{ step: "One", status: "pending" }]), planned([])).map(
      (event) => event.payload,
    );
    expect(lists(payloads).map((each) => compact(each.items))).toEqual([["pending:One"], []]);
  });

  it("ignores another thread's plan", () => {
    const other: ServerNotification = {
      method: "turn/plan/updated",
      params: {
        threadId: "thr_2",
        turnId: "turn_9",
        explanation: null,
        plan: [{ step: "Not ours", status: "pending" }],
      },
    };
    expect(run(other)).toEqual([]);
  });
});
