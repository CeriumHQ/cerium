import { assert, describe, it } from "@effect/vitest";

import {
  REMOVED_IMAGE,
  toolImageRef,
  toolOutputImages,
  withImagesRemoved,
  withoutImages,
  type AgentEvent,
  type AgentId,
  type EventId,
  type ThreadId,
} from "../src/index.ts";

const screenshot = "A".repeat(20_000);
const icon = "B".repeat(100);

const completed = (output: unknown): AgentEvent => ({
  id: "evt_1" as EventId,
  threadId: "thr:1" as ThreadId,
  agentId: "agt_1" as AgentId,
  sequence: 0,
  at: 1_760_000_000_000,
  payload: { _tag: "ToolCallCompleted", callId: "toolu_1", output, isError: false },
});

const outputOf = (event: AgentEvent) =>
  event.payload._tag === "ToolCallCompleted" ? event.payload.output : undefined;

describe("withoutImages", () => {
  it("leaves big images out as references to their call, and keeps small ones and the text", () => {
    const output = [
      { type: "text", text: "Took a screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
      { type: "image", data: icon, mimeType: "image/png" },
    ];
    const lean = outputOf(withoutImages(completed(output)));
    const images = toolOutputImages(lean);
    assert.strictEqual(images.length, 2);
    assert.deepStrictEqual(toolImageRef(images[0]?.data ?? ""), {
      threadId: "thr:1" as ThreadId,
      callId: "toolu_1",
      index: 0,
    });
    assert.deepStrictEqual(images[1], { mediaType: "image/png", data: icon });
    assert.deepStrictEqual((lean as Array<unknown>)[0], output[0]);
    // The stored event is untouched.
    assert.strictEqual(output[1]?.source?.data, screenshot);
  });

  it("finds images nested in MCP results, at the index the full output has them", () => {
    const output = {
      content: [
        { type: "image", data: icon, mimeType: "image/png" },
        { type: "image", data: screenshot, mimeType: "image/jpeg" },
      ],
    };
    const [, second] = toolOutputImages(outputOf(withoutImages(completed(output))));
    assert.strictEqual(toolImageRef(second?.data ?? "")?.index, 1);
    assert.strictEqual(toolOutputImages(output)[1]?.data, screenshot);
  });

  it("reads no reference from ordinary image data", () => {
    assert.strictEqual(toolImageRef(screenshot), undefined);
    assert.strictEqual(toolImageRef("cerium-image:not json"), undefined);
    assert.strictEqual(toolImageRef(REMOVED_IMAGE), undefined);
  });
});

describe("withImagesRemoved", () => {
  it("removes every image, big and small, keeping the text and where each image was", () => {
    const output = {
      content: [
        { type: "text", text: "Took a screenshot" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } },
        { type: "image", data: icon, mimeType: "image/png" },
      ],
    };
    const slim = withImagesRemoved(output);
    assert.deepStrictEqual(
      toolOutputImages(slim).map((image) => image.data),
      [REMOVED_IMAGE, REMOVED_IMAGE],
    );
    assert.deepStrictEqual((slim as typeof output).content[0], output.content[0]);
    // A compact history keeps the marker as it is: there's nothing left to fetch.
    assert.deepStrictEqual(outputOf(withoutImages(completed(slim))), slim);
  });
});
