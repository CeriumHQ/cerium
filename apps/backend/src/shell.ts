// The port Electron gives a utility process to talk to the shell (apps/desktop/src/backend.ts);
// absent when the backend runs on its own, as it does in development.

export interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
}

export const parentPort: ParentPort | undefined = (process as { parentPort?: ParentPort }).parentPort;

/** The shell giving the backend the PATH the user's shell gave, which it started without. */
export const isSetPath = (message: unknown): message is { readonly _tag: "SetPath"; readonly path: string } =>
  typeof message === "object" &&
  message !== null &&
  (message as { _tag?: unknown })._tag === "SetPath" &&
  typeof (message as { path?: unknown }).path === "string";
