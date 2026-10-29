import { Account } from "@cerium/account";
import { defaultAssistantModel, Orchestrator, UserSettings } from "@cerium/orchestrator";
import {
  LEAD_ROLE,
  type AssistantNotice,
  type AssistantRequest,
  type AssistantResult,
  type ProjectInfo,
} from "@cerium/protocol";
import { Effect, Layer, PubSub, Stream } from "effect";
import { basename } from "node:path";

import { Projects } from "./project.ts";

// Assistants outside Cerium (Grok, ChatGPT, Claude and others) the user connected to their account
// at the relay's MCP endpoint. While the user has them on in Settings → Assistants, this machine
// tells the relay it takes their calls, and answers each one the relay hands it: the projects and
// models it offers, a thread started on the assistant's prompt, a message to a thread's lead. A
// thread or message an assistant sends is marked with its name, so the user sees where it came from.

/** How long a call gets before the relay is told it couldn't be done; the relay waits a little longer. */
const ANSWER_WITHIN = "20 seconds";

const refused = (message: string): AssistantResult => ({ _tag: "Refused", message });

/** The project an assistant names: by its path, or by its folder's name when only one has it. */
export const findProject = (projects: ReadonlyArray<ProjectInfo>, wanted: string): ProjectInfo | string => {
  const present = projects.filter((project) => project.missing !== true);
  const trimmed = wanted.trim().replace(/[\\/]+$/, "");
  const byPath = present.find((project) => project.path.replace(/[\\/]+$/, "") === trimmed);
  if (byPath !== undefined) return byPath;
  const key = basename(trimmed).toLowerCase();
  const named = present.filter((project) => basename(project.path).toLowerCase() === key);
  const [only] = named;
  if (only !== undefined && named.length === 1) return only;
  if (named.length > 1)
    return `Several projects are called "${key}": ${named.map((project) => project.path).join(", ")}. Name one by its path.`;
  return `No project here is "${wanted}". list_projects names the folders this computer keeps as projects.`;
};

/** What this machine answers an assistant's call, if the user lets assistants in. */
export const answerAssistant = Effect.fn("Assistants.answer")(function* (
  assistant: string,
  request: AssistantRequest,
) {
  const settings = yield* UserSettings;
  const orchestrator = yield* Orchestrator;
  const projects = yield* Projects;
  const { assistants } = yield* settings.get;
  if (!assistants.enabled)
    return refused(
      "This computer doesn't let assistants start threads. The user can turn that on in Cerium: Settings → Assistants.",
    );
  switch (request._tag) {
    case "ListProjects": {
      const listed = yield* projects.list;
      return {
        _tag: "Projects",
        projects: listed
          .filter((project) => project.missing !== true)
          .map((project) => ({ path: project.path, name: basename(project.path) })),
      } satisfies AssistantResult;
    }
    case "ListModels": {
      const entries = yield* orchestrator.catalog;
      const first = defaultAssistantModel(entries);
      return {
        _tag: "Models",
        models: entries.map((entry) => ({
          alias: entry.alias,
          description: entry.description,
          default: entry === first,
        })),
      } satisfies AssistantResult;
    }
    case "StartThread": {
      let cwd: string | undefined;
      if (request.project !== undefined) {
        const found = findProject(yield* projects.list, request.project);
        if (typeof found === "string") return refused(found);
        cwd = found.path;
      }
      const { thread } = yield* orchestrator.startAssistantThread({
        assistant,
        prompt: request.prompt,
        ...(cwd === undefined ? {} : { cwd }),
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.worktree === undefined ? {} : { worktree: request.worktree }),
        access: assistants.access,
      });
      // As for a thread the user starts: its folder becomes the project used last.
      if (cwd !== undefined) yield* projects.save(cwd).pipe(Effect.ignore);
      return { _tag: "ThreadStarted", threadId: thread.id, title: thread.title } satisfies AssistantResult;
    }
    case "SendToThread": {
      const thread = (yield* orchestrator.listThreads).find((each) => each.id === request.threadId);
      if (thread === undefined) return refused("That thread isn't on this computer.");
      if (thread.archivedAt !== undefined)
        return refused("That thread is archived. The user can restore it in Cerium first.");
      const lead = (yield* orchestrator.listAgents(thread.id)).find(
        (agent) => agent.parentId === undefined && agent.role === LEAD_ROLE,
      );
      if (lead === undefined) return refused("That thread has no lead to send it to.");
      yield* orchestrator.sendUserMessage(lead.id, request.text, { sentVia: { assistant } });
      return { _tag: "Sent" } satisfies AssistantResult;
    }
  }
});

/**
 * Offers this machine to the account's assistants while the setting is on, and answers their calls.
 * Requires `Account`, `UserSettings`, `Orchestrator` and `Projects`.
 */
export const AssistantCalls = Layer.effectDiscard(
  Effect.gen(function* () {
    const account = yield* Account;
    const settings = yield* UserSettings;
    const context = yield* Effect.context<Orchestrator | UserSettings | Projects>();

    yield* settings.changes.pipe(
      Stream.map(({ assistants }) => assistants.enabled),
      Stream.changes,
      Stream.runForEach((enabled) => account.offerAssistants(enabled)),
      Effect.forkScoped,
    );

    const answer = (call: Extract<AssistantNotice, { readonly _tag: "AssistantCall" }>) =>
      answerAssistant(call.assistant, call.request).pipe(
        Effect.catch((error: { readonly message: string }) => Effect.succeed(refused(error.message))),
        Effect.timeoutOrElse({
          duration: ANSWER_WITHIN,
          orElse: () => Effect.succeed(refused("This computer took too long to do that.")),
        }),
        Effect.tap((result) =>
          Effect.logInfo("Answered an assistant").pipe(
            Effect.annotateLogs({
              assistant: call.assistant,
              request: call.request._tag,
              result: result._tag,
            }),
          ),
        ),
        Effect.flatMap((result) => account.send({ _tag: "AssistantReply", id: call.id, result })),
        Effect.ignore,
        Effect.provide(context),
      );

    const events = yield* account.relayEvents;
    yield* PubSub.take(events).pipe(
      Effect.flatMap((event) =>
        event._tag === "AssistantCall" ? Effect.forkScoped(answer(event)) : Effect.void,
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
