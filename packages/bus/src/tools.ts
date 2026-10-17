import { artifactGuide } from "@cerium/artifacts";
import { Orchestrator, OrchestratorError } from "@cerium/orchestrator";
import { AccessMode, AgentId, ProviderId, ReasoningEffort } from "@cerium/protocol";
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
      description: "readOnly, ask or acceptEdits. Never more than your own access.",
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
  description: "List Cerium's threads and their lead agents, to message another thread's lead.",
  success: Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        threadId: Schema.String,
        title: Schema.String,
        mode: Schema.String,
        leadAgentId: Schema.optionalKey(AgentId),
      }),
    ),
  }),
  failure: OrchestratorError,
});

export const SendMessage = Tool.make("send_message", {
  description:
    "Send a message to another agent: anyone in your thread, or another thread's lead if you are a lead." +
    " It arrives as their next turn's input.",
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
        yield* caller;
        const threads = yield* orchestrator.listThreads;
        const summaries = yield* Effect.forEach(threads, (thread) =>
          orchestrator.listAgents(thread.id).pipe(
            Effect.map((agents) => {
              const lead = agents.find((agent) => agent.parentId === undefined);
              return {
                threadId: thread.id,
                title: thread.title,
                mode: thread.mode,
                ...(lead ? { leadAgentId: lead.id } : {}),
              };
            }),
          ),
        );
        return { threads: summaries };
      }),

      send_message: Effect.fn("Bus.send_message")(function* ({ to, text }) {
        yield* orchestrator.sendMessage(yield* caller, to, text);
        return { delivered: true };
      }),

      kill_agent: Effect.fn("Bus.kill_agent")(function* ({ agentId }) {
        yield* orchestrator.killChild(yield* caller, agentId);
        return { stopped: true };
      }),

      artifact_guide: () => Effect.succeed({ guide: artifactGuide }),
    });
  }),
);
