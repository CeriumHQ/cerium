import { Button } from "@base-ui/react/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { CeriumMark } from "../../components/CeriumMark.tsx";
import { keyCaps } from "../../lib/keys.ts";
import { Agents } from "./chapters/Agents.tsx";
import { Everywhere } from "./chapters/Everywhere.tsx";
import { Glass } from "./chapters/Glass.tsx";
import { Hello } from "./chapters/Hello.tsx";
import { Ready } from "./chapters/Ready.tsx";
import { Thread } from "./chapters/Thread.tsx";
import { CHAPTERS, chapterFromQuery, stepChapter, welcomeKey, type ChapterId } from "./model.ts";
import { Keycap } from "./parts.tsx";
import { lightOf, SceneProvider, usePose } from "./scene.tsx";

/** How long a chapter takes to go, while the next one comes in after it. */
const LEAVE_MS = 520;
/**
 * How long a chapter takes to come in, every part of it. Its parts' animations end then, so nothing on
 * the stage stays blurred or lifted, and a pane's glass blurs what's behind it again.
 */
const ENTER_MS = 2_600;
/** How long the welcome takes to close: its chapter fades, and the light gathers into the mark at its corner. */
const CLOSE_MS = 520;

/** What each chapter is handed by the stage. */
export interface ChapterProps {
  readonly number: number;
  /** The headline's id, which names the welcome while the chapter shows. */
  readonly titleId: string;
  /** The chapter is the one showing, not the one on its way out. */
  readonly active: boolean;
  /** Moves on to the next chapter. */
  readonly onNext: () => void;
  /** Goes to another chapter. */
  readonly onGo: (chapter: ChapterId) => void;
}

/**
 * The welcome: a full window of glass with a chapter at a time on it, the light behind them all, and
 * the rail of chapters and the way on at its foot. It opens on a computer's first run, once the launch
 * screen gives way, and again from the command palette. Finishing or skipping it hands the window over.
 */
export function Welcome({ onDone }: { readonly onDone: () => void }) {
  const [entry, setEntry] = useState(() => ({
    index: (import.meta.env.DEV ? chapterFromQuery(location.search) : 0) ?? 0,
    /** It came in as another chapter went, so it waits for that one to go first. */
    after: false,
  }));
  const index = entry.index;
  /** The chapter on its way out, and which way the welcome is going. */
  const [leaving, setLeaving] = useState<{ readonly index: number; readonly direction: 1 | -1 }>();
  /** The chapter whose parts have all come in. */
  const [settled, setSettled] = useState<number>();
  const [visited, setVisited] = useState(index);
  const stage = useRef<HTMLDialogElement>(null);
  const last = index === CHAPTERS.length - 1;

  const go = (to: number) => {
    if (to === index || to < 0 || to >= CHAPTERS.length) return;
    setLeaving({ index, direction: to > index ? 1 : -1 });
    setEntry({ index: to, after: true });
    // A chapter come back to comes in again, however soon.
    setSettled(undefined);
    setVisited((most) => Math.max(most, to));
  };
  /** The welcome is closing, for good: the light gathers into the corner's mark, and the window is handed over. */
  const [closing, setClosing] = useState(false);
  const close = () => setClosing(true);
  const next = () => (last ? close() : go(stepChapter(index, 1)));
  const back = () => go(stepChapter(index, -1));
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
    const timer = setTimeout(() => setSettled(index), ENTER_MS);
    return () => clearTimeout(timer);
  }, [index]);

  // The headline takes focus as each chapter comes in, so a screen reader reads where the welcome is.
  useEffect(() => {
    stage.current
      ?.querySelector<HTMLElement>(`#${titleIdOf(CHAPTERS[index]!.id)}`)
      ?.focus({ preventScroll: true });
  }, [index]);

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
    ...(leaving === undefined ? [] : [{ at: leaving.index, state: "leave" as const }]),
    { at: index, state: settled === index ? ("shown" as const) : ("enter" as const) },
  ];
  return (
    // Open as the page's own layer rather than the top layer, so the dialogs a harness's sign-in opens
    // show over it; the window under it is inert meanwhile, so it's as modal as one.
    // Focusable itself, so a click on its glass keeps the keys on the welcome.
    <dialog
      open
      ref={stage}
      tabIndex={-1}
      onKeyDown={onKey}
      aria-modal="true"
      aria-labelledby={titleIdOf(CHAPTERS[index]!.id)}
      data-welcome=""
      data-direction={leaving?.direction === -1 ? "back" : "forward"}
      data-closing={closing ? "" : undefined}
      className="fixed inset-0 m-0 size-full max-h-none max-w-none overflow-hidden border-0 bg-surface-window p-0 text-fg-primary outline-none"
    >
      <SceneProvider className="flex flex-col">
        {/* The window can be moved by its top edge; the system draws its buttons over the right of it. */}
        <div className="absolute inset-x-0 top-0 h-10 [app-region:drag]" />
        <header className="relative flex h-10 shrink-0 items-center gap-2 pl-[calc(var(--titlebar-inset)+6px)]">
          <span data-light="corner" className="flex">
            <CeriumMark size={18} landing className="text-fg-primary" />
          </span>
          <span className="text-[13px] font-medium tracking-tight text-fg-secondary">Cerium</span>
        </header>
        <Finale active={closing} />

        <main className="relative grid min-h-0 flex-1">
          {shown.map(({ at, state }) => {
            const chapter = CHAPTERS[at]!;
            return (
              <section
                key={chapter.id}
                data-chapter={chapter.id}
                data-state={state}
                data-after={entry.after ? "" : undefined}
                aria-hidden={state === "leave" ? true : undefined}
                inert={state === "leave"}
                className="col-start-1 row-start-1 min-h-0"
              >
                <Chapter
                  id={chapter.id}
                  number={at + 1}
                  titleId={titleIdOf(chapter.id)}
                  active={state !== "leave" && !closing}
                  onNext={next}
                  onGo={(chapter) => go(CHAPTERS.findIndex((each) => each.id === chapter))}
                />
              </section>
            );
          })}
        </main>

        <footer className="relative flex shrink-0 items-end gap-8 px-(--welcome-gutter) pt-4 pb-6">
          <Rail index={index} visited={visited} onPick={go} />
          <div className="flex shrink-0 items-center gap-2">
            {last ? null : (
              <Button
                onClick={close}
                className="mr-2 h-9 rounded-full px-3 text-[12.5px] text-fg-tertiary transition-colors hover:text-fg-primary"
              >
                Skip
              </Button>
            )}
            {index === 0 ? (
              // Where Back will be: until the welcome is first moved on, that the keys work as the button does.
              <span
                className={`flex h-10 items-center gap-1.5 pr-1 text-[11.5px] text-fg-tertiary transition-opacity duration-500 max-md:hidden ${
                  visited === 0 ? "" : "opacity-0"
                }`}
              >
                Press
                <Keycap>{keyCaps("Enter").join("")}</Keycap>
              </span>
            ) : (
              <Button
                onClick={back}
                aria-label="Back"
                className="grid size-10 place-items-center rounded-full border border-line-subtle text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
              >
                <ArrowLeft size={16} strokeWidth={1.5} />
              </Button>
            )}
            <ContinueButton onClick={next}>
              {last ? "Open Cerium" : index === 0 ? "Begin" : "Continue"}
            </ContinueButton>
          </div>
        </footer>
      </SceneProvider>
    </dialog>
  );
}

