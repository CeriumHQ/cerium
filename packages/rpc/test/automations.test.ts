import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { AutomationInput, nextSlot, previousSlot } from "../src/index.ts";

// Local times, so the tests hold in any time zone. 2026-10-26 is a Monday.
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();

describe("previousSlot and nextSlot", () => {
  it("come round every hour at the minute past", () => {
    const schedule = { _tag: "Hourly", minute: 15 } as const;
    assert.strictEqual(previousSlot(schedule, at(26, 10, 20)), at(26, 10, 15));
    assert.strictEqual(previousSlot(schedule, at(26, 10, 15)), at(26, 10, 15));
    assert.strictEqual(previousSlot(schedule, at(26, 10, 5)), at(26, 9, 15));
    assert.strictEqual(nextSlot(schedule, at(26, 10, 5)), at(26, 10, 15));
    assert.strictEqual(nextSlot(schedule, at(26, 10, 15)), at(26, 11, 15));
  });

  it("come round daily at the time, across midnight", () => {
    const schedule = { _tag: "Daily", at: 9 * 60 } as const;
    assert.strictEqual(previousSlot(schedule, at(26, 8)), at(25, 9));
    assert.strictEqual(previousSlot(schedule, at(26, 9)), at(26, 9));
    assert.strictEqual(nextSlot(schedule, at(26, 9)), at(27, 9));
    assert.strictEqual(nextSlot(schedule, at(26, 8, 59)), at(26, 9));
  });

  it("skip the weekend on weekdays", () => {
    const schedule = { _tag: "Weekdays", at: 9 * 60 + 30 } as const;
    // Monday morning before the time goes back to Friday.
    assert.strictEqual(previousSlot(schedule, at(26, 8)), at(23, 9, 30));
    // Friday after the time goes on to Monday, November 2.
    assert.strictEqual(nextSlot(schedule, at(30, 10)), new Date(2026, 10, 2, 9, 30).getTime());
    // Saturday and Sunday.
    assert.strictEqual(previousSlot(schedule, at(25, 12)), at(23, 9, 30));
    assert.strictEqual(nextSlot(schedule, at(24, 12)), at(26, 9, 30));
  });
});

describe("AutomationInput", () => {
  const input = {
    name: "Morning triage",
    prompt: "Look at the open issues.",
    project: "C:/code/app",
    worktree: true,
    lead: { provider: "claude", model: "opus", access: "auto" },
    when: { _tag: "Weekdays", at: 540 },
  };

  it("reads a schedule and a trigger", () => {
    const decode = Schema.decodeUnknownSync(AutomationInput);
    assert.deepStrictEqual(decode(input).when, { _tag: "Weekdays", at: 540 });
    assert.deepStrictEqual(decode({ ...input, when: { _tag: "CiFailed" } }).when, { _tag: "CiFailed" });
  });

  it("refuses an empty name and a time past the day's end", () => {
    const decode = Schema.decodeUnknownOption(AutomationInput);
    assert.isTrue(decode({ ...input, name: "" })._tag === "None");
    assert.isTrue(decode({ ...input, when: { _tag: "Daily", at: 1440 } })._tag === "None");
  });
});
