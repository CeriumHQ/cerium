import type { ProviderId } from "@cerium/protocol";

// The run the welcome's "Ask once" chapter plays: a message typed out and sent, a lead reading it and
// handing parts of it to agents of other harnesses, each working and reporting back, and the lead's
// answer. A sample, told as Cerium tells a real thread; nothing runs.

/** An agent the lead hands a part of the job to. */
export interface DemoAgent {
  readonly provider: ProviderId;
  /** What it was asked, as its card says while it works. */
  readonly task: string;
  /** What it reports, once done. */
  readonly result: string;
  /** The file it's in. */
  readonly file: string;
  /** How long it works, in milliseconds of the sample. */
  readonly takes: number;
}

export interface DemoRun {
  readonly id: string;
  /** The message, as the user types it. */
  readonly prompt: string;
  /** What the chip that replays it says. */
  readonly label: string;
  /** In the harnesses' order, so no two beams cross. */
  readonly agents: ReadonlyArray<DemoAgent>;
  /** The lead's answer, once every agent reported back. */
  readonly answer: string;
  readonly added: number;
  readonly removed: number;
  readonly files: number;
}

/** The lead every sample's message goes to. */
export const DEMO_LEAD: ProviderId = "claude";

export const DEMO_RUNS: ReadonlyArray<DemoRun> = [
  {
    id: "rate-limit",
    label: "Rate limiting",
    prompt: "Add rate limiting to the job queue, with tests and docs.",
    agents: [
      {
        provider: "codex",
        task: "Writing the tests",
        result: "29 tests pass",
        file: "queue.test.ts",
        takes: 2_900,
      },
      {
        provider: "cursor",
        task: "Reviewing the timing",
        result: "No race in the token bucket",
        file: "bucket.ts",
        takes: 2_300,
      },
      {
        provider: "opencode",
        task: "Updating the docs",
        result: "README explains the limits",
        file: "README.md",
        takes: 1_900,
      },
    ],
    answer: "Rate limiting is in: a token bucket per queue, tested and documented.",
    added: 184,
    removed: 12,
    files: 6,
  },
  {
    id: "flaky-upload",
    label: "A flaky test",
    prompt: "Find out why the upload test fails on slow networks.",
    agents: [
      {
        provider: "codex",
        task: "Reproducing on a throttled link",
        result: "Fails at 3G speeds, every time",
        file: "upload.test.ts",
        takes: 2_600,
      },
      {
        provider: "muse",
        task: "Reading the retry logic",
        result: "The retry gives up after 2\u00a0s",
        file: "retry.ts",
        takes: 2_000,
      },
      {
        provider: "opencode",
        task: "Checking the server's timeouts",
        result: "Server waits 30\u00a0s; client doesn't",
        file: "server.ts",
        takes: 2_400,
      },
    ],
    answer:
      "The client gave up before the server did. Retries now back off to 30\u00a0s, and the test passes.",
    added: 41,
    removed: 9,
    files: 3,
  },
  {
    id: "redesign",
    label: "A redesign",
    prompt: "Move the settings page onto the new design system.",
    agents: [
      {
        provider: "codex",
        task: "Snapshotting every page",
        result: "14 snapshots updated",
        file: "settings.spec.tsx",
        takes: 2_200,
      },
      {
        provider: "muse",
        task: "Swapping the icons",
        result: "38 icons, one set",
        file: "icons.ts",
        takes: 1_800,
      },
      {
        provider: "cursor",
        task: "Restyling the forms",
        result: "Every field on the new tokens",
        file: "Settings.tsx",
        takes: 3_000,
      },
    ],
    answer: "Settings is on the new design system, with its snapshots and icons to match.",
    added: 612,
    removed: 498,
    files: 21,
  },
];

/** How long each letter of the message takes to type, and when typing starts. */
const TYPE_MS = 24;
const TYPE_FROM = 500;
/** How long the message rests, typed, before it's sent; how long the lead reads before handing off. */
const SEND_AFTER = 450;
const READ_MS = 1_200;
/** How far apart the lead hands the parts off, and how long it takes to write its answer after. */
const HANDOFF_GAP = 320;
const ANSWER_AFTER = 700;

export type AgentPhase = "waiting" | "working" | "done";
export type LeadPhase = "idle" | "reading" | "delegating" | "answering" | "done";

/** Where a sample run is, `elapsed` milliseconds in. */
export interface DemoMoment {
  /** How much of the message is typed. */
  readonly typed: number;
  readonly sent: boolean;
  readonly lead: LeadPhase;
  /** Each agent's phase, and how far through its work it is, 0 to 1. */
  readonly agents: ReadonlyArray<{ readonly phase: AgentPhase; readonly progress: number }>;
  readonly answered: boolean;
  /** The run has played out. */
  readonly finished: boolean;
}

/** When each part of `run` happens, in milliseconds from its start. */
export const demoTimes = (run: DemoRun) => {
  const sent = TYPE_FROM + run.prompt.length * TYPE_MS + SEND_AFTER;
  const handoff = sent + READ_MS;
  const agents = run.agents.map((agent, index) => {
    const starts = handoff + index * HANDOFF_GAP;
    return { starts, ends: starts + agent.takes };
  });
  const lastEnd = Math.max(handoff, ...agents.map((agent) => agent.ends));
  return { sent, handoff, agents, answered: lastEnd + ANSWER_AFTER };
};

export const demoAt = (run: DemoRun, elapsed: number): DemoMoment => {
  const times = demoTimes(run);
  const typed = Math.min(run.prompt.length, Math.max(0, Math.floor((elapsed - TYPE_FROM) / TYPE_MS)));
  const agents = times.agents.map(({ starts, ends }) => ({
    phase:
      elapsed >= ends ? ("done" as const) : elapsed >= starts ? ("working" as const) : ("waiting" as const),
    progress: Math.min(1, Math.max(0, (elapsed - starts) / (ends - starts))),
  }));
  const answered = elapsed >= times.answered;
  const lead: LeadPhase = answered
    ? "done"
    : elapsed < times.sent
      ? "idle"
      : elapsed < times.handoff
        ? "reading"
        : agents.every((agent) => agent.phase === "done")
          ? "answering"
          : "delegating";
  return { typed, sent: elapsed >= times.sent, lead, agents, answered, finished: answered };
};

/** What the lead's line under the mark says. */
export const leadStatus = (moment: DemoMoment): string => {
  const working = moment.agents.filter((agent) => agent.phase !== "done").length;
  switch (moment.lead) {
    case "idle":
      return "Waiting for you";
    case "reading":
      return "Reading the job";
    case "delegating":
      return moment.agents.every((agent) => agent.phase !== "waiting")
        ? `Waiting on ${working} ${working === 1 ? "agent" : "agents"}`
        : `Handing off ${moment.agents.length} parts`;
    case "answering":
      return "Writing the answer";
    case "done":
      return "Done";
  }
};
