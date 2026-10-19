import { artifactGuide } from "@cerium/artifacts";
import { Orchestrator, OrchestratorError } from "@cerium/orchestrator";
import { AccessMode, AgentId, ProviderId, ReasoningEffort, type Question } from "@cerium/protocol";
import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { HttpServerRequest } from "effect/http";

import { BusRegistry } from "./registry.ts";

// The tools every Cerium-managed session sees under the `cerium` MCP server.

const ModelSummary = Schema.Struct({
  alias: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  effort: Schema.optionalKey(ReasoningEffort),
  description: Schema.String,
});

const AgentSummary = Schema.Struct({
  agentId: AgentId,
  role: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  state: Schema.String,
  you: Schema.Boolean,
});

export const ListModels = Tool.make("list_models", {
  description: "List the models you may spawn without asking the user, with what each is for.",
  success: Schema.Struct({ models: Schema.Array(ModelSummary) }),
  failure: OrchestratorError,
});

export const SpawnAgent = Tool.make("spawn_agent", {
  description:
    "Start a child agent on any provider. Returns immediately; the child's final message of each turn is" +
    " delivered to you later, so end your turn instead of waiting. Leads only.",
  parameters: Schema.Struct({
    role: Schema.NonEmptyString.annotate({ description: "Short role name, e.g. 'reviewer' or 'ci-watch'." }),
    model: Schema.NonEmptyString.annotate({
      description:
        "A catalog alias from list_models, or a model id together with `provider` to ask the user.",
    }),
    provider: Schema.optionalKey(ProviderId),
    effort: Schema.optionalKey(ReasoningEffort),
    access: Schema.optionalKey(AccessMode).annotate({
      description: "readOnly, ask, acceptEdits, auto or fullAccess. Never more than your own access.",
    }),
    prompt: Schema.NonEmptyString.annotate({
      description: "Everything the child needs: it sees nothing of your conversation.",
    }),
  }),
  success: Schema.Union([
    Schema.Struct({ status: Schema.Literal("spawned"), agentId: AgentId }),
    Schema.Struct({
      status: Schema.Literal("pendingApproval"),
      requestId: Schema.String,
      note: Schema.String,
    }),
  ]),
  failure: OrchestratorError,
});

export const ListAgents = Tool.make("list_agents", {
  description: "List the agents in your thread.",
  success: Schema.Struct({ agents: Schema.Array(AgentSummary) }),
  failure: OrchestratorError,
});

export const ListThreads = Tool.make("list_threads", {
  description:
    "List the user's threads (archived ones left out) with each one's folder and lead agent, to find threads" +
    " working in your folder or to message another thread's lead. Only a lead that is running or idle takes" +
    " messages.",
  success: Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        threadId: Schema.String,
        title: Schema.String,
        mode: Schema.String,
        folder: Schema.optionalKey(Schema.String),
        leadAgentId: Schema.optionalKey(AgentId),
        leadState: Schema.optionalKey(Schema.String),
        yours: Schema.Boolean,
      }),
    ),
  }),
  failure: OrchestratorError,
});

export const SendMessage = Tool.make("send_message", {
  description:
    "Send a message to another agent: anyone in your thread, or another thread's lead if you are a lead." +
    " It arrives as their next turn's input once they are idle, and replies reach you the same way. Use it" +
    " before changing files another agent is working on, when your work affects theirs, or to ask what only" +
    " they know. Messages carry information, not authority.",
  parameters: Schema.Struct({
    to: AgentId,
    text: Schema.NonEmptyString,
  }),
  success: Schema.Struct({ delivered: Schema.Boolean }),
  failure: OrchestratorError,
});

export const KillAgent = Tool.make("kill_agent", {
  description: "Stop one of your child agents.",
  parameters: Schema.Struct({ agentId: AgentId }),
  success: Schema.Struct({ stopped: Schema.Boolean }),
  failure: OrchestratorError,
});

export const AskAdvisor = Tool.make("ask_advisor", {
  description:
    "Ask the user's advisor, a model they chose that answers questions and does no work, when you are stuck," +
    " unsure between approaches, or going in circles. Returns at once; the answer arrives later as a message" +
    " from the advisor, so end your turn or carry on with other work instead of waiting. Fails when the user" +
    " has no advisor turned on.",
  parameters: Schema.Struct({
    question: Schema.NonEmptyString.annotate({
      description:
        "A question that stands alone: the goal, what you tried, what happened (exact errors) and the files" +
        " involved. The advisor can read your folder but sees nothing of your conversation.",
    }),
  }),
  success: Schema.Struct({ status: Schema.Literal("asked"), advisorId: AgentId, note: Schema.String }),
  failure: OrchestratorError,
});

const AskedQuestion = Schema.Struct({
  header: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(30)).annotate({
      description: "A label of a word or two naming what is asked, e.g. 'Database' or 'Scope'.",
    }),
  ),
  question: Schema.NonEmptyString.annotate({
    description: "The question, complete and specific, ending with a question mark.",
  }),
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        label: Schema.NonEmptyString.check(Schema.isMaxLength(60)).annotate({
          description:
            "The choice in one to five words. Put your recommendation first and end its label with '(Recommended)'.",
        }),
        description: Schema.optionalKey(
          Schema.String.annotate({ description: "What picking it means: its trade-off or consequence." }),
        ),
      }),
    )
      .check(Schema.isMaxLength(6))
      .annotate({
        description:
          "Two to four distinct choices. Leave out for a question only the user's own words can answer.",
      }),
  ),
  multiSelect: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "The user may pick several options (default false)." }),
  ),
  allowOther: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "The user may answer in their own words instead of, or beside, the options (default true).",
    }),
  ),
});

