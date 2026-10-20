import { Orchestrator, UserSettings } from "@cerium/orchestrator";
import {
  defaultSettings,
  type AgentEvent,
  type AgentId,
  type AgentInfo,
  type ProviderId,
  type Settings,
  type ThreadId,
  type ThreadInfo,
  type ThreadOverview,
} from "@cerium/protocol";
import { afterEach, assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream, SubscriptionRef } from "effect";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activityOf, discordPresence } from "../src/discord.ts";
import { connectDiscord, discordPipes, encodeFrame, FrameReader, Op, type Frame } from "../src/discordIpc.ts";

const thread = (id: string, cwd?: string): ThreadInfo => ({
  id: id as ThreadId,
  title: "Secret plans",
  mode: cwd === undefined ? "chat" : "work",
  ...(cwd === undefined ? {} : { cwd }),
  createdAt: 1,
  updatedAt: 1,
});

const agent = (id: string, state: AgentInfo["state"], provider: ProviderId = "claude"): AgentInfo => ({
  id: id as AgentId,
  threadId: "thr_1" as ThreadId,
  role: "lead",
  provider,
  model: "opus",
  access: "ask",
  state,
  createdAt: 1,
  updatedAt: 1,
});

const overview = (
  info: ThreadInfo,
  agents: ReadonlyArray<AgentInfo>,
  awaitingApproval = false,
): ThreadOverview => ({ thread: info, agents, awaitingApproval });

describe("frames", () => {
  it("are read back across split and joined chunks", () => {
    const one = encodeFrame(Op.frame, { cmd: "A" });
    const two = encodeFrame(Op.ping, { n: 2 });
    const both = Buffer.concat([one, two]);
    const reader = new FrameReader();
    expect(reader.push(both.subarray(0, 5))).toEqual([]);
    expect(reader.push(both.subarray(5, one.length + 3))).toEqual([{ op: Op.frame, payload: { cmd: "A" } }]);
    expect(reader.push(both.subarray(one.length + 3))).toEqual([{ op: Op.ping, payload: { n: 2 } }]);
  });
});

