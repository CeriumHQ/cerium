import type { ThreadSummary } from "../features/threads/model.ts";

// Development data for building components before the backend is wired in.

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

export const threadFixtures: ReadonlyArray<ThreadSummary> = [
  {
    id: "t1",
    title: "Fix flaky auth test",
    mode: "work",
    project: "cerium",
    status: "running",
    providers: ["claude", "muse", "muse"],
    unread: false,
    updatedAt: minutesAgo(1),
  },
  {
    id: "t2",
    title: "Redesign onboarding catalog flow",
    mode: "work",
    project: "cerium",
    status: "awaitingApproval",
    providers: ["claude", "codex"],
    unread: true,
    updatedAt: minutesAgo(12),
  },
  {
    id: "t3",
    title: "Babysit CI on release branch",
    mode: "work",
    project: "cerium",
    status: "idle",
    providers: ["claude"],
    unread: false,
    updatedAt: minutesAgo(95),
  },
  {
    id: "t4",
    title: "Port settings page to Base UI",
    mode: "work",
    project: "t3-fork",
    status: "failed",
    providers: ["cursor"],
    unread: false,
    updatedAt: minutesAgo(60 * 26),
  },
  {
    id: "t5",
    title: "Audit dependency licenses",
    mode: "work",
    project: "t3-fork",
    status: "idle",
    providers: ["codex", "claude"],
    unread: false,
    updatedAt: minutesAgo(60 * 50),
  },
  {
    id: "t6",
    title: "How does OKLCH chroma clipping work?",
    mode: "chat",
    status: "idle",
    providers: ["claude"],
    unread: false,
    updatedAt: minutesAgo(30),
  },
  {
    id: "t7",
    title: "Compare Effect RPC and tRPC",
    mode: "chat",
    status: "idle",
    providers: ["codex", "muse"],
    unread: true,
    updatedAt: minutesAgo(60 * 5),
  },
];
