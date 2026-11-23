import { EventEmitter } from "node:events";

// The port Electron gives a utility process to talk to the shell (apps/desktop/src/backend.ts);
// absent when the backend runs on its own, as it does in development.

export interface ParentPort {
  postMessage(message: unknown): void;
  off(event: "message", listener: (event: { readonly data: unknown }) => void): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
}

export const desktopPort: ParentPort | undefined = (process as { parentPort?: ParentPort }).parentPort;

/** A Node child process receives raw messages instead of Electron's message events. */
const forkPort = (): ParentPort | undefined => {
  if (!process.send) return undefined;
  const events = new EventEmitter();
  const receive = (data: unknown) => events.emit("message", { data });
  return {
    postMessage(message) {
      if (process.connected) process.send?.(message, () => {});
    },
    on(event, listener) {
      if (!events.listenerCount(event)) process.on(event, receive);
      events.on(event, listener);
    },
    off(event, listener) {
      events.off(event, listener);
      if (!events.listenerCount(event)) process.off(event, receive);
    },
  };
};

export const parentPort = desktopPort ?? forkPort();

/** The shell giving the backend the PATH the user's shell gave, which it started without. */
export const isSetPath = (message: unknown): message is { readonly _tag: "SetPath"; readonly path: string } =>
  typeof message === "object" &&
  message !== null &&
  (message as { _tag?: unknown })._tag === "SetPath" &&
  typeof (message as { path?: unknown }).path === "string";
