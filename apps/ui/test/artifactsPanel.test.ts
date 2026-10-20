import { describe, expect, it } from "@effect/vitest";

import { artifactId } from "@cerium/artifacts";
import type { AgentEvent, AgentId, EventId, ThreadId } from "@cerium/protocol";

import { projectArtifacts, threadArtifacts } from "../src/features/artifacts/model.ts";

const message = (agentId: string, at: number, text: string): AgentEvent => ({
  id: `evt_${at}` as EventId,
  threadId: "thr_1" as ThreadId,
  agentId: agentId as AgentId,
  sequence: at,
  at,
  payload: { _tag: "MessageCompleted", messageId: `msg_${at}`, text },
});

const page = (title: string) => `\`\`\`artifact\n<title>${title}</title>\n<p>${title}</p>\n\`\`\``;

describe("threadArtifacts", () => {
  it("lists the agent's own artifacts newest first, each page once", () => {
    const events = [
      message("agt_lead", 1, `Before.\n${page("Plan")}`),
      message("agt_child", 2, page("Child's")),
      message("agt_lead", 3, `${page("Plan")}\n\nAnd:\n${page("Results")}`),
      message("agt_lead", 4, "No visuals."),
    ];
    const listed = threadArtifacts(events, "agt_lead");
    expect(listed.map(({ title, at }) => [title, at])).toEqual([
      ["Results", 3],
      ["Plan", 3],
    ]);
    expect(listed[0]!.id).toBe(artifactId("<title>Results</title>\n<p>Results</p>"));
    expect(listed[0]!.threadId).toBe("thr_1");
  });
});

describe("projectArtifacts", () => {
  it("names each listed artifact as the conversation does", () => {
    const code = "<title>Bench</title><p>1</p>";
    expect(projectArtifacts([{ threadId: "thr_2" as ThreadId, messageId: "m", at: 5, code }])).toEqual([
      { id: artifactId(code), code, title: "Bench", threadId: "thr_2", at: 5 },
    ]);
  });
});
