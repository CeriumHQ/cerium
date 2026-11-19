import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import type { PastSession } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { harnessesAtom, pastSessionsAtom } from "../../backend/atoms.ts";
import { CeriumMark } from "../../components/CeriumMark.tsx";
import { settled } from "../../lib/motion.ts";
import { useSessionImport, type SessionImport } from "../imports/SessionPicker.tsx";
import { Connect } from "./steps/Connect.tsx";
import { Glass } from "./steps/Glass.tsx";
import { Hello } from "./steps/Hello.tsx";
import { Import } from "./steps/Import.tsx";
import { needsHarness, stepFromQuery, stepsFor, welcomeKey, type StepId } from "./model.ts";

/** How long the longest entrance has to finish, even if the window hasn't painted it. */
const ENTER_MS = 2_600;
/** How long a step that turns back from its exit has to bring in any parts still on their way. */
const QUICK_MS = 240;
/** How long the welcome takes to close: its step and its foot fade, and the window is handed over. */
const CLOSE_MS = 420;

interface StepMotion {
  readonly step: StepId;
  readonly stagger: "first" | "after" | undefined;
}

interface Entry extends StepMotion {
  readonly back: boolean;
  readonly quick: boolean;
}

/** What each step is handed by the stage. */
export interface StepProps {
  readonly number: number;
  /** The headline's id, which names the welcome while the step shows. */
  readonly titleId: string;
  /** The step is the one showing, not the one on its way out. */
  readonly active: boolean;
}

/**
 * The welcome: a full window of glass with a step at a time on it, and the way on at its foot. It opens
 * on a computer's first run, once the launch screen gives way, and again from the command palette.
 * Finishing or skipping it hands the window over.
 */
