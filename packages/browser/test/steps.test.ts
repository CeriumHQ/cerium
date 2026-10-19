import { assert, describe, it } from "@effect/vitest";

import { parseStep, parseTarget } from "../src/steps.ts";

describe("command-line steps", () => {
  it("read targets as text, selectors or points, with an index", () => {
    assert.deepStrictEqual(parseTarget("Send"), { text: "Send" });
    assert.deepStrictEqual(parseTarget("Send[1]"), { text: "Send", nth: 1 });
    assert.deepStrictEqual(parseTarget("css:#go"), { selector: "#go" });
    assert.deepStrictEqual(parseTarget("@120,48"), { x: 120, y: 48 });
  });

  it("read actions, their targets and their values", () => {
    assert.deepStrictEqual(parseStep("click=New thread"), [
      { action: "click", target: { text: "New thread" } },
    ]);
    assert.deepStrictEqual(parseStep("wait@Saved=10000"), [
      { action: "wait", target: { text: "Saved" }, ms: 10_000 },
    ]);
    assert.deepStrictEqual(parseStep("type=a=b"), [{ action: "type", target: undefined, value: "a=b" }]);
    assert.deepStrictEqual(parseStep("fill@css:#box=hi"), [
      { action: "fill", target: { selector: "#box" }, value: "hi" },
    ]);
    assert.deepStrictEqual(parseStep("drag@Card=Done"), [
      { action: "drag", target: { text: "Card" }, to: { text: "Done" } },
    ]);
    assert.deepStrictEqual(parseStep("reload"), [{ action: "reload", target: undefined, value: undefined }]);
    assert.throws(() => parseStep("tap=Send"), 'Unknown step "tap=Send"');
    assert.throws(() => parseStep("click"), "click needs a target");
  });

  it("read JSON steps in the shape the bus took", () => {
    const [step] = parseStep('{"action":"type","selector":"#box","input":"hi","clear":true}');
    assert.strictEqual(step?.action, "fill");
    assert.strictEqual(step?.target?.selector, "#box");
    assert.strictEqual(step?.value, "hi");
    assert.lengthOf(parseStep('[{"action":"reload"},{"action":"back"}]'), 2);
  });
});
