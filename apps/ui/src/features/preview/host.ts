import type { BrowserCall, BrowserOutcome } from "@cerium/rpc";
import { applyOverviewUpdate, type ThreadOverview } from "@cerium/protocol";
import { Effect, Schedule, Stream } from "effect";

import { LocalBackend } from "../../backend/client.ts";
import { previewBridge } from "./model.ts";

// The desktop window hosts its threads' browsers for the agents: each call an agent makes on the
// bus reaches this window from its backend (`HostBrowser`), the shell runs it on the thread's page,
// and the window answers. The web client hosts none, and the agents hear the browser isn't here.

const isOutcome = (value: unknown): value is BrowserOutcome =>
  typeof value === "object" &&
  value !== null &&
  (((value as BrowserOutcome)._tag === "Done" && typeof (value as { text?: unknown }).text === "string") ||
    ((value as BrowserOutcome)._tag === "Failed" &&
      typeof (value as { message?: unknown }).message === "string"));

/** An agent opened a page in its thread's browser: the window shows the pane where it can. */
export interface AgentOpened {
  readonly seq: number;
  readonly threadId: string;
}

/** Always this computer's ownership, even while the window drives a different machine. */
export const previewOwnershipAtom = LocalBackend.runtime.atom(
  Stream.unwrap(
    LocalBackend.use((client) => Effect.succeed(client("WatchLocalThreadOverviews", undefined))),
  ).pipe(
    Stream.scan(() => [] as ReadonlyArray<ThreadOverview>, applyOverviewUpdate),
    Stream.tap((threads) =>
      Effect.sync(() =>
        previewBridge()?.threads?.(
          threads.map(({ thread, agents, awaitingApproval }) => ({
            id: thread.id,
            retired: thread.archivedAt !== undefined,
            active:
              awaitingApproval ||
              agents.some((agent) => agent.state === "queued" || agent.state === "running"),
          })),
        ),
      ),
    ),
    Stream.retry(Schedule.spaced("1 second")),
  ),
);

/**
 * Hosts the browser while mounted, and holds the latest thread an agent opened a page in. Mounted
 * only in the desktop app, whose shell holds the pages.
 */
export const browserHostAtom = LocalBackend.runtime.atom(
  Stream.unwrap(
    LocalBackend.use((client) =>
      Effect.succeed(
        client("HostBrowser", undefined).pipe(
          Stream.mapEffect(
            (call: BrowserCall | undefined): Effect.Effect<string | undefined> => {
              const bridge = previewBridge();
              // A call this window's version can't read has no id to answer; the agent's times out.
              if (call === undefined || bridge === undefined) return Effect.succeed(undefined);
              const opened: string | undefined = call.command._tag === "Open" ? call.threadId : undefined;
              return Effect.promise(() =>
                bridge.run(call.threadId, call.command).catch((error: unknown) => error),
              ).pipe(
                Effect.map((answer): BrowserOutcome =>
                  isOutcome(answer)
                    ? answer
                    : {
                        _tag: "Failed",
                        message: answer instanceof Error ? answer.message : "The browser failed.",
                      },
                ),
                Effect.flatMap((outcome) => client("AnswerBrowser", { requestId: call.requestId, outcome })),
                Effect.as(opened),
                Effect.orElseSucceed(() => undefined),
              );
            },
            { concurrency: "unbounded" },
          ),
        ),
      ),
    ),
  ).pipe(
    Stream.retry(Schedule.spaced("1 second")),
    Stream.filter((threadId: string | undefined): threadId is string => threadId !== undefined),
    Stream.scan(
      (): AgentOpened | undefined => undefined,
      (last: AgentOpened | undefined, threadId: string): AgentOpened | undefined => ({
        seq: (last?.seq ?? 0) + 1,
        threadId,
      }),
    ),
  ),
  { initialValue: undefined as AgentOpened | undefined },
);

/** Whether this window can host the browser: the desktop app's, whose shell holds the pages. */
export const hostsBrowser = (): boolean => previewBridge() !== undefined;
