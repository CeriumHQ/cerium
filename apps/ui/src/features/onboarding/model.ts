import type { HarnessStatus } from "@cerium/protocol";

// The welcome Cerium opens with on a computer's first run: hello, the glass it's cut from, and, only
// while no harness can run a thread, signing in to one. When it opens by itself, the steps it takes,
// and how the keys step through it.

/** The welcome's steps, in order. */
export const STEPS = ["hello", "glass", "connect"] as const;
export type StepId = (typeof STEPS)[number];

/** The steps a welcome takes: signing in to a harness only while none can run a thread. */
export const stepsFor = (needsHarness: boolean): ReadonlyArray<StepId> =>
  needsHarness ? STEPS : STEPS.filter((step) => step !== "connect");

/** Set once the welcome was finished or skipped on this computer; it doesn't open by itself again. */
export const WELCOMED_KEY = "cerium:welcomed";

/**
 * Whether the welcome opens as the launch screen gives way: on a desktop that never finished it and
 * has no threads yet. A computer with threads already knows its way around, and the web client signs
 * in to a desktop that does.
 */
export const opensOnLaunch = (state: {
  readonly web: boolean;
  readonly welcomed: string | undefined;
  /** How many threads the machine lists; undefined until it answers, which opens nothing. */
  readonly threads: number | undefined;
}): boolean => !state.web && state.welcomed === undefined && state.threads === 0;

/** The step a development build opens on, from `?welcome=<step>`; the first for a bare `?welcome`. */
export const stepFromQuery = (search: string): StepId | undefined => {
  const params = new URLSearchParams(search);
  if (!params.has("welcome")) return undefined;
  return STEPS.find((step) => step === params.get("welcome")) ?? "hello";
};

/** What a key press does in the welcome, if anything. */
export type WelcomeKey = "next" | "back" | "skip" | undefined;

export const welcomeKey = (event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  /** The key went to a text field, which keeps every key for itself. */
  readonly inField: boolean;
  /** The key went to a group the arrows move through, such as the themes, which keeps the arrows, Home and End. */
  readonly inGroup: boolean;
  /** The key went to a button or link, which Enter presses. */
  readonly onButton: boolean;
}): WelcomeKey => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.inField) return undefined;
  if (event.key === "Escape") return "skip";
  if (event.inGroup && /^(Arrow|Home$|End$)/.test(event.key)) return undefined;
  if (event.key === "ArrowRight" || event.key === "PageDown") return "next";
  if (event.key === "ArrowLeft" || event.key === "PageUp") return "back";
  if (event.key === "Enter" && !event.onButton) return "next";
  return undefined;
};

/** Whether a harness can run a thread yet: a harness not yet heard of is unknown. */
export type Readiness = "ready" | "attention" | "missing" | "unknown";

export const harnessReadiness = (status: HarnessStatus | undefined): Readiness => {
  if (status === undefined) return "unknown";
  if (status._tag === "HarnessMissing") return "missing";
  return status.auth._tag === "LoggedOut" || status.setup !== undefined ? "attention" : "ready";
};

/** Whether the welcome asks for a harness: once the harnesses are known, and none of them can run. */
export const needsHarness = (statuses: ReadonlyArray<HarnessStatus> | undefined): boolean =>
  statuses !== undefined && !statuses.some((status) => harnessReadiness(status) === "ready");
