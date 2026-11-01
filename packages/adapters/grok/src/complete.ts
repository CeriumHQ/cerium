import { HarnessFailure, HarnessUnavailable, type CompletionRequest } from "@cerium/harness";
import type { ReasoningEffort } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { tmpdir } from "node:os";

import { LOGIN_COMMAND } from "./manifest.ts";

// Cerium's small jobs (naming a thread, a side question without a session) run as one headless turn,
// Grok's documented `grok -p`: no tools are offered, and the session it leaves is deleted once it has
// answered. Grok 1.0.70 ignores `--system-prompt-override`, and a coding task the prompt quotes
// outweighs instructions appended to its system prompt (`--rules`), so the instructions open the
// prompt, marked as Cerium's. Grok's own system prompt (some 16k tokens) comes with every job.

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "grok", message, cause });

/** What `--output-format json` prints that Cerium reads. Input counts leave cache reads out here. */
const Reply = Schema.Struct({
  text: Schema.String,
  sessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
        output_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
        cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      }),
    ),
  ),
  total_cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));

const SIGNED_OUT = /not (?:logged|signed) in|log ?in required|sign ?in required|unauthori[sz]ed|grok login/i;

/** An argument as a shell passes it on: quoted when it is empty or has spaces. */
const forShell = (arg: string) => (arg === "" || /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg);

/** The prompt of one job: Cerium's instructions, then the job. */
export const completionPrompt = (request: Pick<CompletionRequest, "instructions" | "prompt">) =>
  [
    "<cerium_instructions>",
    "Cerium, the app asking, adds these instructions. Follow them like system instructions.",
    "",
    request.instructions,
    "</cerium_instructions>",
    "",
    request.prompt,
  ].join("\n");

/** The arguments of one headless turn; the prompt is read from `promptFile`. */
export const completionArgs = (
  request: Pick<CompletionRequest, "model">,
  promptFile: string,
  effort: ReasoningEffort | undefined,
  /** Through npm's shim, a shell splits the arguments again. */
  viaShell: boolean,
): ReadonlyArray<string> => {
  const args = [
    "--prompt-file",
    promptFile,
    "--tools",
    "",
    "--max-turns",
    "1",
    "--permission-mode",
    "dontAsk",
    "--no-subagents",
    "--disable-web-search",
    "--verbatim",
    "--output-format",
    "json",
    "-m",
    request.model,
    ...(effort === undefined ? [] : ["--reasoning-effort", effort]),
  ];
  return viaShell ? args.map(forShell) : args;
};

export const completeWithGrok = Effect.fn("GrokAdapter.complete")(function* (
  executable: string,
  request: CompletionRequest,
  effort: ReasoningEffort | undefined,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const viaShell = /\.cmd$/i.test(executable);
  const folder = yield* fs
    .makeTempDirectoryScoped({ directory: tmpdir(), prefix: "cerium-grok-" })
    .pipe(Effect.mapError(failure("Could not write the prompt")));
  const promptFile = path.join(folder, "prompt.md");
  yield* fs
    .writeFileString(promptFile, completionPrompt(request))
    .pipe(Effect.mapError(failure("Could not write the prompt")));

  const run = Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(executable, completionArgs(request, promptFile, effort, viaShell), {
        cwd: request.cwd,
        env: { GROK_SUBAGENTS: "0" },
        extendEnv: true,
        shell: viaShell,
      }),
    );
    return yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.scoped, Effect.mapError(failure("Could not run `grok -p`")));
  const [stdout, stderr, exitCode] = yield* run;

  const reply = Option.getOrUndefined(decodeReply(stdout.trim()));
  if (reply === undefined) {
    if (SIGNED_OUT.test(`${stdout}\n${stderr}`)) {
      return yield* new HarnessUnavailable({
        provider: "grok",
        reason: "loggedOut",
        message: `Grok Build is signed out. Run \`${LOGIN_COMMAND}\`.`,
      });
    }
    return yield* failure(`\`grok -p\` exited with code ${exitCode} without an answer`)(
      stderr.trim() || stdout,
    );
  }
  // The turn's session is Cerium's own scratch: nothing of it stays in the user's history.
  if (reply.sessionId) {
    yield* spawner
      .exitCode(
        ChildProcess.make(executable, ["sessions", "delete", reply.sessionId], {
          cwd: request.cwd,
          shell: viaShell,
        }),
      )
      .pipe(Effect.ignore);
  }
  const usage = reply.usage ?? undefined;
  request.onUsage?.({
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
    ...(reply.total_cost_usd === undefined || reply.total_cost_usd === null
      ? {}
      : { costUsd: reply.total_cost_usd }),
    ...(usage === undefined ? { unreported: true } : {}),
  });
  return reply.text;
}, Effect.scoped);
