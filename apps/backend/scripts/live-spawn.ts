// Live end-to-end check of cross-agent orchestration: a real Claude lead uses Cerium's MCP bus to
// spawn a real Claude child, receives the child's result as its next turn, and answers the user.
// Uses your logged-in Claude account (three short Haiku turns).
//
// Usage: node apps/backend/scripts/live-spawn.ts

import { Orchestrator } from "@cerium/orchestrator";
import type { AgentEvent } from "@cerium/protocol";
import { NodeRuntime } from "@effect/platform-node";
import { Console, Duration, Effect, Stream } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backendLayer } from "../src/index.ts";

const dataDirectory = mkdtempSync(join(tmpdir(), "cerium-live-"));

const describe = (event: AgentEvent) => {
  const who = event.agentId.slice(-6);
  const { payload } = event;
  switch (payload._tag) {
    case "MessageDelta":
    case "ReasoningDelta":
      return undefined;
    case "MessageCompleted":
      return `${who} said: ${payload.text}`;
    case "ToolCallStarted":
      return `${who} called ${payload.toolName} ${JSON.stringify(payload.input)}`;
    case "TurnInput":
      return `${who} turn input: ${JSON.stringify(payload.items)}`;
    case "AgentSpawned":
      return `${who} spawned ${payload.childId.slice(-6)} (${payload.role}, ${payload.model}, ${payload.access})`;
    case "AgentStateChanged":
      return `${who} is ${payload.state}`;
    default:
      return `${who} ${payload._tag}`;
  }
};

const program = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  const leadTurns = { completed: 0 };
  let leadId = "";

  yield* orchestrator.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const line = describe(event);
        if (line !== undefined) yield* Console.log(line);
        if (event.agentId === leadId && event.payload._tag === "TurnCompleted") leadTurns.completed++;
      }),
    ),
    Effect.forkScoped,
  );
  yield* Effect.sleep(Duration.millis(10));

  const { lead } = yield* orchestrator.createThread({
    title: "Live spawn check",
    mode: "work",
    cwd: dataDirectory,
    lead: { provider: "claude", model: "haiku", access: "ask" },
  });
  leadId = lead.id;

  yield* orchestrator.sendUserMessage(
    lead.id,
    "Use the cerium spawn_agent tool to spawn one child with model 'haiku' and role 'geographer'," +
      " asking it: 'What is the capital of France? Answer in one word.' Then end your turn." +
      " When the child's answer arrives, reply to me with just that answer.",
  );

  for (let waited = 0; leadTurns.completed < 2 && waited < 180; waited++) {
    yield* Effect.sleep(Duration.seconds(1));
  }
  yield* Console.log(
    leadTurns.completed >= 2 ? "\nLIVE SPAWN CHECK PASSED" : "\nTimed out waiting for the lead",
  );
}).pipe(
  Effect.scoped,
  Effect.provide(
    backendLayer({
      dataDirectory,
      token: "live-spawn",
    }),
  ),
);

NodeRuntime.runMain(program);
