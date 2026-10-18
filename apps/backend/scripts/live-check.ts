// Live harness check: one short, real turn per harness in a scratch folder, run with this checkout's
// adapters, reporting the tools each called, the approvals it asked for, the files it left and its
// reply. Every harness has a deadline and the process always exits, so a stuck session never hangs it.
// Agents reach it through the bus's `live_check` tool; it uses the logged-in harness accounts.
//
// Usage: node apps/backend/scripts/live-check.ts [--providers=claude,codex,muse,cursor] [--access=auto]
//          [--model=claude:haiku] [--prompt="…"] [--expect=a.txt,b.txt] [--expect-reply=DONE]
//          [--max-approvals=0] [--approvals=deny|allow] [--timeout=180]
//        node apps/backend/scripts/live-check.ts --json=<base64url request>   (what `live_check` runs)

import { LiveCheckRequest, RESULT_MARKER, renderResults, runLiveChecks } from "@cerium/bus";
import { Adapters } from "@cerium/orchestrator";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";

import { AdaptersLive } from "../src/layers.ts";

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
      "node apps/backend/scripts/live-check.ts [options]",
      "  --providers=claude,codex   harnesses to check (default: all)",
      "  --access=auto              readOnly | ask | acceptEdits | auto | fullAccess",
      "  --model=claude:haiku       a model per provider, repeatable as a list",
      '  --prompt="…"               the turn (default: a shell command and a file edit)',
      "  --expect=a.txt,b.txt       files the turn must leave",
      "  --expect-reply=DONE        text the reply must contain",
      "  --max-approvals=0          fail past this many approval requests",
      "  --approvals=deny|allow     how requests are answered (default deny)",
      "  --timeout=180              seconds per harness",
    ].join("\n"),
  );
  process.exit(0);
}

const json = flag("json");
const input: unknown =
  json !== undefined
    ? JSON.parse(Buffer.from(json, "base64url").toString("utf8"))
    : {
        ...(list("providers") ? { providers: list("providers") } : {}),
        ...(flag("access") ? { access: flag("access") } : {}),
        ...(list("model")
          ? { models: Object.fromEntries(list("model")!.map((pair) => pair.split(":") as [string, string])) }
          : {}),
        ...(flag("prompt") ? { prompt: flag("prompt") } : {}),
        ...(list("expect") ? { expectFiles: list("expect") } : {}),
        ...(flag("expect-reply") ? { expectReply: flag("expect-reply") } : {}),
        ...(flag("max-approvals") ? { maxApprovals: Number(flag("max-approvals")) } : {}),
        ...(flag("approvals") ? { approvals: flag("approvals") } : {}),
        ...(flag("timeout") ? { timeoutSeconds: Number(flag("timeout")) } : {}),
      };

const request = Schema.decodeUnknownSync(LiveCheckRequest)(input);

const results = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* runLiveChecks(yield* Adapters, request);
  }).pipe(Effect.provide(AdaptersLive.pipe(Layer.provide(NodeServices.layer)))),
);

if (json !== undefined) console.log(`${RESULT_MARKER}${JSON.stringify(results)}`);
else console.log(renderResults(results));
// Harness processes a timed-out check left behind must not keep this one alive.
process.exit(results.every((result) => result.status === "passed") ? 0 : 1);
