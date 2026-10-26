import { Button } from "@base-ui/react/button";
import type { PastSession } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { harnessesAtom, pastSessionsAtom } from "../../backend/atoms.ts";
import { CeriumMark } from "../../components/CeriumMark.tsx";
import { useSessionImport, type SessionImport } from "../imports/SessionPicker.tsx";
import { Connect } from "./steps/Connect.tsx";
import { Glass } from "./steps/Glass.tsx";
import { Hello } from "./steps/Hello.tsx";
import { Import } from "./steps/Import.tsx";
import { needsHarness, stepFromQuery, stepsFor, welcomeKey, type StepId } from "./model.ts";

/** How long a step takes to go, while the next one comes in after it. */
const LEAVE_MS = 520;
/**
 * How long a step takes to come in, every part of it. Its parts' animations end then, so nothing on the
 * stage stays blurred or lifted, and a pane's glass blurs what's behind it again.
 */
const ENTER_MS = 2_600;
/** How long the welcome takes to close: its step and its foot fade, and the window is handed over. */
const CLOSE_MS = 420;

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

  const [entry, setEntry] = useState(() => ({
    step: asked ?? ("hello" as StepId),
    /** It came in as another step went, so it waits for that one to go first. */
    after: false,
  }));
  const index = Math.max(0, steps.indexOf(entry.step));
  const step = steps[index]!;
  const last = index === steps.length - 1;
  /** The step on its way out, and which way the welcome is going. */
  const [leaving, setLeaving] = useState<{ readonly step: StepId; readonly direction: 1 | -1 }>();
  /** The step whose parts have all come in. */
  const [settled, setSettled] = useState<StepId>();
  const [visited, setVisited] = useState(index);
  const stage = useRef<HTMLDialogElement>(null);

  const go = (to: number) => {
    const next = steps[to];
    if (next === undefined || to === index) return;
    setLeaving({ step, direction: to > index ? 1 : -1 });
    setEntry({ step: next, after: true });
    // A step come back to comes in again, however soon.
    setSettled(undefined);
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
    if (leaving === undefined) return;
    const timer = setTimeout(() => setLeaving(undefined), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(step), ENTER_MS);
    return () => clearTimeout(timer);
  }, [step]);

  // The headline takes focus as each step comes in, so a screen reader reads where the welcome is.
  useEffect(() => {
    stage.current?.querySelector<HTMLElement>(`#${titleIdOf(step)}`)?.focus({ preventScroll: true });
  }, [step]);

  /**
   * The welcome's keys, from anywhere on it. A dialog opened over it, such as a harness's sign-in,
   * keeps its own; every other key stops here, so the window under the welcome never acts on one.
   */
  const onKey = (event: React.KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (
      (target?.closest("dialog, [role='dialog'], [role='alertdialog']") ?? stage.current) !== stage.current
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

  const shown = [
    ...(leaving === undefined ? [] : [{ id: leaving.step, state: "leave" as const }]),
    { id: step, state: settled === step ? ("shown" as const) : ("enter" as const) },
  ];
  return (
    // Open as the page's own layer rather than the top layer, so the dialogs a harness's sign-in opens
    // show over it; the window under it is inert meanwhile, so it's as modal as one. Focusable itself,
    // so a click on its glass keeps the keys on the welcome.
    <dialog
      open
      ref={stage}
      tabIndex={-1}
      onKeyDown={onKey}
      aria-modal="true"
      aria-labelledby={titleIdOf(step)}
      data-welcome=""
      data-direction={leaving?.direction === -1 ? "back" : "forward"}
      data-closing={closing ? "" : undefined}
      className="fixed inset-0 m-0 flex size-full max-h-none max-w-none flex-col overflow-hidden border-0 bg-surface-window p-0 text-fg-primary outline-none"
    >
      {/* The window can be moved by its top edge; the system draws its buttons over the right of it. */}
      <div className="absolute inset-x-0 top-0 h-10 [app-region:drag]" />
      <header className="relative flex h-10 shrink-0 items-center gap-2 pl-[calc(var(--titlebar-inset)+6px)]">
        {/* The mark that flies to and from the window's: the glass one while hello shows, else this. */}
        <CeriumMark size={18} landing={step !== "hello"} className="text-fg-primary" />
        <span className="text-body font-medium tracking-tight text-fg-secondary">Cerium</span>
      </header>

      <main className="relative grid min-h-0 flex-1">
        {shown.map(({ id, state }) => (
          <section
            key={id}
            data-step={id}
            data-state={state}
            data-after={entry.after ? "" : undefined}
            aria-hidden={state === "leave" ? true : undefined}
            inert={state === "leave"}
            className="col-start-1 row-start-1 min-h-0"
          >
            <Step
              id={id}
              number={steps.indexOf(id) + 1}
              titleId={titleIdOf(id)}
              active={state !== "leave" && !closing}
              sessions={offered}
              importer={importer}
            />
          </section>
        ))}
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
    </dialog>
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
      className="group flex h-10 items-center gap-2.5 rounded-full bg-accent pr-2 pl-5 text-body font-medium text-accent-fg transition-[translate,opacity] duration-300 ease-out-soft hover:opacity-95 active:opacity-85 motion-reduce:transition-none"
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
