import { useEffect, useEffectEvent } from "react";

import { shellBridge } from "../../backend/shell.ts";

// What the `cerium` command and `cerium://` links ask the running app for, as the shell passes it on
// (apps/desktop/src/launch.ts). The shell hands over each request once, to the first listener the page
// has; the listeners that want one kind or another register as their components mount, so a request
// nobody wants yet waits here until one does.

/** Mirrors the shell's `LaunchRequest`. */
export type LaunchRequest =
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "folder"; readonly folder: string }
  | { readonly kind: "prompt"; readonly folder: string; readonly text: string };

/** A listener says whether it took the request. */
type Listener = (request: LaunchRequest) => boolean;

const listeners = new Set<Listener>();
const waiting: LaunchRequest[] = [];
let listening = false;

const isRequest = (value: unknown): value is LaunchRequest => {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  switch (request["kind"]) {
    case "thread":
      return typeof request["id"] === "string";
    case "folder":
      return typeof request["folder"] === "string";
    case "prompt":
      return typeof request["folder"] === "string" && typeof request["text"] === "string";
    default:
      return false;
  }
};

const offer = (request: LaunchRequest) => {
  for (const listener of listeners) if (listener(request)) return;
  waiting.push(request);
};

/** Starts hearing the shell the first time a listener is added; it listens for the page's whole life. */
const listen = () => {
  if (listening) return;
  listening = true;
  shellBridge()?.onLaunch?.((request) => {
    if (isRequest(request)) offer(request);
  });
};

/** Hands `listener` the requests that came before it, and every one after, until the returned stop. */
export const onLaunchRequest = (listener: Listener): (() => void) => {
  listeners.add(listener);
  listen();
  for (const request of waiting.splice(0)) offer(request);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Runs `take` on each request of the kinds it handles, once it returns true for one; a request of
 * another kind goes to whoever wants it. `take` always sees the latest state.
 */
export function useLaunchRequests(take: Listener) {
  const latest = useEffectEvent(take);
  useEffect(() => onLaunchRequest((request) => latest(request)), []);
}