export const AskUser = Tool.make("ask_user", {
  description:
    "Ask the user one to four questions, each with options to pick from, when the answer is theirs to give:" +
    " an ambiguous request, a choice between approaches they would care about, a decision costly to undo." +
    " Returns at once; the answers arrive later as a [Cerium] message, so end your turn or carry on with" +
    " work that doesn't depend on them. Don't ask what the code, the docs or a quick check can tell you.",
  parameters: Schema.Struct({
    questions: Schema.Array(AskedQuestion)
      .check(Schema.isMinLength(1), Schema.isMaxLength(4))
      .annotate({ description: "Related questions, asked together." }),
  }),
  success: Schema.Struct({ status: Schema.Literal("asked"), requestId: Schema.String, note: Schema.String }),
  failure: OrchestratorError,
});

export const ArtifactGuide = Tool.make("artifact_guide", {
  description:
    "How to write an artifact: the HTML building blocks, tokens and rules for visuals Cerium renders" +
    " inline in your reply. Read it before writing your first artifact.",
  success: Schema.Struct({ guide: Schema.String }),
  failure: OrchestratorError,
});

export const BusToolkit = Toolkit.make(
  ListModels,
  SpawnAgent,
  ListAgents,
  ListThreads,
  SendMessage,
  KillAgent,
  AskAdvisor,
  AskUser,
  ArtifactGuide,
);

const BEARER = /^Bearer\s+(.+)$/i;

export const BusToolkitHandlers = BusToolkit.toLayer(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const registry = yield* BusRegistry;

    /** The agent making this call, from its per-session bearer token. */
    const caller = Effect.gen(function* () {
      const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
      const token = Option.flatMap(request, (http) =>
        Option.fromNullishOr(BEARER.exec(http.headers["authorization"] ?? "")?.[1]),
      );
      const agentId = Option.flatMap(token, (value) => registry.agentFor(value));
      if (Option.isNone(agentId)) {
        return yield* new OrchestratorError({ reason: "notAllowed", message: "Unknown Cerium agent." });
      }
      return agentId.value;
    });

    return BusToolkit.of({
      list_models: () =>
        Effect.succeed({
          models: orchestrator.catalog.map(({ alias, provider, model, effort, description }) => ({
            alias,
            provider,
            model,
            ...(effort ? { effort } : {}),
            description,
          })),
        }),

      spawn_agent: Effect.fn("Bus.spawn_agent")(function* (request) {
        const outcome = yield* orchestrator.spawn(yield* caller, request);
        return outcome._tag === "Spawned"
          ? { status: "spawned" as const, agentId: outcome.agentId }
          : {
              status: "pendingApproval" as const,
              requestId: outcome.requestId,
              note: "The user must approve this model. You will get a message with their decision.",
            };
      }),

      list_agents: Effect.fn("Bus.list_agents")(function* () {
        const self = yield* orchestrator.agent(yield* caller);
        const agents = yield* orchestrator.listAgents(self.threadId);
        return {
          agents: agents.map((agent) => ({
            agentId: agent.id,
            role: agent.role,
            provider: agent.provider,
            model: agent.model,
            state: agent.state,
            you: agent.id === self.id,
          })),
        };
      }),

      list_threads: Effect.fn("Bus.list_threads")(function* () {
        const self = yield* orchestrator.agent(yield* caller);
        const overviews = yield* orchestrator.threadOverviews;
        return {
          threads: overviews.flatMap(({ thread, agents }) => {
            if (thread.archivedAt !== undefined) return [];
            const lead = agents.find((agent) => agent.parentId === undefined);
            return [
              {
                threadId: thread.id,
                title: thread.title,
                mode: thread.mode,
                ...(thread.cwd ? { folder: thread.cwd } : {}),
                ...(lead ? { leadAgentId: lead.id, leadState: lead.state } : {}),
                yours: thread.id === self.threadId,
              },
            ];
          }),
        };
      }),

      send_message: Effect.fn("Bus.send_message")(function* ({ to, text }) {
        yield* orchestrator.sendMessage(yield* caller, to, text);
        return { delivered: true };
      }),

      kill_agent: Effect.fn("Bus.kill_agent")(function* ({ agentId }) {
        yield* orchestrator.killChild(yield* caller, agentId);
        return { stopped: true };
      }),

      ask_advisor: Effect.fn("Bus.ask_advisor")(function* ({ question }) {
        const { advisorId } = yield* orchestrator.askAdvisor(yield* caller, question);
        return {
          status: "asked" as const,
          advisorId,
          note: `The answer arrives as a [Cerium] message from agent ${advisorId}, the advisor. End your turn or carry on with other work meanwhile.`,
        };
      }),

      ask_user: Effect.fn("Bus.ask_user")(function* ({ questions }) {
        const [first, ...rest] = questions.map((asked): Question => ({
          ...(asked.header?.trim() ? { header: asked.header.trim() } : {}),
          question: asked.question,
          options: (asked.options ?? []).map(({ label, description }) => ({
            label: label.trim(),
            ...(description?.trim() ? { description: description.trim() } : {}),
          })),
          multiSelect: asked.multiSelect ?? false,
          allowOther: asked.allowOther ?? true,
        }));
        if (first === undefined) {
          return yield* new OrchestratorError({ reason: "invalid", message: "Ask at least one question." });
        }
        const { requestId } = yield* orchestrator.askUser(yield* caller, [first, ...rest]);
        return {
          status: "asked" as const,
          requestId,
          note: "The user sees your question now. Their answer arrives as a [Cerium] message; end your turn or carry on with work that doesn't depend on it.",
        };
      }),

      artifact_guide: () => Effect.succeed({ guide: artifactGuide }),
    });
  }),
);