const titleIdOf = (chapter: ChapterId) => `welcome-${chapter}`;

/** As the welcome closes, the light goes out and the glass mark flies into the corner's, shrinking to it. */
function Finale({ active }: { readonly active: boolean }) {
  usePose(active, (stage) => {
    const place = lightOf(stage, "corner");
    // The corner's mark draws its ring's centre at the middle of its square.
    const at =
      place === undefined
        ? { x: 24, y: 20 }
        : { x: place.x + place.width / 2, y: place.y + place.height / 2 };
    return {
      mark: { ...at, size: place?.width ?? 18, opacity: 0 },
      incoming: { from: at, intensity: 0 },
      beams: [0, 1, 2, 3, 4].map(() => ({ ...at, intensity: 0 })),
      dust: 0,
    };
  });
  return null;
}

/** The chapters along the foot: a hairline each, filled up to where the welcome is, its name above. */
function Rail({
  index,
  visited,
  onPick,
}: {
  readonly index: number;
  /** The furthest chapter seen, which the rail can go back to. */
  readonly visited: number;
  readonly onPick: (index: number) => void;
}) {
  return (
    <nav aria-label="Welcome chapters" className="flex min-w-0 flex-1 gap-1.5">
      {CHAPTERS.map((chapter, at) => (
        <button
          key={chapter.id}
          type="button"
          onClick={() => onPick(at)}
          disabled={at > visited}
          aria-current={at === index ? "step" : undefined}
          aria-label={`${chapter.label}, ${at + 1} of ${CHAPTERS.length}`}
          className="group flex min-w-0 flex-1 flex-col gap-2.5 pb-1 text-left disabled:cursor-default"
        >
          <span
            className={`flex items-baseline gap-2 truncate font-mono text-[10.5px] tracking-[0.16em] uppercase transition-colors duration-300 ${
              at === index
                ? "text-fg-primary"
                : at <= visited
                  ? "text-fg-tertiary group-hover:text-fg-secondary"
                  : "text-fg-disabled"
            }`}
          >
            <span className="tabular-nums opacity-60">{String(at + 1).padStart(2, "0")}</span>
            <span className="truncate max-lg:hidden">{chapter.label}</span>
          </span>
          <span className="relative h-px w-full overflow-hidden bg-line-strong">
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
      className="group flex h-10 items-center gap-2.5 rounded-full bg-accent pr-2 pl-5 text-[13px] font-medium text-accent-fg transition-[translate,opacity] duration-300 ease-out-soft hover:opacity-95 active:opacity-85 motion-reduce:transition-none"
    >
      {children}
      <span className="grid size-6.5 place-items-center rounded-full bg-accent-fg/12 transition-transform duration-300 ease-out-soft group-hover:translate-x-0.5">
        <ArrowRight size={14} strokeWidth={1.75} />
      </span>
    </Button>
  );
}

function Chapter({ id, ...props }: ChapterProps & { readonly id: ChapterId }) {
  switch (id) {
    case "hello":
      return <Hello {...props} />;
    case "glass":
      return <Glass {...props} />;
    case "thread":
      return <Thread {...props} />;
    case "agents":
      return <Agents {...props} />;
    case "everywhere":
      return <Everywhere {...props} />;
    case "ready":
      return <Ready {...props} />;
  }
}
