import { openUsageTerminal, scratchFolder, type SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Clock, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";

import { failure, PROVIDER } from "./manifest.ts";
import { loginRequired } from "./probe.ts";

// Antigravity's subscription quota, read via the CLI's own documented `--settings` + `statusLine`
// JSON hook. `--settings` is session-only (never saved), `agy` manages its own OAuth refresh, and
// the hook hands Cerium structured JSON (quota buckets + plan_tier) with no ANSI scraping and no
// access to `agy`'s OAuth tokens or client secrets.

const POLL = Duration.millis(200);
const DEADLINE = Duration.seconds(25);
/** How long to wait after sending `/usage` when startup didn't report any quota buckets. */
const REFRESH_WAIT_MS = 6_000;

const FIVE_HOURS = 5 * 60;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

const QuotaBucket = Schema.Struct({
  remaining_fraction: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  remaining_amount: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  reset_time: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reset_in_seconds: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  disabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

/** The sanitized subset of `agy`'s `statusLine` JSON Cerium reads (`email` is never stored or decoded). */
export const AntigravityStatusLine = Schema.Struct({
  plan_tier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_state: Schema.optionalKey(Schema.NullOr(Schema.String)),
  quota: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(QuotaBucket)))),
});
export type AntigravityStatusLine = typeof AntigravityStatusLine.Type;

const decodeStatusLine = Schema.decodeUnknownOption(Schema.fromJsonString(AntigravityStatusLine));

const GROUP_NAMES: Readonly<Record<string, string>> = {
  gemini: "Gemini",
  "3p": "Claude & GPT",
};

const WINDOW_SPEC: Readonly<Record<string, { readonly label: string; readonly minutes: number }>> = {
  "5h": { label: "5-hour limit", minutes: FIVE_HOURS },
  daily: { label: "Daily limit", minutes: DAY_MINUTES },
  weekly: { label: "Weekly limit", minutes: WEEK_MINUTES },
};

const bucketOrder = (id: string): number => {
  const lower = id.toLowerCase();
  const prefix = lower.replace(/-(?:5h|daily|weekly)$/u, "");
  const groupRank = prefix === "gemini" ? 0 : prefix === "3p" ? 10 : prefix.startsWith("gemini") ? 20 : 30;
  const windowRank = lower.endsWith("-5h")
    ? 0
    : lower.endsWith("-daily")
      ? 1
      : lower.endsWith("-weekly")
        ? 2
        : 3;
  return groupRank + windowRank;
};

const bucketMeta = (id: string): { readonly label: string; readonly windowMinutes?: number } => {
  const lower = id.toLowerCase();
  for (const [suffix, spec] of Object.entries(WINDOW_SPEC)) {
    const token = `-${suffix}`;
    if (lower.endsWith(token)) {
      const prefix = lower.slice(0, -token.length);
      const group =
        GROUP_NAMES[prefix] ??
        prefix
          .split(/[_-]+/u)
          .filter((word) => word.length > 0)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
      return {
        label: group ? `${spec.label} · ${group}` : spec.label,
        windowMinutes: spec.minutes,
      };
    }
  }
  const humanized = id
    .split(/[_-]+/u)
    .filter((word) => word.length > 0)
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
  return { label: humanized || "Usage limit" };
};

const parseReset = (bucket: typeof QuotaBucket.Type, now: number): { resetsAt?: number } => {
  if (bucket.reset_time) {
    const at = Date.parse(bucket.reset_time);
    if (Number.isFinite(at) && at >= 0) return { resetsAt: Math.round(at) };
  }
  if (bucket.reset_in_seconds != null && bucket.reset_in_seconds >= 0) {
    return { resetsAt: Math.round(now + bucket.reset_in_seconds * 1_000) };
  }
  return {};
};

/** Converts an Antigravity `statusLine` JSON payload into Cerium's subscription report. */
export const toAntigravityReport = (
  payload: AntigravityStatusLine,
  now: number,
): Option.Option<SubscriptionReport> => {
  const quota = payload.quota;
  if (!quota) return Option.none();

  const keys = Object.keys(quota).sort((a, b) => bucketOrder(a) - bucketOrder(b) || a.localeCompare(b));
  const meters: Array<UsageMeter> = [];
  for (const id of keys) {
    const bucket = quota[id];
    if (!bucket || bucket.disabled === true) continue;
    if (bucket.remaining_fraction == null) continue;
    const clampedRemaining = Math.min(1, Math.max(0, bucket.remaining_fraction));
    const usedPercent = Math.round((1 - clampedRemaining) * 1000) / 10;
    const { label, windowMinutes } = bucketMeta(id);
    meters.push({
      label,
      usedPercent: Math.max(0, usedPercent),
      ...parseReset(bucket, now),
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
    });
  }

  if (meters.length === 0) return Option.none();
  const plan = payload.plan_tier?.trim();
  return Option.some({
    ...(plan ? { plan } : {}),
    meters,
  });
};

