import { BUILD_VERSION } from "../../backend/target.ts";

/** Mirrors the shell's `BackendFailureKind` in apps/desktop/src/backendFailure.ts. */
export type BackendFailureKind =
  | "databaseOpen"
  | "databaseMigrate"
  | "listen"
  | "startup"
  | "crash"
  | "exited"
  | "hostStopped"
  | "hostOutdated"
  | "desktopOutdated"
  | "hostUnreachable";

export interface HostFailureInfo {
  readonly serviceInstalled: boolean;
  readonly canFallback?: boolean;
  readonly busy?: "starting" | "updating";
  readonly command?: string;
}

/** Mirrors the shell's `BackendFailure`: why the backend last stopped. */
export interface BackendFailure {
  readonly kind: BackendFailureKind;
  readonly message: string;
  readonly log: string;
  readonly at: number;
  readonly host?: HostFailureInfo;
}

const HEADLINES: Record<BackendFailureKind, string> = {
  databaseOpen: "Cerium couldn't open its database.",
  databaseMigrate: "Cerium couldn't update its database for this version.",
  listen: "Cerium's backend couldn't open its local port.",
  startup: "Cerium's backend couldn't start.",
  crash: "Cerium's backend crashed.",
  exited: "Cerium's backend stopped.",
  hostStopped: "Cerium Host is stopped.",
  hostOutdated: "Cerium Host needs an update.",
  desktopOutdated: "Cerium Desktop needs an update.",
  hostUnreachable: "Cerium Host isn't responding.",
};

export const isHostFailure = (kind: BackendFailureKind): boolean =>
  kind === "hostStopped" ||
  kind === "hostOutdated" ||
  kind === "desktopOutdated" ||
  kind === "hostUnreachable";

/** What the notice leads with for a failure of `kind`. */
export const failureHeadline = (kind: BackendFailureKind): string => HEADLINES[kind];

const asHostFailureInfo = (value: unknown): HostFailureInfo | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { serviceInstalled, canFallback, busy, command } = value as Partial<
    Record<keyof HostFailureInfo, unknown>
  >;
  if (typeof serviceInstalled !== "boolean") return undefined;
  return {
    serviceInstalled,
    ...(typeof canFallback === "boolean" ? { canFallback } : {}),
    ...(busy === "starting" || busy === "updating" ? { busy } : {}),
    ...(typeof command === "string" ? { command } : {}),
  };
};

/** A failure the shell sent, or undefined for anything else, including none. */
export const asBackendFailure = (value: unknown): BackendFailure | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, message, log, at, host } = value as Partial<Record<keyof BackendFailure, unknown>>;
  if (typeof kind !== "string" || !(kind in HEADLINES)) return undefined;
  if (typeof message !== "string" || typeof at !== "number") return undefined;
  const hostInfo = asHostFailureInfo(host);
  return {
    kind: kind as BackendFailureKind,
    message,
    log: typeof log === "string" ? log : "",
    at,
    ...(hostInfo === undefined ? {} : { host: hostInfo }),
  };
};

/** The failure's first line, short enough for one line of a notice. */
export const shortMessage = (message: string, limit = 160): string => {
  const line = message.split("\n", 1)[0]?.trim() ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/** The build and system a report names, before what failed. */
const aboutThisBuild = (platform: string | undefined): string =>
  `Cerium ${BUILD_VERSION}${platform ? ` on ${platform}` : ""}`;

/** A backend failure as text to paste in a bug report: it's the user's to read before they share it. */
export const backendFailureDetails = (failure: BackendFailure, platform: string | undefined): string =>
  [
    aboutThisBuild(platform),
    `${failureHeadline(failure.kind)} (${failure.kind}, ${new Date(failure.at).toISOString()})`,
    failure.message,
    ...(failure.log === "" ? [] : ["", "Backend log:", failure.log]),
  ].join("\n");

/** An error a view threw while drawing, as text to paste in a bug report. */
export const renderErrorDetails = (
  error: unknown,
  componentStack: string | undefined,
  platform: string | undefined,
): string => {
  const stack = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  return [
    aboutThisBuild(platform),
    stack,
    ...(componentStack ? ["", "Component stack:", componentStack.trim()] : []),
  ].join("\n");
};

/** What a view's error says in one line. */
export const renderErrorMessage = (error: unknown): string =>
  shortMessage(error instanceof Error ? error.message || error.name : String(error));
