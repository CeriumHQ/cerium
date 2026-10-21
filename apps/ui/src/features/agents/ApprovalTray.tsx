import { Button } from "@base-ui/react/button";
import type { QuestionResponse } from "@cerium/protocol";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { QuestionCard } from "../questions/QuestionCard.tsx";
import { PermissionCard } from "../transcript/Blocks.tsx";
import { effortLabel } from "../composer/models.ts";
import { ApprovalActions, ApprovalText, approvalShell, RequestHeadline } from "./ApprovalParts.tsx";
import { allowsSession, explainRequest } from "./explain.ts";
import {
  accessLabel,
  requestQueue,
  type AgentSummary,
  type PendingApproval,
  type PendingQuestion,
  type QueuedRequest,
  type SpawnRequest,
} from "./model.ts";

export type AnswerApproval = (
  agentId: string,
  requestId: string,
  decision: "allow" | "deny",
  scope: "once" | "session",
) => void;

export type AnswerSpawn = (requestId: string, decision: "allow" | "deny") => void;

/** Resolves to false when the answer didn't reach the agent. */
export type AnswerQuestion = (
  agentId: string,
  requestId: string,
  response: QuestionResponse,
) => Promise<boolean>;

/** Where a request stands among those waiting, shown when more than one does. */
interface Position {
  readonly index: number;
  readonly total: number;
}

/** Who is asking; the position among the requests waiting sits at the end. */
function Asking({ agent, position }: { agent?: AgentSummary | undefined; position?: Position | undefined }) {
  const counted = position !== undefined && position.total > 1;
  if (agent === undefined && !counted) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-tertiary max-md:text-[13px]">
      {agent ? (
        <>
          <ProviderLogo provider={agent.provider} size={12} className="text-fg-primary" />
          <span className="font-medium text-fg-primary">
            {agent.parentId === undefined ? "Lead" : agent.role}
          </span>
          <span className="truncate">{agent.model}</span>
        </>
      ) : null}
      {counted ? (
        <span className="ml-auto shrink-0 tabular-nums">
          {position.index} of {position.total}
        </span>
      ) : null}
    </div>
  );
}

/** A permission request of an agent, as the transcript shows the lead's own. */
function PermissionRequest({
  agent,
  request,
  named,
  keys,
  position,
  onAnswer,
}: {
  agent: AgentSummary;
  request: PendingApproval;
  named: boolean;
  keys: boolean;
  position?: Position | undefined;
  onAnswer: AnswerApproval;
}) {
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
      keys={keys}
      from={<Asking agent={named ? agent : undefined} position={position} />}
      onAnswer={(decision, scope) => onAnswer(agent.id, request.requestId, decision, scope)}
    />
  );
}

/**
 * The lead's request to start an agent outside the catalog, with what the agent would run with and
 * be told: the lead is waiting on the answer, and the agent doesn't exist until it comes.
 */
export function SpawnRequestCard({
  lead,
  request,
  named = true,
  keys = false,
  position,
  onAnswer,
}: {
  lead: AgentSummary;
  request: SpawnRequest;
  named?: boolean;
  keys?: boolean;
  position?: Position | undefined;
  onAnswer: AnswerSpawn;
}) {
  const { role, provider, model, effort, access, prompt } = request;
  return (
    <div className={approvalShell}>
      <Asking agent={named ? lead : undefined} position={position} />
      <RequestHeadline headline={`Start a new agent: ${role}`} />
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-tertiary max-md:text-[13px]">
        <ProviderLogo provider={provider} size={13} className="shrink-0 text-fg-primary" />
        <span className="truncate">
          <span className="font-medium text-fg-primary">{model}</span>
          {effort ? ` · ${effortLabel[effort]}` : ""}
          {access ? ` · ${accessLabel[access]}` : ""}
        </span>
      </div>
      {prompt ? (
        <Disclosure summary="Prompt" hint={prompt.replace(/\s+/g, " ")}>
          <ApprovalText>{prompt}</ApprovalText>
        </Disclosure>
      ) : null}
      <ApprovalActions
        session={false}
        keys={keys}
        onAnswer={(decision) => onAnswer(request.requestId, decision)}
      />
    </div>
  );
}

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
  return (
    <PermissionRequest
      agent={agent}
      request={request}
      named={named}
      keys={false}
      position={{ index: 1, total: agent.approvals.length }}
      onAnswer={onAnswer}
    />
  );
}

/** An agent's questions, with who is asking. */
function QuestionRequest({
  agent,
  request,
  named,
  position,
  onAnswer,
}: {
  agent: AgentSummary;
  request: PendingQuestion;
  named: boolean;
  position?: Position | undefined;
  onAnswer: AnswerQuestion;
}) {
  return (
    <QuestionCard
      key={request.requestId}
      questions={request.questions}
      from={<Asking agent={named ? agent : undefined} position={position} />}
      onAnswer={(response) => onAnswer(agent.id, request.requestId, response)}
    />
  );
}

/** The oldest questions an agent waits on the user to answer. Renders nothing while it has none. */
export function AgentQuestion({ agent, onAnswer }: { agent: AgentSummary; onAnswer: AnswerQuestion }) {
  const [request] = agent.questions;
  if (request === undefined) return null;
  return (
    <QuestionRequest
      agent={agent}
      request={request}
      named={false}
      position={{ index: 1, total: agent.questions.length }}
      onAnswer={onAnswer}
    />
  );
}