// Tiny Node capture script invoked by `agy`'s statusLine hook. Strips PII (`email`, paths) before
// writing atomic JSON so only plan_tier, agent_state, and quota ever touch disk.
const CAPTURE_SCRIPT = `import { renameSync, writeFileSync } from "node:fs";
const out = process.argv[2];
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  if (!out) return;
  try {
    const data = JSON.parse(raw);
    const kept = {
      plan_tier: typeof data?.plan_tier === "string" ? data.plan_tier : null,
      agent_state: typeof data?.agent_state === "string" ? data.agent_state : null,
      quota: data?.quota && typeof data.quota === "object" && !Array.isArray(data.quota) ? data.quota : null,
    };
    const tmp = out + ".tmp";
    writeFileSync(tmp, JSON.stringify(kept));
    renameSync(tmp, out);
  } catch {}
});
`;

const quoteArg = (value: string) => `"${value.replaceAll('"', '\\"')}"`;

/** Reads Antigravity's subscription quotas via an ephemeral `--settings` `statusLine` hook. */
export const readAntigravityUsage = Effect.fn("AntigravityAdapter.usage")(function* (executable: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* scratchFolder(PROVIDER, "cerium-antigravity-usage");
  const dir = yield* fs
    .makeTempDirectoryScoped({ directory: base, prefix: "run-" })
    .pipe(Effect.mapError((cause) => failure("Could not prepare Antigravity's usage folder", cause)));

  const captureScript = path.join(dir, "capture.mjs");
  const statusFile = path.join(dir, "status.json");
  const settingsFile = path.join(dir, "settings.json");
  const command = `${quoteArg(process.execPath)} ${quoteArg(captureScript)} ${quoteArg(statusFile)}`;

  yield* fs
    .writeFileString(captureScript, CAPTURE_SCRIPT)
    .pipe(Effect.mapError((cause) => failure("Could not write Antigravity's usage capture helper", cause)));
  yield* fs
    .writeFileString(
      settingsFile,
      JSON.stringify({
        statusLine: { type: "command", command, enabled: true },
        showTips: false,
        showFeedbackSurvey: false,
      }),
    )
    .pipe(Effect.mapError((cause) => failure("Could not write Antigravity's temporary settings", cause)));

  const term = yield* openUsageTerminal({
    provider: PROVIDER,
    file: executable,
    args: ["--settings", settingsFile],
    cwd: dir,
    env: { ...process.env, NO_OPEN_BROWSER: "1" },
    replyCpr: true,
    startErrorMessage: "Couldn't start Antigravity CLI",
  });

  let requestedRefreshAt: number | undefined;
  const read = Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(POLL);
      const now = yield* Clock.currentTimeMillis;

      const raw = yield* fs.readFileString(statusFile).pipe(Effect.option);
      if (Option.isSome(raw)) {
        const parsed = decodeStatusLine(raw.value);
        if (Option.isSome(parsed)) {
          const report = toAntigravityReport(parsed.value, now);
          if (Option.isSome(report)) return report;
          // If the CLI is idle with no quota reported yet, trigger `/usage` once to force a fresh
          // backend check; if still empty after REFRESH_WAIT_MS (e.g. API key / Vertex), return None.
          if (parsed.value.agent_state === "idle") {
            if (requestedRefreshAt === undefined) {
              term.write("/usage\r");
              requestedRefreshAt = now;
            } else if (now - requestedRefreshAt >= REFRESH_WAIT_MS) {
              return Option.none<SubscriptionReport>();
            }
          }
        }
      }

      if (term.isExited()) {
        return yield* failure("Antigravity CLI closed before it reported its usage.");
      }

      const screen = yield* term.screen;
      if (/Authentication required|Sign in with Google|Waiting for authentication/iu.test(screen)) {
        return yield* loginRequired();
      }
    }
  });

  return yield* read.pipe(
    Effect.timeoutOrElse({
      duration: DEADLINE,
      orElse: () => Effect.fail(failure("Antigravity CLI didn't report its usage in time.")),
    }),
  );
}, Effect.scoped);
