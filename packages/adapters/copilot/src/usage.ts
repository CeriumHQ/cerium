import type { SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Clock, Effect, Option, Schema } from "effect";
import { ErrorCodes, ResponseError } from "vscode-jsonrpc/node";

import { failure, type CopilotHost } from "./rpc.ts";

// GitHub Copilot subscription quotas, from JSON-RPC Protocol 4 `account.getQuota`.

const QuotaSnapshot = Schema.Struct({
  isUnlimitedEntitlement: Schema.optionalKey(Schema.Boolean),
  entitlementRequests: Schema.optionalKey(Schema.Finite),
  usedRequests: Schema.optionalKey(Schema.Finite),
  usageAllowedWithExhaustedQuota: Schema.optionalKey(Schema.Boolean),
  remainingPercentage: Schema.optionalKey(Schema.Finite),
  overage: Schema.optionalKey(Schema.Finite),
  overageAllowedWithExhaustedQuota: Schema.optionalKey(Schema.Boolean),
  resetDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** The subset of `account.getQuota` Cerium reads. */
export const CopilotQuota = Schema.Struct({
  quotaSnapshots: Schema.Record(Schema.String, Schema.NullOr(QuotaSnapshot)),
});
export type CopilotQuota = typeof CopilotQuota.Type;

const decodeQuota = Schema.decodeUnknownEffect(CopilotQuota);

const BUCKET_ORDER = ["premium_interactions", "chat", "completions"] as const;

const BUCKET_LABELS: Readonly<Record<string, string>> = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};

const bucketLabel = (key: string): string =>
  BUCKET_LABELS[key] ??
  key
    .split(/[_-]+/u)
    .filter((word) => word.length > 0)
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;

const parseReset = (
  resetDate: string | null | undefined,
  now?: number,
): { resetsAt?: number; resetDayOnly?: boolean } => {
  if (!resetDate) return {};
  const day = DATE_ONLY.exec(resetDate.trim());
  if (day) {
    const at = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isFinite(at) && at >= 0 ? { resetsAt: at, resetDayOnly: true } : {};
  }
  const at = Date.parse(resetDate);
  if (!Number.isFinite(at) || at < 0) return {};
  // Some Copilot plans echo the snapshot's current timestamp in `resetDate` instead of a future
  // cycle boundary; drop timestamps already in the past so the meter doesn't read "Resetting now".
  if (now !== undefined && at <= now) return {};
  return { resetsAt: Math.round(at) };
};

const toMeter = (key: string, snapshot: typeof QuotaSnapshot.Type, now?: number): UsageMeter | undefined => {
  if (snapshot.isUnlimitedEntitlement === true) return undefined;
  if (snapshot.entitlementRequests !== undefined && snapshot.entitlementRequests < 0) return undefined;

  let usedPercent: number | undefined;
  if (
    snapshot.overage !== undefined &&
    snapshot.overage > 0 &&
    snapshot.entitlementRequests !== undefined &&
    snapshot.entitlementRequests > 0
  ) {
    const used = snapshot.usedRequests ?? snapshot.entitlementRequests;
    usedPercent = ((used + snapshot.overage) / snapshot.entitlementRequests) * 100;
  } else if (snapshot.remainingPercentage !== undefined) {
    usedPercent = 100 - snapshot.remainingPercentage;
  } else if (
    snapshot.entitlementRequests !== undefined &&
    snapshot.entitlementRequests > 0 &&
    snapshot.usedRequests !== undefined
  ) {
    usedPercent = (snapshot.usedRequests / snapshot.entitlementRequests) * 100;
  }
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return undefined;

  const clamped = Math.max(0, usedPercent);
  const exhausted =
    clamped >= 100 ||
    (snapshot.usageAllowedWithExhaustedQuota === false &&
      snapshot.remainingPercentage !== undefined &&
      snapshot.remainingPercentage <= 0);

  return {
    label: bucketLabel(key),
    usedPercent: clamped,
    ...parseReset(snapshot.resetDate, now),
    ...(exhausted ? { level: "critical" as const } : {}),
  };
};

/** Converts `account.getQuota` into Cerium's subscription report, skipping unlimited buckets. */
export const toCopilotReport = (quota: CopilotQuota, now?: number): Option.Option<SubscriptionReport> => {
  const keys = Object.keys(quota.quotaSnapshots);
  const ordered = [
    ...BUCKET_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !(BUCKET_ORDER as ReadonlyArray<string>).includes(key)).sort(),
  ];
  const meters = ordered.flatMap((key) => {
    const snapshot = quota.quotaSnapshots[key];
    if (snapshot == null) return [];
    const meter = toMeter(key, snapshot, now);
    return meter === undefined ? [] : [meter];
  });
  return meters.length === 0 ? Option.none() : Option.some({ meters });
};

/** Queries an open Copilot CLI host for the authenticated account's quota snapshots. */
export const readCopilotUsage = Effect.fn("CopilotAdapter.usage")(function* (host: CopilotHost) {
  const response = yield* host.request("account.getQuota", {}).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.cause instanceof ResponseError && error.cause.code === ErrorCodes.MethodNotFound,
      () => Effect.succeedNone,
    ),
  );
  if (Option.isNone(response)) return Option.none<SubscriptionReport>();
  const quota = yield* decodeQuota(response.value).pipe(
    Effect.mapError(failure("Unexpected `account.getQuota` response from GitHub Copilot CLI")),
  );
  const now = yield* Clock.currentTimeMillis;
  return toCopilotReport(quota, now);
});
