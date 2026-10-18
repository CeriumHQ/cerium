import { Adapters, Orchestrator } from "@cerium/orchestrator";
import { narrowAccess, type AgentId } from "@cerium/protocol";
import { Data, Effect, Layer, Schema, Scope } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { failure, registerRawTool, type RawReply } from "../raw.ts";
import { BusRegistry } from "../registry.ts";
import { LiveCheckRequest, LiveCheckResult, renderResults, runLiveChecks } from "./check.ts";

// The `live_check` bus tool (architecture §3.2). In a Cerium checkout it runs the checkout's own
// `apps/backend/scripts/live-check.ts`, so a change to an adapter is checked with that change; anywhere
// else it checks the harnesses through this app's adapters. Results arrive as a notice, like a child's.

/** Where a Cerium checkout keeps its live check, relative to the checkout. */
export const WORKSPACE_SCRIPT = join("apps", "backend", "scripts", "live-check.ts");
/** The line the script prints its results on, for the tool to read back. */
export const RESULT_MARKER = "LIVE_CHECK_RESULTS ";

const Input = Schema.Struct({
  ...LiveCheckRequest.fields,
  source: Schema.optionalKey(Schema.Literals(["workspace", "app"])).annotate({
    description:
      "workspace: run the live check of the Cerium checkout you work in, with its code (the default there)." +
      " app: check through this Cerium app's own adapters (the default anywhere else).",
  }),
  wait: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Answer with the results instead of a later message. Only for checks well under a minute: harnesses cut long tool calls off.",
  }),
});

const Results = Schema.Array(LiveCheckResult);

class LiveCheckError extends Data.TaggedError("LiveCheckError")<{ readonly message: string }> {}

const asError = (error: unknown) =>
  new LiveCheckError({ message: error instanceof Error ? error.message : String(error) });

const killTree = (pid: number | undefined) => {
  if (pid === undefined) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  else process.kill(-pid, "SIGKILL");
};

/** Runs the checkout's script in its own process, killed with everything it started at the deadline. */
const runInWorkspace = (folder: string, request: LiveCheckRequest, deadlineMs: number) =>
  Effect.callback<ReadonlyArray<LiveCheckResult>, LiveCheckError>((resume) => {
    const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
    const child = spawn("node", [WORKSPACE_SCRIPT, `--json=${encoded}`], {
      cwd: folder,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-4_000)));
    const timer = setTimeout(() => {
      killTree(child.pid);
      resume(
        Effect.fail(
          new LiveCheckError({
            message: `The live check was still running after ${deadlineMs / 1000} s and was stopped.`,
          }),
        ),
      );
    }, deadlineMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resume(Effect.fail(asError(error)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((each) => each.startsWith(RESULT_MARKER));
      if (line === undefined) {
        resume(
          Effect.fail(
            new LiveCheckError({
              message: `The live check exited (${code}) without results.\n${stderr.trim()}`,
            }),
          ),
        );
        return;
      }
      try {
        resume(
          Effect.succeed(Schema.decodeUnknownSync(Results)(JSON.parse(line.slice(RESULT_MARKER.length)))),
        );
      } catch (error) {
        resume(Effect.fail(asError(error)));
      }
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      killTree(child.pid);
    });
  });

export const LiveCheckTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* BusRegistry;
    const orchestrator = yield* Orchestrator;
    const adapters = yield* Adapters;
    const scope = yield* Scope.Scope;
    const running = new Set<AgentId>();

    yield* registerRawTool({
      name: "live_check",
      registry,
      description:
        "Run a short, real turn on one or more harnesses (Claude, Codex, Muse, Cursor) in scratch folders and report what" +
        " each did: tools called, approvals asked, files written, its reply, pass or fail. Use it to check adapter," +
        " access-mode or harness behaviour live instead of writing a script. By default it runs a shell command and a" +
        " file edit under Auto access. It returns at once; the results arrive later as a message, so end your turn" +
        " instead of waiting. Uses the user's harness accounts: keep prompts short and models cheap.",
      parameters: Input,
      handle: (caller, input) =>
        Effect.gen(function* () {
          const agent = yield* orchestrator.agent(caller).pipe(Effect.option);
          if (agent._tag === "None") return failure("Unknown Cerium agent.");
          const self = agent.value;
          if (self.access === "readOnly") return failure("Read-only agents can't run live checks.");
          if (running.has(caller))
            return failure("Your last live check is still running; its results arrive as a message.");

          const { source: asked, wait, ...rest } = input;
          // A check never gets more access than the agent asking for it.
          const request: LiveCheckRequest = {
            ...rest,
            access: narrowAccess(self.access, rest.access ?? "auto"),
          };
          const threads = yield* orchestrator.listThreads.pipe(Effect.orElseSucceed(() => []));
          const folder = threads.find((thread) => thread.id === self.threadId)?.cwd;
          const hasScript = folder !== undefined && existsSync(join(folder, WORKSPACE_SCRIPT));
          const source = asked ?? (hasScript ? "workspace" : "app");
          if (source === "workspace") {
            if (!hasScript) return failure(`Your folder has no ${WORKSPACE_SCRIPT}; use source "app".`);
            if (self.access !== "auto" && self.access !== "fullAccess") {
              return failure(
                `Running ${WORKSPACE_SCRIPT} runs your folder's code unreviewed, so it needs Auto or Full access.` +
                  ` Run it from your shell instead (node ${WORKSPACE_SCRIPT} --help), or use source "app".`,
              );
            }
          }

          const perHarness = request.timeoutSeconds ?? 180;
          const job = (
            source === "workspace"
              ? runInWorkspace(folder!, request, (perHarness + 60) * 1_000)
              : runLiveChecks(adapters, request)
          ).pipe(
            Effect.map((results) => `Live check finished (${source}):\n${renderResults(results)}`),
            Effect.catch((error) => Effect.succeed(`Live check failed (${source}): ${error.message}`)),
          );

          if (wait === true) return { text: yield* job } satisfies RawReply;

          running.add(caller);
          yield* job.pipe(
            Effect.flatMap((text) => orchestrator.notify(caller, text)),
            Effect.ensuring(Effect.sync(() => running.delete(caller))),
            Effect.forkIn(scope),
          );
          return {
            text: {
              status: "started",
              source,
              access: request.access,
              note: `Results arrive as a [Cerium] message within ${perHarness + 60} s. End your turn instead of waiting.`,
            },
          } satisfies RawReply;
        }),
    });
  }),
);
