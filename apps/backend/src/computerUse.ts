import { Computer } from "@cerium/computer";
import { Orchestrator, UserSettings } from "@cerium/orchestrator";
import { Effect, Layer, Stream } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

// Computer use on this machine (`@cerium/computer`): agent-desktop's builds go beside Cerium's
// worktrees in ~/.cerium, shared by every backend of this user, and its own state (sessions,
// snapshots) in a folder of Cerium's apart from any agent-desktop the user runs themselves.

/** The computer the bus's `computer_*` tools drive. Requires `ChildProcessSpawner`, `FileSystem` and `Path`. */
export const ComputerLive = Computer.layer({
  toolsDirectory: join(homedir(), ".cerium", "tools", "agent-desktop"),
  stateDirectory: join(homedir(), ".cerium", "agent-desktop"),
});

/**
 * Installs agent-desktop as soon as computer use is on, so the first call doesn't wait on it; ends
 * every agent's use the moment it's turned off; and lets a thread the user stopped use the computer
 * again once the user next writes in it. An agent whose turn ends stops counting as using it.
 */
export const computerUseFollowsUser = Layer.effectDiscard(
  Effect.gen(function* () {
    const computer = yield* Computer;
    const settings = yield* UserSettings;
    const orchestrator = yield* Orchestrator;
    yield* settings.changes.pipe(
      Stream.map((current) => current.computerUse.enabled),
      Stream.changes,
      Stream.runForEach((enabled) => (enabled ? computer.install.pipe(Effect.ignore) : computer.endAll)),
      Effect.forkScoped,
    );
    yield* orchestrator.events.pipe(
      Stream.filter(
        ({ payload }) =>
          payload._tag === "MessageQueued" ||
          (payload._tag === "TurnInput" && payload.items.some((item) => item._tag === "FromUser")),
      ),
      Stream.runForEach((event) => computer.resume(event.threadId)),
      Effect.forkScoped,
    );
    yield* orchestrator.events.pipe(
      Stream.filter(({ payload }) => payload._tag === "TurnCompleted"),
      Stream.runForEach((event) => computer.release(event.agentId)),
      Effect.forkScoped,
    );
  }),
);
