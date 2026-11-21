import { HarnessFailure, type SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { homedir } from "node:os";

import { PROVIDER } from "./manifest.ts";

// Devin's subscription quota and ACU limits, read from Devin's `SeatManagementService/GetUserStatus`
// Connect-RPC endpoint using the local API key the user's Devin CLI stores in `credentials.toml`.
// Strict safeguards:
//   - Read-only access to `credentials.toml`; the key is never cached, logged, or placed in error causes.
//   - Strict HTTPS + Cognition/Devin/Windsurf hostname allowlist before sending the key over the network.

const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const REQUEST_TIMEOUT_MS = 10_000;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/** Allowed API hosts for Devin credentials; prevents any credential exfiltration via tampered config. */
const ALLOWED_HOST = /(?:^|\.)(?:devin\.ai|cognition\.ai|windsurf\.com|codeium\.com)$/iu;

const Numberish = Schema.Union([Schema.Finite, Schema.String]);

const PlanInfo = Schema.Struct({
  planName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  monthlyPromptCredits: Schema.optionalKey(Schema.NullOr(Numberish)),
});

const PlanStatus = Schema.Struct({
  planInfo: Schema.optionalKey(Schema.NullOr(PlanInfo)),
  planEnd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dailyQuotaRemainingPercent: Schema.optionalKey(Schema.NullOr(Numberish)),
  dailyQuotaResetAtUnix: Schema.optionalKey(Schema.NullOr(Numberish)),
  weeklyQuotaRemainingPercent: Schema.optionalKey(Schema.NullOr(Numberish)),
  weeklyQuotaResetAtUnix: Schema.optionalKey(Schema.NullOr(Numberish)),
  acuConsumed: Schema.optionalKey(Schema.NullOr(Numberish)),
  acuLimit: Schema.optionalKey(Schema.NullOr(Numberish)),
  availablePromptCredits: Schema.optionalKey(Schema.NullOr(Numberish)),
  usedPromptCredits: Schema.optionalKey(Schema.NullOr(Numberish)),
});

/** The subset of `GetUserStatus` Cerium reads. */
export const DevinUserStatus = Schema.Struct({
  planInfo: Schema.optionalKey(Schema.NullOr(PlanInfo)),
  userStatus: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        planStatus: Schema.optionalKey(Schema.NullOr(PlanStatus)),
      }),
    ),
  ),
});
export type DevinUserStatus = typeof DevinUserStatus.Type;

const decodeUserStatus = Schema.decodeUnknownEffect(DevinUserStatus);

export interface DevinCredentials {
  readonly apiKey: string;
  readonly serverUrl: string;
}

/**
 * Validates that `api_server_url` is a clean HTTPS origin on an allowlisted Cognition/Devin host
 * with no embedded credentials, query string, or fragment.
 */
export const validateDevinServerUrl = (raw: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  if (!ALLOWED_HOST.test(parsed.hostname)) return undefined;
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  return `https://${parsed.host}${pathname}`;
};

const parseTomlString = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    // Strip trailing inline comment outside quotes, then JSON-unescape basic TOML string.
    let escaped = false;
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        try {
          const parsed: unknown = JSON.parse(trimmed.slice(0, i + 1));
          return typeof parsed === "string" ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    return end > 0 ? trimmed.slice(1, end) : undefined;
  }
  return undefined;
};

/** Extracts only top-level `windsurf_api_key` and `api_server_url` from Devin's `credentials.toml`. */
export const parseDevinCredentials = (toml: string): DevinCredentials | undefined => {
  let apiKey: string | undefined;
  let rawServerUrl: string | undefined;
  let inSection = false;

  for (const rawLine of toml.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inSection = true;
      continue;
    }
    if (inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = parseTomlString(line.slice(eq + 1));
    if (value === undefined) continue;
    if (key === "windsurf_api_key") apiKey = value;
    else if (key === "api_server_url") rawServerUrl = value;
  }

  if (!apiKey || !rawServerUrl) return undefined;
  const serverUrl = validateDevinServerUrl(rawServerUrl);
  if (serverUrl === undefined) return undefined;
  return { apiKey, serverUrl };
};

const toNumber = (value: number | string | null | undefined): number | undefined => {
  if (value == null) return undefined;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
};

const unixSecondsToMs = (value: number | string | null | undefined): { resetsAt?: number } => {
  const sec = toNumber(value);
  return sec !== undefined && sec > 0 ? { resetsAt: Math.round(sec * 1_000) } : {};
};

const isoToMs = (value: string | null | undefined): { resetsAt?: number } => {
  if (!value) return {};
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? { resetsAt: Math.round(ms) } : {};
};

