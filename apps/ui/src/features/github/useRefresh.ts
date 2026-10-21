import { useEffect, useEffectEvent } from "react";

/**
 * Runs `refresh` every `every` milliseconds while the window is showing, and once when the window
 * comes back to the front after `after` milliseconds or more without one. A hidden window spends
 * nothing: GitHub's rate limit is the user's.
 */
export function useRefresh(refresh: () => void, every: number, after: number) {
  const run = useEffectEvent(refresh);
  useEffect(() => {
    let last = Date.now();
    const refreshed = () => {
      last = Date.now();
      run();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshed();
    }, every);
    const returned = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= after) refreshed();
    };
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [every, after]);
}

/** Whether `error` is GitHub saying the account used up its requests for now. */
export const isRateLimited = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "reason" in error && error.reason === "rateLimited";
