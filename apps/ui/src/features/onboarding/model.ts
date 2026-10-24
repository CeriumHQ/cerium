import type { HarnessStatus } from "@cerium/protocol";

// The welcome Cerium opens with on a computer's first run: a few chapters, each a pane of glass the
// light passes through, from hello to the first thread. Its chapters, when it opens by itself, and
// how the keys step through it.

/** The welcome's chapters, in order; the rail at its foot names them. */
export const CHAPTERS = [
  { id: "hello", label: "Hello" },
  { id: "glass", label: "Glass" },
  { id: "thread", label: "Ask once" },
  { id: "agents", label: "Agents" },
  { id: "everywhere", label: "Everywhere" },
  { id: "ready", label: "Ready" },
] as const;
export type ChapterId = (typeof CHAPTERS)[number]["id"];

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

/** The chapter `by` steps from `index`, held at the first and the last. */
export const stepChapter = (index: number, by: number): number =>
  Math.min(CHAPTERS.length - 1, Math.max(0, index + by));

/** The chapter a development build opens on, from `?welcome=<chapter>`; the first for a bare `?welcome`. */
export const chapterFromQuery = (search: string): number | undefined => {
  const params = new URLSearchParams(search);
  if (!params.has("welcome")) return undefined;
  const index = CHAPTERS.findIndex((chapter) => chapter.id === params.get("welcome"));
  return Math.max(0, index);
};

/** What a key press does in the welcome, if anything: the keys never act while a field has them. */
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

/** Whether a harness can run agents yet, as the welcome lights its beam: a harness not yet heard of is unknown. */
export type Readiness = "ready" | "attention" | "missing" | "unknown";

export const harnessReadiness = (status: HarnessStatus | undefined): Readiness => {
  if (status === undefined) return "unknown";
  if (status._tag === "HarnessMissing") return "missing";
  return status.auth._tag === "LoggedOut" || status.setup !== undefined ? "attention" : "ready";
};

/** The harnesses in a line: how many are ready, how many need the user, how many aren't installed. */
export const readinessSummary = (all: ReadonlyArray<Readiness>): string => {
  if (all.length === 0 || all.every((each) => each === "unknown")) return "Looking for your harnesses…";
  const count = (readiness: Readiness) => all.filter((each) => each === readiness).length;
  const ready = count("ready");
  const attention = count("attention");
  const missing = count("missing");
  if (ready === 0 && attention === 0) return "None installed yet";
  return [
    ready > 0 ? `${ready} ready` : undefined,
    attention > 0 ? `${attention} to set up` : undefined,
    missing > 0 ? `${missing} not installed` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
};
