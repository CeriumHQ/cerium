import { connect, type Socket } from "node:net";
import { join } from "node:path";

// Discord's local RPC: the desktop client listens on a named pipe (a Unix socket elsewhere), and
// apps talk to it in frames of an opcode, a length and JSON. Cerium only sets its activity, which
// needs no OAuth: the handshake names the Discord application whose name and art the profile shows.
// https://discord.com/developers/docs/topics/rpc

/** The frames' opcodes. */
export const Op = { handshake: 0, frame: 1, close: 2, ping: 3, pong: 4 } as const;

export interface Frame {
  readonly op: number;
  readonly payload: unknown;
}

/** An activity as `SET_ACTIVITY` takes it. */
export interface DiscordActivity {
  readonly details?: string;
  readonly state?: string;
  readonly timestamps?: { readonly start: number };
  readonly assets?: { readonly large_image?: string; readonly large_text?: string };
}

/** Discord running a version without the pipe, not running, or refusing the application. */
export class DiscordIpcError extends Error {
  override readonly name = "DiscordIpcError";
}

export const encodeFrame = (op: number, payload: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

/** Reads frames from a stream of chunks, which may split or join them anywhere. */
export class FrameReader {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): Array<Frame> {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: Array<Frame> = [];
    while (this.buffered.length >= 8) {
      const length = this.buffered.readUInt32LE(4);
      if (this.buffered.length < 8 + length) break;
      const op = this.buffered.readUInt32LE(0);
      const text = this.buffered.subarray(8, 8 + length).toString("utf8");
      this.buffered = this.buffered.subarray(8 + length);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
      frames.push({ op, payload });
    }
    return frames;
  }
}

/** Where Discord may listen: it takes the first free of ten. */
export const discordPipes = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Array<string> => {
  const base =
    platform === "win32"
      ? "\\\\?\\pipe"
      : (env["XDG_RUNTIME_DIR"] ?? env["TMPDIR"] ?? env["TMP"] ?? env["TEMP"] ?? "/tmp");
  return Array.from({ length: 10 }, (_, index) =>
    platform === "win32" ? `${base}\\discord-ipc-${index}` : join(base, `discord-ipc-${index}`),
  );
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** The `message` Discord gives a refusal, or `fallback`. */
const messageOf = (value: unknown, fallback: string) => {
  const message = field(value, "message");
  return typeof message === "string" && message !== "" ? message : fallback;
};

const open = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });

/** How long Discord gets to answer the handshake or a command. */
const ANSWER_WITHIN_MS = 5_000;

export interface DiscordConnection {
  /** Shows this activity on the user's profile, or none. */
  setActivity(activity: DiscordActivity | undefined): Promise<void>;
  /** Clears the activity Discord shows for this process and hangs up. */
  close(): void;
  /** Settles when the connection ends, from either side. */
  readonly closed: Promise<void>;
}

/**
 * Connects to the running Discord client as the given application. Rejects when Discord isn't
 * running or refuses the application.
 */
export const connectDiscord = async (
  clientId: string,
  pipes: ReadonlyArray<string> = discordPipes(),
): Promise<DiscordConnection> => {
  let socket: Socket | undefined;
  for (const path of pipes) {
    socket = await open(path).catch(() => undefined);
    if (socket !== undefined) break;
  }
  if (socket === undefined) throw new DiscordIpcError("Discord isn't running.");
  const live = socket;

  const reader = new FrameReader();
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let nonce = 0;
  let ready: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let ended = false;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  /** Ends the connection; `politely` says goodbye first, so Discord drops the activity at once. */
  const end = (reason: string, politely = false) => {
    if (ended) return;
    ended = true;
    const error = new DiscordIpcError(reason);
    ready?.reject(error);
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    if (politely) live.end(encodeFrame(Op.close, {}));
    else live.destroy();
    markClosed();
  };

  live.on("data", (chunk: Buffer) => {
    for (const { op, payload } of reader.push(chunk)) {
      if (op === Op.ping) live.write(encodeFrame(Op.pong, payload));
      else if (op === Op.close) end(messageOf(payload, "Discord closed the connection."));
      else if (op === Op.frame) {
        if (field(payload, "evt") === "READY") ready?.resolve();
        const id = field(payload, "nonce");
        const waiting = typeof id === "string" ? pending.get(id) : undefined;
        if (waiting === undefined || typeof id !== "string") continue;
        pending.delete(id);
        if (field(payload, "evt") === "ERROR")
          waiting.reject(
            new DiscordIpcError(messageOf(field(payload, "data"), "Discord refused the activity.")),
          );
        else waiting.resolve();
      }
    }
  });
  live.on("error", (error) => end(error.message));
  live.on("close", () => end("Discord closed the connection."));

  /** Waits for an answer, ending the connection if none comes in time. */
  const answer = (register: (waiting: { resolve: () => void; reject: (error: Error) => void }) => void) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => end("Discord didn't answer."), ANSWER_WITHIN_MS);
      register({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

  const handshake = answer((waiting) => {
    ready = waiting;
  });
  live.write(encodeFrame(Op.handshake, { v: 1, client_id: clientId }));
  await handshake;
  ready = undefined;

  const setActivity = (activity: DiscordActivity | undefined) => {
    if (ended) return Promise.reject(new DiscordIpcError("Discord closed the connection."));
    const id = String(++nonce);
    const sent = answer((waiting) => pending.set(id, waiting));
    live.write(
      encodeFrame(Op.frame, {
        cmd: "SET_ACTIVITY",
        args: activity === undefined ? { pid: process.pid } : { pid: process.pid, activity },
        nonce: id,
      }),
    );
    return sent;
  };

  return {
    setActivity,
    close: () => end("Closed.", true),
    closed,
  };
};