export function Welcome({ onDone }: { readonly onDone: () => void }) {
  const asked = import.meta.env.DEV ? stepFromQuery(location.search) : undefined;
  const statuses = AsyncResult.getOrElse(useAtomValue(harnessesAtom), () => undefined);
  // Once it asks for a harness it keeps the step, even as one signs in there.
  const [asks, setAsks] = useState(asked === "connect");
  if (!asks && needsHarness(statuses)) setAsks(true);
  // The user's own sessions with the harnesses, which take a few seconds to list: once there are some,
  // the welcome offers to bring them in, and keeps the step as they come in.
  const sessions = AsyncResult.getOrElse(
    useAtomValue(pastSessionsAtom),
    (): ReadonlyArray<PastSession> => [],
  );
  const [offered, setOffered] = useState<ReadonlyArray<PastSession>>([]);
  if (offered.length === 0 && sessions.length > 0) setOffered(sessions);
  const importer = useSessionImport(offered);
  const steps = stepsFor(asks, offered.length > 0);

  const [entry, setEntry] = useState<Entry>(() => ({
    step: asked ?? "hello",
    stagger: "first",
    back: false,
    quick: false,
  }));
  const index = Math.max(0, steps.indexOf(entry.step));
  const step = steps[index]!;
  const last = index === steps.length - 1;
  /** Steps stay drawn until their own exits end, unless they turn back into view. */
  const [leaving, setLeaving] = useState<ReadonlyArray<StepMotion>>([]);
  const [rested, setRested] = useState<{ readonly entry: Entry; readonly step: StepId }>();
  const still = rested?.entry === entry && rested.step === step;
  const stagger = still ? undefined : entry.stagger;
  const [visited, setVisited] = useState(index);
  const dialog = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<HTMLElement | null>(null);

  const go = (to: number) => {
    const next = steps[to];
    if (next === undefined || to === index) return;
    const quick = !still || leaving.length > 0;
    const returning = leaving.find((exit) => exit.step === next);
    setLeaving((current) => [...current.filter((exit) => exit.step !== next), { step, stagger }]);
    setEntry({ step: next, stagger: quick ? returning?.stagger : "after", back: to < index, quick });
    setVisited((most) => Math.max(most, to));
  };
  /** The welcome is closing, for good: its step fades and the window is handed over. */
  const [closing, setClosing] = useState(false);
  const close = () => setClosing(true);
  /** On the import step, until the sessions are in, the way on brings the ticked ones in. */
  const importing = step === "import" && importer.state._tag !== "done";
  const picks = importer.picked.size;
  const next = () => {
    if (importing && picks > 0) {
      if (importer.state._tag !== "importing") void importer.start();
    } else if (last) close();
    else go(index + 1);
  };
  const back = () => go(index - 1);
  const done = useEffectEvent(onDone);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(
      () => done(),
      matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : CLOSE_MS,
    );
    return () => clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    let live = true;
    for (const exit of leaving) {
      const section = stage?.querySelector(`[data-step="${exit.step}"]`);
      if (!section) continue;
      void settled(section).then(() => {
        if (live) setLeaving((current) => current.filter((item) => item !== exit));
      });
    }
    return () => {
      live = false;
    };
  }, [leaving, stage]);

  useLayoutEffect(() => {
    const section = stage?.querySelector(`[data-step="${step}"]`);
    if (!section) return;
    const parts =
      entry.stagger === undefined ? [] : [...section.querySelectorAll("[data-letter], [data-reveal]")];
    const animations = parts
      .flatMap((part) => part.getAnimations())
      .filter((animation) => animation instanceof CSSAnimation && animation.playState !== "finished");
    // The parts stopped where they were as the step went out. Let them finish from there together
    // with the step's return, including any that were still waiting for their turn.
    if (entry.quick && animations.length > 0) {
      const remaining = Math.max(
        ...animations.map(
          (animation) =>
            Number(animation.effect?.getComputedTiming().endTime ?? 0) - Number(animation.currentTime),
        ),
      );
      const rate = Math.max(1, remaining / QUICK_MS);
      for (const animation of animations) animation.updatePlaybackRate(rate);
    }
    let live = true;
    const finish = () => {
      if (live) setRested({ entry, step });
    };
    const timer = setTimeout(finish, ENTER_MS);
    void Promise.allSettled([settled(section), ...animations.map((animation) => animation.finished)]).then(
      () => {
        clearTimeout(timer);
        finish();
      },
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [entry, stage, step]);

  // The headline takes focus as each step comes in, so a screen reader reads where the welcome is.
  useEffect(() => {
    stage?.querySelector<HTMLElement>(`#${titleIdOf(step)}`)?.focus({ preventScroll: true });
  }, [stage, step]);

  /**
   * The welcome's keys, from anywhere on it. A dialog opened over it, such as a harness's sign-in,
   * keeps its own; every other key stops here, so the window under the welcome never acts on one.
   */
  const onKey = (event: React.KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (
      (target?.closest("dialog, [role='dialog'], [role='alertdialog']") ?? dialog.current) !== dialog.current
    ) {
      return;
    }
    event.stopPropagation();
    const action = welcomeKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      inField: target?.closest("input, textarea, [contenteditable='true']") != null,
      inGroup: target?.closest("[role='radiogroup']") != null,
      // A theme is picked as it takes focus, so Enter on one moves on, as it does from the glass.
      onButton: target?.closest("button:not([role='radio']), a") != null,
    });
    if (action === undefined || closing) return;
    event.preventDefault();
    if (action === "next") next();
    else if (action === "back") back();
    else close();
  };

  /**
   * The step after this one, drawn all but invisibly under it once this one has come in. The GPU builds
   * the pipelines for each new kind of drawing the first time it meets it, stalling every frame while
   * it does, and on a computer's first run none are built yet: drawn while the screen is still, the
   * next step's are ready by the time it comes in, so its entrance doesn't stutter. It keeps its key,
   * so it becomes the step that comes in.
   */
  const upcoming = still && leaving.length === 0 && !closing ? steps[index + 1] : undefined;
  return (
    <Dialog.Root open disablePointerDismissal>
      <Dialog.Portal>
        <Dialog.Popup
          ref={dialog}
          tabIndex={-1}
          initialFocus={() =>
            dialog.current?.querySelector<HTMLElement>(`#${titleIdOf(step)}`) ?? dialog.current
          }
          onKeyDown={onKey}
          aria-modal="true"
          aria-labelledby={titleIdOf(step)}
          data-welcome=""
          data-direction={entry.back ? "back" : "forward"}
          data-quick={entry.quick ? "" : undefined}
          data-closing={closing ? "" : undefined}
          className="fixed inset-0 m-0 flex size-full max-h-none max-w-none flex-col overflow-hidden border-0 bg-surface-window p-0 text-fg-primary outline-none"
        >
          {/* The window can be moved by its top edge; the system draws its buttons over the right of it. */}
          <div className="absolute inset-x-0 top-0 h-10 [app-region:drag]" />
          <header className="relative flex h-10 shrink-0 items-center gap-2 pl-[calc(var(--titlebar-inset)+6px)]">
            {/* The mark that flies to and from the window's: the glass one while hello shows, else this. */}
            <CeriumMark size={18} landing={step !== "hello"} className="text-fg-primary" />
            <span className="font-display text-body leading-none font-semibold tracking-[0.02em] text-fg-secondary font-stretch-expanded [font-size-adjust:none]">
              cerium
            </span>
          </header>

          <main ref={setStage} className="relative grid min-h-0 flex-1">
            {steps.map((id, at) => {
              const active = id === step;
              const exit = leaving.find((item) => item.step === id);
              if (!active && !exit && id !== upcoming) return null;
              return (
                <section
                  key={id}
                  data-step={id}
                  data-state={active ? (still ? "shown" : "enter") : exit ? "leave" : "warm"}
                  data-stagger={active ? stagger : exit?.stagger}
                  aria-hidden={active ? undefined : true}
                  inert={!active}
                  className="col-start-1 row-start-1 min-h-0"
                >
                  <Step
                    id={id}
                    number={at + 1}
                    titleId={titleIdOf(id)}
                    active={active && !closing}
                    sessions={offered}
                    importer={importer}
                  />
                </section>
              );
            })}
          </main>

          <footer className="relative flex shrink-0 items-center gap-8 px-(--welcome-gutter) pt-4 pb-6">
            <Progress steps={steps} index={index} visited={visited} onPick={go} />
            <div className="flex shrink-0 items-center gap-2">
              {last && !(importing && picks > 0) ? null : (
                <Button
                  onClick={close}
                  className="mr-2 h-9 rounded-full px-3 text-meta text-fg-tertiary transition-colors hover:text-fg-primary"
                >
                  Skip
                </Button>
              )}
              {index === 0 ? null : (
                <Button
                  onClick={back}
                  aria-label="Back"
                  className="grid size-10 place-items-center rounded-full border border-line-subtle text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                >
                  <ArrowLeft size={16} strokeWidth={1.5} />
                </Button>
              )}
              <ContinueButton onClick={next}>
                {importing && picks > 0
                  ? importer.state._tag === "importing"
                    ? "Importing…"
                    : `Import ${picks}`
                  : last
                    ? "Open Cerium"
                    : index === 0
                      ? "Begin"
                      : "Continue"}
              </ContinueButton>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const titleIdOf = (step: StepId) => `welcome-${step}`;

/** Where the welcome is: a hairline a step, filled up to this one; a step seen is a click away. */
function Progress({
  steps,
  index,
  visited,
  onPick,
}: {
  readonly steps: ReadonlyArray<StepId>;
  readonly index: number;
  /** The furthest step seen. */
  readonly visited: number;
  readonly onPick: (index: number) => void;
}) {
  return (
    <nav aria-label="Welcome steps" className="flex min-w-0 flex-1 gap-1.5">
      {steps.map((step, at) => (
        <button
          key={step}
          type="button"
          onClick={() => onPick(at)}
          disabled={at > visited}
          aria-current={at === index ? "step" : undefined}
          aria-label={`Step ${at + 1} of ${steps.length}`}
          className="group relative h-6 w-12 disabled:cursor-default"
        >
          <span className="absolute inset-x-0 top-1/2 h-px overflow-hidden bg-line-strong">
            <span
              className="absolute inset-0 origin-left bg-fg-primary transition-[scale,opacity] duration-700 ease-out-soft"
              style={{ scale: `${at <= index ? 1 : 0} 1`, opacity: at === index ? 1 : 0.35 }}
            />
          </span>
        </button>
      ))}
    </nav>
  );
}

/** The way on: the accent's pill, which leans towards the pointer as it nears. */
function ContinueButton({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const lean = (event: React.PointerEvent) => {
    const element = button.current;
    if (element === null || event.pointerType !== "mouse") return;
    const box = element.getBoundingClientRect();
    const x = event.clientX - (box.left + box.width / 2);
    const y = event.clientY - (box.top + box.height / 2);
    element.style.translate = `${x * 0.18}px ${y * 0.28}px`;
  };
  const settle = () => {
    if (button.current) button.current.style.translate = "";
  };
  return (
    <Button
      ref={button}
      onClick={onClick}
      onPointerMove={lean}
      onPointerLeave={settle}
      className="group flex h-10 items-center gap-2.5 rounded-full bg-accent pr-2 pl-5 text-body font-medium text-accent-fg transition-[translate,opacity] duration-300 ease-out-soft hover:opacity-90 active:opacity-80 motion-reduce:transition-none"
    >
      {children}
      <span className="grid size-6.5 place-items-center rounded-full bg-accent-fg/12 transition-transform duration-300 ease-out-soft group-hover:translate-x-0.5">
        <ArrowRight size={14} strokeWidth={1.75} />
      </span>
    </Button>
  );
}

function Step({
  id,
  sessions,
  importer,
  ...props
}: StepProps & {
  readonly id: StepId;
  readonly sessions: ReadonlyArray<PastSession>;
  readonly importer: SessionImport;
}) {
  switch (id) {
    case "hello":
      return <Hello {...props} />;
    case "glass":
      return <Glass {...props} />;
    case "connect":
      return <Connect {...props} />;
    case "import":
      return <Import {...props} sessions={sessions} importer={importer} />;
  }
}
