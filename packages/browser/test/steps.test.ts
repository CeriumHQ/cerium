import { assert, describe, it } from "@effect/vitest";

import { parseStep } from "../src/steps.ts";

describe("command-line steps", () => {
  it("read actions, their targets and their values", () => {
    assert.deepStrictEqual(parseStep("click=Send[1]"), [
      { action: "click", target: { text: "Send", nth: 1 } },
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
    assert.deepStrictEqual(parseStep("down=Card"), [{ action: "down", target: { text: "Card" } }]);
    assert.deepStrictEqual(parseStep("move=@600,400"), [{ action: "move", target: { x: 600, y: 400 } }]);
    assert.deepStrictEqual(parseStep("up"), [{ action: "up", target: undefined, value: undefined }]);
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