/** The lead's oldest request to start an agent. Renders nothing while it has none. */
export function LeadSpawnRequest({ lead, onAnswer }: { lead: AgentSummary; onAnswer: AnswerSpawn }) {
  const [request] = lead.spawns;
  if (request === undefined) return null;
  return (
    <SpawnRequestCard
      lead={lead}
      request={request}
      named={false}
      position={{ index: 1, total: lead.spawns.length }}
      onAnswer={onAnswer}
    />
  );
}

/** What a queued request asks for, in a few words. */
const askedOf = (item: QueuedRequest) =>
  item.kind === "permission"
    ? item.request.summary
    : item.kind === "question"
      ? (item.request.questions[0]?.question ?? "A question")
      : `Start ${item.request.role} on ${item.request.model}`;

const whoOf = (item: QueuedRequest) => (item.agent.parentId === undefined ? "Lead" : item.agent.role);

/**
 * A chord answers the request at the front only once it has been in front for this long, so one
 * pressed as the queue moves on can't answer the next request unseen.
 */
const SETTLE_MS = 400;

const chords: Record<string, readonly ["allow" | "deny", "once" | "session"]> = {
  y: ["allow", "once"],
  s: ["allow", "session"],
  n: ["deny", "once"],
};

/**
 * The chord a key press makes: the letter on the key, as the buttons name it, whatever the layout.
 * Where Alt types a character of its own (Option on a Mac), the key's place stands in for its letter,
 * except in a text field, which gets the character.
 */
const chordOf = (event: KeyboardEvent) => {
  const letter = event.key.toLowerCase();
  if (/^[a-z]$/u.test(letter)) return chords[letter];
  const editing =
    event.target instanceof HTMLElement &&
    (event.target.isContentEditable || event.target.matches("input, textarea"));
  return editing ? undefined : chords[event.code.replace(/^Key/u, "").toLowerCase()];
};

/**
 * Requests waiting on the user, held above the message box: they arrive while the lead's own
 * conversation is elsewhere, and the agent waits until someone answers. The oldest is open in full,
 * with chords that answer it; the rest are a line each, and one picked comes to the front.
 */
export function ApprovalTray({
  agents,
  onAnswer,
  onAnswerSpawn,
  onAnswerQuestion,
}: {
  agents: ReadonlyArray<AgentSummary>;
  onAnswer: AnswerApproval;
  onAnswerSpawn: AnswerSpawn;
  onAnswerQuestion: AnswerQuestion;
}) {
  const queue = requestQueue(agents);
  const [picked, setPicked] = useState<string>();
  const front = queue.find((item) => item.key === picked) ?? queue[0];
  const others = queue.filter((item) => item !== front);

  const answer = (item: QueuedRequest, decision: "allow" | "deny", scope: "once" | "session") => {
    if (item.kind === "permission") onAnswer(item.agent.id, item.request.requestId, decision, scope);
    else if (item.kind === "spawn") onAnswerSpawn(item.request.requestId, decision);
  };

  const tray = useRef<HTMLElement>(null);
  const frontSince = useRef(0);
  useEffect(() => {
    frontSince.current = performance.now();
  }, [front?.key]);
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    // A question is answered by what the user picks and writes, not by a chord.
    if (front === undefined || front.kind === "question" || event.repeat) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const chord = chordOf(event);
    if (chord === undefined) return;
    // Only where the card offers it: never to start an agent, nor for what can't be undone.
    if (
      chord[1] === "session" &&
      (front.kind === "spawn" || !allowsSession(explainRequest(front.request).risk))
    )
      return;
    // Only a request in view is answered: settings or another pane may cover the tray.
    if (tray.current === null || tray.current.closest("[inert]") !== null) return;
    // A dialog over the window has the keys.
    if (event.target instanceof Element && event.target.closest('[role="alertdialog"], [role="dialog"]'))
      return;
    if (event.timeStamp - frontSince.current < SETTLE_MS) return;
    event.preventDefault();
    answer(front, ...chord);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  if (front === undefined) return null;
  const position = { index: queue.indexOf(front) + 1, total: queue.length };
  return (
    <section
      ref={tray}
      aria-label="Waiting for you"
      className="pointer-events-auto mx-auto flex max-h-[60vh] max-w-[46.2rem] flex-col gap-1.5 overflow-y-auto pb-2"
    >
      <output className="sr-only">
        {whoOf(front)} asks: {askedOf(front)}
      </output>
      {front.kind === "permission" ? (
        <PermissionRequest
          agent={front.agent}
          request={front.request}
          named
          keys
          position={position}
          onAnswer={onAnswer}
        />
      ) : front.kind === "question" ? (
        <QuestionRequest
          agent={front.agent}
          request={front.request}
          named
          position={position}
          onAnswer={onAnswerQuestion}
        />
      ) : (
        <SpawnRequestCard
          lead={front.agent}
          request={front.request}
          keys
          position={position}
          onAnswer={onAnswerSpawn}
        />
      )}
      {others.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line-subtle rounded-lg border border-line-subtle bg-surface-raised">
          {others.map((item) => (
            <li key={item.key}>
              <Button
                onClick={() => setPicked(item.key)}
                aria-label={`Answer ${whoOf(item)}'s request next: ${askedOf(item)}`}
                className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12.5px] transition-colors hover:bg-surface-hover max-md:h-11 max-md:text-[13px]"
              >
                <ProviderLogo provider={item.agent.provider} size={12} className="shrink-0 text-fg-primary" />
                <span className="shrink-0 font-medium text-fg-primary">{whoOf(item)}</span>
                <span className="min-w-0 flex-1 truncate text-fg-tertiary">{askedOf(item)}</span>
                <span className="shrink-0 text-2xs text-fg-tertiary">Review</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