describe("Discord's pipes", () => {
  it("are named pipes on Windows and sockets in the runtime folder elsewhere", () => {
    expect(discordPipes("win32", {})[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
    expect(discordPipes("linux", { XDG_RUNTIME_DIR: "/run/user/1000" })[9]).toBe(
      join("/run/user/1000", "discord-ipc-9"),
    );
  });
});

describe("the activity", () => {
  const since = 1_000;

  it("is idle with nothing working, or waiting when an agent asks the user", () => {
    expect(
      activityOf([overview(thread("a", "C:/code/cerium"), [agent("l", "idle")])], {
        showProject: true,
        since,
      }),
    ).toMatchObject({ details: "Idle", timestamps: { start: since } });
    expect(
      activityOf([overview(thread("a"), [agent("l", "idle")], true)], { showProject: false, since }).details,
    ).toBe("Waiting for input");
  });

  it("counts the working agents and names their harnesses, busiest first, without thread titles", () => {
    const activity = activityOf(
      [
        overview(thread("a", "C:/code/cerium"), [
          agent("l", "running", "codex"),
          agent("c1", "running", "claude"),
          agent("c2", "queued", "claude"),
          agent("c3", "idle", "cursor"),
        ]),
      ],
      { showProject: false, since },
    );
    expect(activity.details).toBe("3 agents working");
    expect(activity.state).toBe("Claude Code · Codex");
    expect(JSON.stringify(activity)).not.toContain("Secret plans");
    expect(`${activity.details} ${activity.state}`).not.toContain("cerium");
  });

  it("names the folder only when asked, or how many there are", () => {
    const one = [overview(thread("a", "C:/code/cerium"), [agent("l", "running")])];
    expect(activityOf(one, { showProject: true, since }).details).toBe("1 agent working in cerium");
    const two = [...one, overview(thread("b", "/home/me/site"), [agent("m", "running")])];
    expect(activityOf(two, { showProject: true, since }).details).toBe("2 agents working in 2 projects");
    // A chat thread has no folder to name.
    expect(
      activityOf([overview(thread("c"), [agent("l", "running")])], { showProject: true, since }).details,
    ).toBe("1 agent working");
  });

  it("cuts a long folder name to Discord's limit", () => {
    const long = [overview(thread("a", `C:/${"x".repeat(200)}`), [agent("l", "running")])];
    expect(activityOf(long, { showProject: true, since }).details?.length).toBe(128);
  });
});

/** A stand-in for the Discord client: answers the handshake and every command, and keeps what it got. */
const fakeDiscord = async (options: { readonly refuse?: string } = {}) => {
  const path =
    process.platform === "win32"
      ? `\\\\?\\pipe\\cerium-discord-test-${process.pid}-${Math.random().toString(36).slice(2)}`
      : join(tmpdir(), `cerium-discord-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  const received: Array<Frame> = [];
  const sockets = new Set<Socket>();
  let hangUps = 0;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const reader = new FrameReader();
    socket.on("close", () => {
      sockets.delete(socket);
      hangUps++;
    });
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        received.push(frame);
        const payload = frame.payload as { nonce?: string };
        if (frame.op === Op.handshake) {
          if (options.refuse !== undefined)
            socket.end(encodeFrame(Op.close, { code: 4000, message: options.refuse }));
          else socket.write(encodeFrame(Op.frame, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } }));
        } else if (frame.op === Op.frame) {
          socket.write(
            encodeFrame(Op.frame, { cmd: "SET_ACTIVITY", evt: null, nonce: payload.nonce, data: {} }),
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
  return {
    path,
    received,
    /** The activities set, `null` for a clear. */
    activities: () =>
      received
        .filter((frame) => frame.op === Op.frame)
        .map((frame) => (frame.payload as { args: { activity?: unknown } }).args.activity ?? null),
    connected: () => sockets.size,
    hangUps: () => hangUps,
    ping: () => {
      for (const socket of sockets) socket.write(encodeFrame(Op.ping, { at: 7 }));
    },
  };
};

const servers: Array<Server> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("the Discord connection", () => {
  it("shakes hands as the application, sets the activity and answers pings", async () => {
    const discord = await fakeDiscord();
    const connection = await connectDiscord("123", ["\\\\?\\pipe\\cerium-nobody-here", discord.path]);
    expect(discord.received[0]).toEqual({ op: Op.handshake, payload: { v: 1, client_id: "123" } });
    await connection.setActivity({ details: "Idle" });
    expect(discord.activities()).toEqual([{ details: "Idle" }]);
    discord.ping();
    await until(() => discord.received.some((frame) => frame.op === Op.pong));
    connection.close();
    await connection.closed;
    await until(() => discord.connected() === 0);
  });

  it("fails when Discord isn't running or refuses the application", async () => {
    await expect(connectDiscord("123", [join(tmpdir(), "cerium-no-discord.sock")])).rejects.toThrow(
      "Discord isn't running.",
    );
    const discord = await fakeDiscord({ refuse: "Invalid Client ID" });
    await expect(connectDiscord("bad", [discord.path])).rejects.toThrow("Invalid Client ID");
  });
});

describe("the presence", () => {
  /** The presence running against a fake Discord, with one agent working in `cerium`. */
  const presence = Effect.gen(function* () {
    const discord = yield* Effect.promise(() => fakeDiscord());
    const settings = yield* SubscriptionRef.make(defaultSettings);
    const events = yield* Queue.unbounded<AgentEvent>();
    const userSettings = Layer.succeed(UserSettings, {
      get: SubscriptionRef.get(settings),
      changes: SubscriptionRef.changes(settings),
    } as never);
    const orchestrator = Layer.succeed(Orchestrator, {
      events: Stream.fromQueue(events),
      threadOverviews: Effect.succeed([overview(thread("a", "C:/code/cerium"), [agent("l", "running")])]),
    } as never);
    yield* Layer.build(
      discordPresence({ clientId: "123", pipes: [discord.path], updateGap: "10 millis" }).pipe(
        Layer.provide(Layer.merge(userSettings, orchestrator)),
      ),
    );
    const turn = (discordSettings: Settings["discord"]) =>
      SubscriptionRef.update(settings, (current) => ({ ...current, discord: discordSettings }));
    return { discord, turn };
  });

  it.live("stays away from Discord until it's turned on, then shows the agents", () =>
    Effect.gen(function* () {
      const { discord, turn } = yield* presence;
      yield* Effect.sleep("100 millis");
      assert.deepStrictEqual(discord.received, []);
      yield* turn({ enabled: true, showProject: true });
      yield* Effect.promise(() => until(() => discord.activities().length > 0));
      assert.deepInclude(discord.activities()[0], {
        details: "1 agent working in cerium",
        state: "Claude Code",
        assets: { large_image: "cerium", large_text: "Cerium" },
      });
    }).pipe(Effect.scoped),
  );

  it.live("hangs up, clearing the activity, when it's turned off", () =>
    Effect.gen(function* () {
      const { discord, turn } = yield* presence;
      yield* turn({ enabled: true, showProject: false });
      yield* Effect.promise(() => until(() => discord.activities().length > 0));
      assert.deepInclude(discord.activities()[0], { details: "1 agent working" });
      yield* turn({ enabled: false, showProject: false });
      yield* Effect.promise(() => until(() => discord.hangUps() === 1));
      assert.strictEqual(discord.received.at(-1)?.op, Op.close);
    }).pipe(Effect.scoped),
  );
});
