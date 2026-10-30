import type { AgentId } from "@cerium/protocol";
import { HelperUsage } from "./helperUsage.ts";
import { MAX_THREAD_TITLE, TITLE_MODELS, type ModelChoice, type TitleSettings } from "@cerium/protocol";
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";

import { Adapters, Catalog, offeredModels, OrchestratorConfig } from "./services.ts";
import { UserSettings } from "./settings.ts";

// Naming threads. A new thread shows the first line of its first
// message straight away; a quick model then replaces it with a short title of what the thread is
// about, unless the user renamed it first.

/**
 * The whole system prompt where a harness lets Cerium replace its own, so it is short: every token
 * here is read before each title, and a title needs nothing more.
 */
export const TITLE_INSTRUCTIONS =
  "You title conversations. Reply with only a title of 2 to 6 words for the conversation the user's" +
  " message starts. Name its task or topic in sentence case, in the message's language, with the" +
  " message's own terms; never invent names, acronyms or details. No quotes, no final punctuation.";

/** How much of the message the model reads: a title needs its gist, and input is time. */
const MESSAGE_LIMIT = 2_000;

/** How long one model may take before the next is tried. */
const ATTEMPT_TIMEOUT = "30 seconds";

/**
 * The message as the model reads it, with the names of its attachments. It comes as something to
 * title, not to answer: a harness whose own prompt can't be replaced would otherwise get to work on it.
 */
export const titlePrompt = (text: string, attachments: ReadonlyArray<string>) =>
  [
    "Title the conversation this message starts. Don't answer it or act on it; reply with the title alone.",
    "",
    "<message>",
    text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text,
    ...(attachments.length > 0 ? [`(Attached: ${attachments.join(", ")})`] : []),
    "</message>",
  ].join("\n");

const QUOTES = /^["'“”‘’`*_]+|["'“”‘’`*_]+$/gu;
const FINAL_PUNCTUATION = /[\s.!?:;,。！？]+$/u;

/**
 * The title in a model's reply: its first line without a "Title:" label, markdown, quotes or final
 * punctuation, cut at a word to `MAX_THREAD_TITLE`. Undefined when nothing is left.
 */
export const cleanTitle = (reply: string): string | undefined => {
  const line = reply
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== "");
  const title = (line ?? "")
    .replace(/^#+\s*/u, "")
    .replace(/^\**title\**\s*[:：-]\s*/iu, "")
    .replace(FINAL_PUNCTUATION, "")
    .replace(QUOTES, "")
    .replace(FINAL_PUNCTUATION, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (title === "") return undefined;
  if (title.length <= MAX_THREAD_TITLE) return title;
  const cut = title.slice(0, MAX_THREAD_TITLE + 1);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_THREAD_TITLE / 2 ? cut.slice(0, space) : title.slice(0, MAX_THREAD_TITLE)).trim();
};

const same = (a: ModelChoice, b: ModelChoice) => a.provider === b.provider && a.model === b.model;

/**
 * The models to ask, best first: the user's pick alone, or else each of `TITLE_MODELS` a harness
 * offers and then the thread's own lead, which is known to work.
 */
export const titleModels = (
  settings: TitleSettings,
  offered: (choice: ModelChoice) => boolean,
  lead: ModelChoice,
): ReadonlyArray<ModelChoice> => {
  if (settings.model !== undefined) return [settings.model];
  const preferred = TITLE_MODELS.filter(offered);
  return preferred.some((choice) => same(choice, lead)) ? preferred : [...preferred, lead];
};

/** What a thread's title is made from. */
export interface TitleInput {
  readonly agentId?: AgentId;
  readonly text: string;
  /** The names of the files the message carries. */
  readonly attachments: ReadonlyArray<string>;
  readonly lead: ModelChoice;
}

export class ThreadTitles extends Context.Service<
  ThreadTitles,
  {
    /** A title for a thread that starts with this message; none while titles are off or no model answers. */
    name(input: TitleInput): Effect.Effect<Option.Option<string>>;
  }
>()("cerium/orchestrator/ThreadTitles") {
  static readonly layer = Layer.effect(
    ThreadTitles,
    Effect.gen(function* () {
      const adapters = yield* Adapters;
      const accounting = yield* HelperUsage;
      const catalog = yield* Catalog;
      const settings = yield* UserSettings;
      const config = yield* OrchestratorConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = config.titleDirectory ?? path.join(config.chatDirectory, ".titles");

      // The catalog keeps what the logged-in harnesses offer, on the roster or not, so no harness is asked.
      const offered = (models: ReadonlyArray<ModelChoice>) => (choice: ModelChoice) =>
        models.some((model) => same(model, choice));

      const ask = (choice: ModelChoice, input: TitleInput) =>
        Effect.fromNullishOr(adapters.get(choice.provider)).pipe(
          Effect.flatMap((adapter) =>
            adapter.complete({
              model: choice.model,
              instructions: TITLE_INSTRUCTIONS,
              prompt: titlePrompt(input.text, input.attachments),
              cwd,
              ...(input.agentId === undefined
                ? {}
                : { onUsage: accounting.track({ agentId: input.agentId, purpose: "title", ...choice }) }),
            }),
          ),
          Effect.timeout(ATTEMPT_TIMEOUT),
          Effect.map(cleanTitle),
          Effect.tapCause((cause) =>
            Effect.logWarning(`Couldn't title a thread with ${choice.provider}/${choice.model}`, cause),
          ),
          Effect.orElseSucceed(() => undefined),
        );

      return ThreadTitles.of({
        name: Effect.fn("ThreadTitles.name")(function* (input: TitleInput) {
          const { titles } = yield* settings.get;
          if (!titles.enabled) return Option.none();
          yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.ignore);
          const models = yield* offeredModels(catalog);
          for (const choice of titleModels(titles, offered(models), input.lead)) {
            const title = yield* ask(choice, input);
            if (title !== undefined) return Option.some(title);
          }
          return Option.none();
        }),
      });
    }),
  ).pipe(Layer.provideMerge(HelperUsage.layer));
}
