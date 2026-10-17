import { HarnessFailure } from "@cerium/harness";
import { spawnMspConnection, type Connection, type SpawnedMspConnection } from "@muse-code/sdk";
import type { ClientCapabilities } from "@muse-code/sdk/dist/src/msp.js";
import { Effect } from "effect";

// One `muse serve` process and its MSP handshake. Sessions, the probe and the model listing each own a
// host for as long as they need it; closing the scope ends the process.

const CLIENT_INFO = { name: "cerium", title: "Cerium", version: "0.0.0" };

/** How long `muse serve` may drain (cancel its run, write `SessionEnd`) after stdin closes. */
const SHUTDOWN_DRAIN_MS = 5_000;

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "muse", message, cause });

class StderrTail {
  #text = "";
  push(chunk: string) {
    this.#text = (this.#text + chunk).slice(-4_000);
  }
  lastLine() {
    return this.#text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .at(0);
  }
}

export interface MuseHost {
  readonly spawned: SpawnedMspConnection;
  readonly connection: Connection;
}

export interface HostOptions {
  readonly cwd?: string;
  readonly capabilities: ClientCapabilities;
}

/** Spawns `muse serve` and completes the handshake. The host closes with the enclosing scope. */
export const openHost = (executablePath: string, args: ReadonlyArray<string>, options: HostOptions) =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const stderr = new StderrTail();
      const handshake = spawnMspConnection({
        command: executablePath,
        args,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        onStderr: (chunk) => stderr.push(chunk),
        shutdownTimeoutMs: SHUTDOWN_DRAIN_MS,
      });
      return Effect.tryPromise({
        try: async () => {
          try {
            return await handshake.initialize({
              clientInfo: CLIENT_INFO,
              capabilities: options.capabilities,
            });
          } catch (error) {
            // A failed handshake must not leak the process it spawned.
            await handshake.close().catch(() => undefined);
            throw error;
          }
        },
        // `muse serve` explains a refused run (an unknown `-c` key, a bad flag) on its first stderr line.
        catch: (cause) =>
          failure(`Could not start \`muse serve\`${stderr.lastLine() ? `: ${stderr.lastLine()}` : ""}`)(
            cause,
          ),
      });
    }),
    (spawned) =>
      Effect.promise(() =>
        spawned.close().then(
          () => undefined,
          () => undefined,
        ),
      ),
  ).pipe(Effect.map((spawned): MuseHost => ({ spawned, connection: spawned.connection })));

/** A read-only MSP query (no `commandId`). */
export const query = (host: MuseHost, method: string, params: Record<string, unknown> = {}) =>
  Effect.tryPromise({
    try: () => host.connection.request(method, params),
    catch: failure(`Muse Code refused \`${method}\``),
  });
