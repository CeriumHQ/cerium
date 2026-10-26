// Live harness check: one short, real turn per harness in a scratch folder, run with this checkout's
// adapters, reporting the tools each called, the approvals it asked for, the files it left and its
// reply. Every harness has a deadline and the process always exits, so a stuck session never hangs it.
// It uses the logged-in harness accounts. Exits 0 when every harness passed.
//
// Usage: bun run live-check [--providers=claude,codex,muse,cursor] [--access=auto] [--model=claude:haiku]
//          [--prompt="…"] [--todos] [--expect=a.txt,b.txt] [--expect-reply=DONE] [--max-approvals=0]
//          [--approvals=deny|allow] [--timeout=180] [--compact] [--trace]

import { Adapters } from "@cerium/orchestrator";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";

import { AdaptersLive } from "../src/layers.ts";
import {
  LiveCheckRequest,
  renderResults,
  runLiveChecks,
  STOP_PROMPT,
  TODO_ITEMS,
  TODO_PROMPT,
} from "./live/check.ts";

const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const list = (name: string) =>
  flag(name)
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

if (process.argv.includes("--help")) {
  console.log(
    [
      "bun run live-check [options]",
      "  --providers=claude,codex   harnesses to check (default: all)",
      "  --access=auto              readOnly | ask | acceptEdits | auto | fullAccess",
      "  --model=claude:haiku       a model per provider, repeatable as a list",
      '  --prompt="…"               the turn (default: a shell command and a file edit)',
      "  --todos                    the turn keeps a two-item todo list, which must be reported",
      "  --expect=a.txt,b.txt       files the turn must leave",
      "  --expect-reply=DONE        text the reply must contain",
      "  --max-approvals=0          fail past this many approval requests",
      "  --approvals=deny|allow     how requests are answered (default deny)",
      "  --timeout=180              seconds per harness",
      "  --interrupt-after=8        run a long command, interrupt after this many seconds; must end as interrupted",
      "  --compact                  after the turn, ask the harness to compact; must report the compaction",
      "  --trace                    print each event, with the start of its raw provider message",
    ].join("\n"),
  );
  process.exit(0);
}

const todos = process.argv.includes("--todos");
const input: unknown = {
  ...(list("providers") ? { providers: list("providers") } : {}),
  ...(flag("access") ? { access: flag("access") } : {}),
  ...(list("model")
    ? { models: Object.fromEntries(list("model")!.map((pair) => pair.split(":") as [string, string])) }
    : {}),
  ...(todos ? { prompt: TODO_PROMPT, expectTodos: TODO_ITEMS } : {}),
  ...(flag("interrupt-after") ? { prompt: STOP_PROMPT, expectFiles: [] } : {}),
  ...(flag("prompt") ? { prompt: flag("prompt") } : {}),
  ...(list("expect") ? { expectFiles: list("expect") } : {}),
  ...(flag("expect-reply") ? { expectReply: flag("expect-reply") } : {}),
  ...(flag("max-approvals") ? { maxApprovals: Number(flag("max-approvals")) } : {}),
  ...(flag("approvals") ? { approvals: flag("approvals") } : {}),
  ...(flag("timeout") ? { timeoutSeconds: Number(flag("timeout")) } : {}),
  ...(flag("interrupt-after") ? { interruptAfterSeconds: Number(flag("interrupt-after")) } : {}),
  ...(process.argv.includes("--compact") ? { compact: true } : {}),
  ...(process.argv.includes("--trace") ? { trace: true } : {}),
};

const request = Schema.decodeUnknownSync(LiveCheckRequest)(input);

const results = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* runLiveChecks(yield* Adapters, request);
  }).pipe(Effect.provide(AdaptersLive.pipe(Layer.provide(NodeServices.layer)))),
);

console.log(renderResults(results));
// Harness processes a timed-out check left behind must not keep this one alive.
process.exit(results.every((result) => result.status === "passed") ? 0 : 1);
