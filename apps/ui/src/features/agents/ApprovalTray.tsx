import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { PermissionCard } from "../transcript/Blocks.tsx";
import type { AgentSummary } from "./model.ts";

export type AnswerApproval = (
  agentId: string,
  requestId: string,
  decision: "allow" | "deny",
  scope: "once" | "session",
) => void;

/**
 * The oldest request an agent is waiting on, with who is asking. Answering it brings up the next one.
 * Renders nothing while the agent waits on nothing.
 */
export function AgentApproval({
  agent,
  named = true,
  onAnswer,
}: {
  agent: AgentSummary;
  /** Leave out who is asking where the agent is already named. */
  named?: boolean;
  onAnswer: AnswerApproval;
}) {
  const [request] = agent.approvals;
  if (request === undefined) return null;
  const queued = agent.approvals.length;
  return (
    <PermissionCard
      key={request.requestId}
      block={{
        kind: "permission",
        id: `permission:${request.requestId}`,
        toolName: request.toolName,
        summary: request.summary,
        input: request.input,
      }}
      expired={false}
      from={
        named ? (
          <div className="flex items-center gap-1.5 text-xs text-fg-tertiary">
            <ProviderLogo provider={agent.provider} size={12} className="text-fg-primary" />
            <span className="font-medium text-fg-primary">{agent.role}</span>
            <span className="truncate">{agent.model}</span>
            {queued > 1 ? <span className="ml-auto shrink-0 tabular-nums">1 of {queued}</span> : null}
          </div>
        ) : undefined
      }
      onAnswer={(decision, scope) => onAnswer(agent.id, request.requestId, decision, scope)}
    />
  );
}

/**
 * Requests from the lead's agents, held above the message box: they arrive while the lead's own
 * conversation is elsewhere, and the agent waits until someone answers.
 */
export function ApprovalTray({
  agents,
  onAnswer,
}: {
  agents: ReadonlyArray<AgentSummary>;
  onAnswer: AnswerApproval;
}) {
  const waiting = agents.filter((agent) => agent.parentId !== undefined && agent.approvals.length > 0);
  if (waiting.length === 0) return null;
  return (
    <section
      aria-label="Agents waiting for you"
      className="pointer-events-auto mx-auto flex max-h-[45vh] max-w-[46.2rem] flex-col gap-2 overflow-y-auto pb-2"
    >
      {waiting.map((agent) => (
        <AgentApproval key={agent.id} agent={agent} onAnswer={onAnswer} />
      ))}
    </section>
  );
}
