import { Orchestrator, UserSettings } from "@cerium/orchestrator";
import type { EventPayload, ProviderId, ThreadOverview } from "@cerium/protocol";
import { type Duration, Effect, Layer, Queue, Stream } from "effect";
import { basename } from "node:path";

import { connectDiscord, discordPipes, type DiscordActivity, type DiscordConnection } from "./discordIpc.ts";

// Discord Rich Presence, when the user turns it on: their profile shows "Playing Cerium", how many
// agents are working and in which harnesses, and, if they ask for it, the folder they work in.
// Thread titles and messages never go to Discord. Discord not running is no error: Cerium looks for
// it again every little while, so starting Discord later picks the activity up.

/** Cerium's Discord application, whose name and art the profile shows. */
export const DISCORD_CLIENT_ID = "0000000000000000000";

/** The application's Rich Presence art the activity shows beside it. */
const LOGO_ASSET = "cerium";

/** How often Cerium looks for Discord and compares the activity even without events. */
const SWEEP_EVERY = "15 seconds";
/** Discord takes five activity updates in twenty seconds; a sent one waits this long for the next. */
const UPDATE_GAP = "4 seconds";
/** Discord's limit on an activity's lines. */
const MAX_LINE = 128;

/** Each provider's harness by the name its makers give it. */
export const harnessName: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  muse: "Muse Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/** The events that can change what the activity says: agents starting and stopping, and waits on the user. */
const changesActivity = new Set<EventPayload["_tag"]>([
  "AgentStateChanged",
  "PermissionRequested",
  "PermissionResolved",
  "QuestionAsked",
  "QuestionResolved",
  "SpawnApprovalRequested",
  "SpawnApprovalResolved",
]);

const line = (text: string) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text);

/** The agents running or about to, across every thread. */
const workingAgents = (overviews: ReadonlyArray<ThreadOverview>) =>
  overviews.flatMap(({ thread, agents }) =>
    agents
      .filter((agent) => agent.state === "running" || agent.state === "queued")
      .map((agent) => ({ agent, thread })),
  );

export const isWorking = (overviews: ReadonlyArray<ThreadOverview>) => workingAgents(overviews).length > 0;

/**
 * What Discord shows, given this machine's threads: how many agents work and in which harnesses
 * (the busiest first), else whether one waits for the user, else idle. `since` starts the timer.
 */
export const activityOf = (
  overviews: ReadonlyArray<ThreadOverview>,
  options: { readonly showProject: boolean; readonly since: number },
): DiscordActivity => {
  const working = workingAgents(overviews);
  const base = {
    timestamps: { start: options.since },
    assets: { large_image: LOGO_ASSET, large_text: "Cerium" },
  };
  if (working.length === 0) {
    const waiting = overviews.some((overview) => overview.awaitingApproval);
    return { ...base, details: waiting ? "Waiting for input" : "Idle" };
  }

  const count = working.length === 1 ? "1 agent working" : `${working.length} agents working`;
  const projects = [
    ...new Set(working.flatMap(({ thread }) => (thread.cwd === undefined ? [] : [basename(thread.cwd)]))),
  ];
  const where =
    !options.showProject || projects.length === 0
      ? ""
      : projects.length === 1
        ? ` in ${projects[0]}`
        : ` in ${projects.length} projects`;

  const byHarness = new Map<ProviderId, number>();
  for (const { agent } of working) byHarness.set(agent.provider, (byHarness.get(agent.provider) ?? 0) + 1);
  const harnesses = [...byHarness]
    .sort(([, a], [, b]) => b - a)
    .map(([provider]) => harnessName[provider])
    .join(" · ");

  return { ...base, details: line(`${count}${where}`), state: line(harnesses) };
};

/**
 * Keeps the user's Discord activity in step with this machine's agents while the setting is on, and
 * clears it when it's turned off or the backend stops. Requires `Orchestrator` and `UserSettings`.
 */
export const discordPresence = (
  options: {
    readonly clientId?: string;
    readonly pipes?: ReadonlyArray<string>;
    readonly updateGap?: Duration.Input;
  } = {},
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const settings = yield* UserSettings;
      const orchestrator = yield* Orchestrator;
      const clientId = options.clientId ?? DISCORD_CLIENT_ID;
      const pipes = options.pipes ?? discordPipes();
      const updateGap = options.updateGap ?? UPDATE_GAP;
      const kick = yield* Queue.sliding<void>(1);
      const startedAt = Date.now();

      let connection: DiscordConnection | undefined;
      /** The activity Discord shows now, as JSON. */
      let shown: string | undefined;
      /** When the agents last started working, after a time with none. */
      let workingSince: number | undefined;

      const disconnect = Effect.sync(() => {
        connection?.close();
        connection = undefined;
        shown = undefined;
      });

      /** Connects if need be and shows what's happening; resolves whether it sent anything. */
      const sync = Effect.gen(function* () {
        const { discord } = yield* settings.get;
        if (!discord.enabled) {
          yield* disconnect;
          return false;
        }
        const overviews = yield* orchestrator.threadOverviews;
        workingSince = isWorking(overviews) ? (workingSince ?? Date.now()) : undefined;
        const activity = activityOf(overviews, {
          showProject: discord.showProject,
          since: workingSince ?? startedAt,
        });
        const json = JSON.stringify(activity);

        let live = connection;
        if (live === undefined) {
          const opened = yield* Effect.tryPromise(() => connectDiscord(clientId, pipes));
          live = opened;
          connection = opened;
          shown = undefined;
          // Discord quitting: look for it again on the next sweep.
          void opened.closed.then(() => {
            if (connection === opened) {
              connection = undefined;
              shown = undefined;
            }
          });
        }
        if (json === shown) return false;
        yield* Effect.tryPromise(() => live.setActivity(activity));
        shown = json;
        return true;
      }).pipe(
        // Discord isn't running, or went away: nothing to show it on until a later sweep finds it.
        Effect.catch(() => disconnect.pipe(Effect.as(false))),
      );

      yield* Effect.addFinalizer(() => disconnect);

      yield* Queue.take(kick).pipe(
        Effect.andThen(sync),
        Effect.andThen((sent) => (sent ? Effect.sleep(updateGap) : Effect.void)),
        Effect.forever,
        Effect.forkScoped,
      );
      const poke = Queue.offer(kick, undefined);
      yield* settings.changes.pipe(
        Stream.runForEach(() => poke),
        Effect.forkScoped,
      );
      yield* orchestrator.events.pipe(
        Stream.filter((event) => changesActivity.has(event.payload._tag)),
        Stream.runForEach(() => poke),
        Effect.forkScoped,
      );
      yield* poke.pipe(Effect.andThen(Effect.sleep(SWEEP_EVERY)), Effect.forever, Effect.forkScoped);
    }),
  );
