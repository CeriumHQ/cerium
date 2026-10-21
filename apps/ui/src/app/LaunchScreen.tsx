import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { accountAtom } from "../backend/atoms.ts";
import { connectionAtom, localConnectionAtom } from "../backend/client.ts";
import { machineAtom } from "../backend/machine.ts";
import { shellBridge } from "../backend/shell.ts";
import { WEB } from "../backend/target.ts";
import { CeriumMark } from "../components/CeriumMark.tsx";
import { themeSettled } from "../features/settings/theme.ts";
import { launchedAtom, launchProgress, launchStatus, type LaunchState } from "./launch.ts";

/** How long the mark takes to settle; the window is never handed over before it has. */
const SETTLE_MS = 700;
/** How long starting goes before the screen says what it waits on. */
const QUIET_MS = 1_400;
/** How long the full progress line holds before the window takes over. */
const FULL_MS = 280;
/** The window shows whatever it has by now, with its own notices for what's still missing. */
const GIVE_UP_MS = 12_000;
/** How much of the step under way the progress line creeps through while it waits, and how slowly. */
const CREEP = 0.7;
const CREEP_MS = 4_000;
const STEP_MS = 360;

/**
 * The window while Cerium starts: its glass, the mark settling into focus as if polished (cerium oxide
 * polishes glass), and a line that fills as each step of starting finishes. The window underneath
 * loads all along, unseen; when it's ready the mark flies to its place at the top of it and the window
 * fades in around it.
 */
export function Launch({ children }: { children: ReactNode }) {
  const [launching, setLaunching] = useState(true);
  const handOver = () => {
    const finish = () => flushSync(() => setLaunching(false));
    // Without view transitions the screen simply gives way; the types keep these styles to this one.
    if (document.startViewTransition === undefined) finish();
    else if ("types" in ViewTransition.prototype) {
      document.startViewTransition({ update: finish, types: ["launch"] });
    } else document.startViewTransition(finish);
  };
  return (
    <>
      {/* Mounted from the start, so it loads while the screen shows; kept the same element after. */}
      <div data-launching={launching ? "" : undefined} className={`h-full ${launching ? "opacity-0" : ""}`}>
        {children}
      </div>
      {launching ? <LaunchScreen onReady={handOver} /> : null}
    </>
  );
}

function LaunchScreen({ onReady }: { onReady: () => void }) {
  const driven = useAtomValue(machineAtom);
  const backend = useAtomValue(localConnectionAtom) === "connected";
  const account = AsyncResult.isSuccess(useAtomValue(accountAtom));
  const connection = useAtomValue(connectionAtom);
  const launched = useAtomValue(launchedAtom);
  const [shown, setShown] = useState(false);
  const [settled, setSettled] = useState(false);
  const [talking, setTalking] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const state: LaunchState = {
    backend,
    account,
    machine: WEB || driven !== undefined ? connection === "connected" : undefined,
    ready: launched || gaveUp,
  };
  const leaving = state.ready && settled;
  const { done, next } = launchProgress(state);

  // Shown once painted in the user's theme: the desktop shell opens the window then.
  useEffect(() => {
    let frame = 0;
    void themeSettled.then(() => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          shellBridge()?.windowReady?.();
          setShown(true);
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!shown) return;
    const timers = [
      setTimeout(() => setSettled(true), SETTLE_MS),
      setTimeout(() => setTalking(true), QUIET_MS),
      setTimeout(() => setGaveUp(true), GIVE_UP_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, [shown]);
  // Each finished step fills the line to it; then it creeps on through the next until that finishes.
  const target = leaving ? 1 : done;
  const [creepingFrom, setCreepingFrom] = useState<number>();
  const line =
    creepingFrom === target && !leaving
      ? { at: target + next * CREEP, ms: CREEP_MS }
      : { at: target, ms: STEP_MS };
  useEffect(() => {
    if (!shown) return;
    const creep = setTimeout(() => setCreepingFrom(target), STEP_MS);
    return () => clearTimeout(creep);
  }, [shown, target]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(onReady, STEP_MS + FULL_MS);
    return () => clearTimeout(timer);
  }, [leaving, onReady]);

  const status = launchStatus(state, { web: WEB, ...(driven ? { machineName: driven.name } : {}) });
  return (
    <div
      aria-busy="true"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-surface-window pb-10"
    >
      {/* The window can still be moved while it starts; the system draws its buttons over this. */}
      <div className="absolute inset-x-0 top-0 h-10 [app-region:drag]" />
      {shown ? (
        <>
          <CeriumMark
            size={64}
            landing
            className="animate-[launch-settle_700ms_var(--ease-out-soft)_both] text-fg-primary motion-reduce:animate-[launch-fade_300ms_ease-out_both]"
          />
          <div
            // A <progress> can't ease its fill from one step to the next.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="progressbar"
            aria-label="Starting Cerium"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(line.at * 100)}
            className="mt-10 h-0.5 w-24 animate-[launch-fade_400ms_ease-out_200ms_both] overflow-hidden rounded-full bg-line-subtle"
          >
            <div
              style={{ scale: `${line.at} 1`, transitionDuration: `${line.ms}ms` }}
              className="h-full origin-left rounded-full bg-accent transition-[scale] ease-out-soft motion-reduce:transition-none"
            />
          </div>
          {/* Said only once starting takes long enough to wonder about. */}
          <output
            key={talking ? status : "quiet"}
            className={`mt-4 h-4 text-[12.5px] leading-4 text-fg-tertiary ${
              talking ? "animate-[launch-fade_360ms_ease-out_both]" : "invisible"
            }`}
          >
            {status}
          </output>
        </>
      ) : null}
    </div>
  );
}
