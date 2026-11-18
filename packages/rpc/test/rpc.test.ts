import {
  LiveEventDelivery,
  LiveUiEvent,
  type AgentEvent,
  type AgentId,
  type EventId,
  type ThreadId,
} from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { UiEvent } from "../src/index.ts";

describe("UiEvent", () => {
  it("leaves out the provider's original message, even when it isn't strict JSON", () => {
    const event: AgentEvent = {
      id: "agt_1:0" as EventId,
      threadId: "thr_1" as ThreadId,
      agentId: "agt_1" as AgentId,
      sequence: 0,
      at: 1,
      payload: { _tag: "AgentStateChanged", state: "running" },
      raw: { toolName: "Edit", suggestions: undefined },
    };
    const encoded = Schema.encodeUnknownSync(Schema.toCodecJson(UiEvent))(event);
    assert.notProperty(encoded, "raw");
    assert.deepStrictEqual((encoded as { payload: unknown }).payload, event.payload);
  });
});

describe("live deliveries", () => {
  const delta = {
    id: "agt_1:0" as EventId,
    threadId: "thr_1" as ThreadId,
    agentId: "agt_1" as AgentId,
    sequence: 0,
    at: 1,
    payload: { _tag: "MessageDelta", messageId: "m", text: "Hello", offset: 0 },
  } as const satisfies AgentEvent;

  it("keeps the legacy event shape and skips unknown events in the new envelope", () => {
    const legacy = Schema.toCodecJson(LiveUiEvent);
    const delivery = Schema.toCodecJson(LiveEventDelivery);
    const wire = Schema.encodeSync(legacy)(delta);
    const subscribed = { _tag: "Subscribed" } as const;
    assert.deepStrictEqual(wire, delta);
    assert.deepStrictEqual(Schema.decodeSync(legacy)(wire), delta);
    assert.deepStrictEqual(Schema.encodeSync(delivery)(subscribed), subscribed);
    assert.deepStrictEqual(Schema.decodeSync(delivery)({ _tag: "Event", event: wire }), {
      _tag: "Event",
      event: delta,
    });
    assert.deepStrictEqual(
      Schema.decodeSync(delivery)({
        _tag: "Event",
        event: { ...delta, payload: { _tag: "NewEvent" } },
      }),
      { _tag: "Event", event: undefined },
    );
  });
});