const quotaWindowMeter = (
  label: string,
  windowMinutes: number,
  remainingRaw: number | string | null | undefined,
  resetRaw: number | string | null | undefined,
): UsageMeter | undefined => {
  const remaining = toNumber(remainingRaw);
  const reset = unixSecondsToMs(resetRaw);
  // Protobuf JSON omits zero-valued numeric fields, so an exhausted window can arrive with its
  // reset timestamp alone and no `remainingPercent`.
  const effectiveRemaining = remaining ?? (reset.resetsAt !== undefined ? 0 : undefined);
  if (effectiveRemaining === undefined) return undefined;
  const clamped = Math.min(100, Math.max(0, effectiveRemaining));
  return {
    label,
    usedPercent: Math.round((100 - clamped) * 100) / 100,
    windowMinutes,
    ...reset,
  };
};

/** Converts Devin's `GetUserStatus` response into Cerium's subscription report. */
export const toDevinReport = (payload: DevinUserStatus): Option.Option<SubscriptionReport> => {
  const status = payload.userStatus?.planStatus;
  if (!status) return Option.none();

  const info = payload.planInfo ?? status.planInfo;
  const plan = info?.planName?.trim() || undefined;
  const meters: Array<UsageMeter> = [];

  const daily = quotaWindowMeter(
    "Daily limit",
    DAY_MINUTES,
    status.dailyQuotaRemainingPercent,
    status.dailyQuotaResetAtUnix,
  );
  if (daily) meters.push(daily);

  const weekly = quotaWindowMeter(
    "Weekly limit",
    WEEK_MINUTES,
    status.weeklyQuotaRemainingPercent,
    status.weeklyQuotaResetAtUnix,
  );
  if (weekly) meters.push(weekly);

  const acuLimit = toNumber(status.acuLimit);
  const acuConsumed = toNumber(status.acuConsumed);
  if (acuLimit !== undefined && acuLimit > 0 && acuConsumed !== undefined) {
    meters.push({
      label: "Monthly ACUs",
      usedPercent: Math.max(0, Math.round((acuConsumed / acuLimit) * 1000) / 10),
      ...isoToMs(status.planEnd),
    });
  }

  if (meters.length === 0) {
    const monthly = toNumber(info?.monthlyPromptCredits);
    const used = toNumber(status.usedPromptCredits);
    const available = toNumber(status.availablePromptCredits);
    if (monthly !== undefined && monthly > 0 && (used !== undefined || available !== undefined)) {
      const effectiveUsed = used ?? Math.max(0, monthly - available!);
      meters.push({
        label: "Prompt credits",
        usedPercent: Math.max(0, Math.round((effectiveUsed / monthly) * 1000) / 10),
        ...isoToMs(status.planEnd),
      });
    }
  }

  if (meters.length === 0) return Option.none();
  return Option.some({
    ...(plan === undefined ? {} : { plan }),
    meters,
  });
};

const credentialCandidates = (path: Path.Path): ReadonlyArray<string> => {
  const home = homedir();
  const list: Array<string> = [];
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] || path.join(home, "AppData", "Local");
    const roaming = process.env["APPDATA"] || path.join(home, "AppData", "Roaming");
    list.push(path.join(local, "devin", "credentials.toml"));
    list.push(path.join(roaming, "devin", "credentials.toml"));
  } else {
    const xdg = process.env["XDG_DATA_HOME"];
    if (xdg) list.push(path.join(xdg, "devin", "credentials.toml"));
    list.push(path.join(home, ".local", "share", "devin", "credentials.toml"));
    if (process.platform === "darwin") {
      list.push(path.join(home, "Library", "Application Support", "devin", "credentials.toml"));
    }
  }
  return [...new Set(list)];
};

const readCredentials = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of credentialCandidates(path)) {
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) continue;
    const creds = parseDevinCredentials(text.value);
    if (creds !== undefined) return Option.some(creds);
  }
  return Option.none<DevinCredentials>();
});

const safeFailure = (message: string) => new HarnessFailure({ provider: PROVIDER, message, cause: null });

/** Queries Devin's usage status using the user's installed Devin CLI credentials (read-only). */
export const readDevinUsage = Effect.fn("DevinAdapter.usage")(function* (cliVersion: string) {
  const creds = yield* readCredentials;
  if (Option.isNone(creds)) return Option.none<SubscriptionReport>();

  const endpoint = `${creds.value.serverUrl}${USER_STATUS_PATH}`;
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({
          metadata: {
            apiKey: creds.value.apiKey,
            ideName: "devin",
            ideVersion: cliVersion,
            extensionVersion: cliVersion,
            locale: "en",
          },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      }),
    // Never attach raw fetch errors/request details to `cause`, so the key can never leak to logs.
    catch: () => safeFailure("Could not reach Devin's usage service."),
  });

  if (response.status === 401 || response.status === 403) {
    return Option.none<SubscriptionReport>();
  }
  if (!response.ok) {
    return yield* safeFailure(`Devin could not report its usage (HTTP ${response.status}).`);
  }

  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => safeFailure("Devin returned malformed usage data."),
  });
  const parsed = yield* decodeUserStatus(body).pipe(
    Effect.mapError(() => safeFailure("Unexpected Devin usage response.")),
  );
  return toDevinReport(parsed);
});
