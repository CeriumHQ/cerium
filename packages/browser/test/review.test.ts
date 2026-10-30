import { assert, describe, it } from "@effect/vitest";
import { ReviewLedger } from "../src/review.ts";

describe("visual review checkpoints", () => {
  it("does not resend an identical image or spend another review round", () => {
    const ledger = new ReviewLedger();
    assert.isTrue(ledger.record("menu/open", "pixels-a", "capture-1").changed);
    assert.deepStrictEqual(ledger.record("menu/open", "pixels-a", "capture-2"), {
      changed: false,
      capture: "capture-1",
      rounds: 1,
    });
    assert.isUndefined(ledger.check("menu/open", {}));
  });

  it("requires an unresolved defect and fix after two changed captures", () => {
    const ledger = new ReviewLedger();
    ledger.record("menu/open", "a", "1");
    ledger.record("menu/open", "b", "2");
    assert.include(ledger.check("menu/open", {})!, "Two visual reviews");
    assert.isDefined(ledger.check("menu/open", { defect: "clipped" }));
    const review = { defect: "menu clips at the right edge", fix: "constrain its width" };
    assert.isUndefined(ledger.check("menu/open", review));
    ledger.record("menu/open", "c", "3", review);
    assert.include(ledger.check("menu/open", review)!, "already reviewed");
    assert.isUndefined(ledger.check("menu/closed", {}), "distinct states get their own checkpoints");
  });

  it("persists checkpoints for CLI calls without sharing them with another session", () => {
    const first = new ReviewLedger();
    first.record("button", "a", "1");
    first.record("button", "b", "2");
    const resumed = new ReviewLedger(JSON.parse(JSON.stringify(first.state)));
    assert.isDefined(resumed.check("button", {}));
    assert.isUndefined(new ReviewLedger().check("button", {}));
  });
});
