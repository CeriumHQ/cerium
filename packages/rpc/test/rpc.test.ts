import type { AgentEvent, AgentId, EventId, ThreadId } from "@cerium/protocol";
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
