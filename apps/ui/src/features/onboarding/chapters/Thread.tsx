import { OFFERED_PROVIDERS } from "@cerium/protocol";
import { Check, RotateCcw } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

import { ProviderLogo } from "../../../components/ProviderLogo.tsx";
import { harnessName } from "../../settings/Harnesses.tsx";
import {
  DEMO_LEAD,
  DEMO_RUNS,
  demoAt,
  demoTimes,
  leadStatus,
  type DemoMoment,
  type DemoRun,
} from "../demo.ts";
import { Eyebrow, Headline, Reveal } from "../parts.tsx";
import { lightOf, markIn, usePose, usePulse, type Posing } from "../scene.tsx";
import type { ChapterProps } from "../Welcome.tsx";

/** How long after the chapter comes in its sample starts, so the message types once it's in view. */
const START_AFTER = 1_100;

/**
 * The message is the light: once sent, it falls from the message into the mark at the lead, and the
 * beams of the harnesses the lead hands parts to reach out to their cards, bright while they work.
 */
const pose =
  (run: DemoRun, moment: DemoMoment): Posing =>
  (stage) => {
    const { facet, ...mark } = markIn(stage, "thread", {
      x: stage.width * 0.6,
      y: stage.height * 0.5,
      size: 140,
    });
    const message = lightOf(stage, "message", "thread");
    return {
      mark: { ...mark, opacity: 1 },
      incoming: {
        from:
          message === undefined
            ? { x: stage.width, y: 0 }
            : { x: message.x + 24, y: message.y + message.height - 6 },
        intensity: moment.sent ? 1 : 0,
      },
      beams: OFFERED_PROVIDERS.map((provider) => {
        const index = run.agents.findIndex((agent) => agent.provider === provider);
        const card = index === -1 ? undefined : lightOf(stage, provider, "thread");
        const agent = moment.agents[index];
        if (card === undefined || agent === undefined) return { ...facet, intensity: 0 };
        return {
          x: card.x + 2,
          y: card.y + card.height / 2,
          intensity: agent.phase === "working" ? 1 : agent.phase === "done" ? 0.4 : 0,
        };
      }),
      dust: 0.8,
    };
  };

/** The third chapter: a sample of a lead handing a job out to agents of other harnesses, replayable. */
export function Thread({ number, titleId, active }: ChapterProps) {
  const [runIndex, setRunIndex] = useState(0);
  const run = DEMO_RUNS[runIndex]!;
  /** How many times the sample has been asked to play again. */
  const [plays, setPlays] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // Without motion, the sample shows as it ends.
  const [reduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const moment = demoAt(run, reduced ? Number.POSITIVE_INFINITY : elapsed);
  const pulse = usePulse();

  // The sample's clock: it starts once the chapter is in, again on each replay, and stops once the run
  // has played out.
  const total = demoTimes(run).answered + 100;
  useEffect(() => {
    if (!active || reduced) return;
    let frame = 0;
    let from = 0;
    const tick = (now: number) => {
      setElapsed(now - from);
      if (now - from < total) frame = requestAnimationFrame(tick);
    };
    const timer = setTimeout(
      () => {
        from = performance.now();
        frame = requestAnimationFrame(tick);
      },
      plays === 0 ? START_AFTER : 120,
    );
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [active, plays, total, reduced]);
  useEffect(() => {
    if (moment.sent && !reduced) pulse();
  }, [moment.sent, pulse, reduced]);

  const replay = (index: number) => {
    setRunIndex(index);
    setElapsed(0);
    setPlays((count) => count + 1);
  };

  usePose(
    active,
    pose(run, moment),
    `${run.id}:${moment.sent}:${moment.agents.map((agent) => agent.phase).join()}`,
  );

  return (
    <div className="grid h-full grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-center gap-[clamp(24px,5vw,96px)] px-(--welcome-gutter) pb-[2vh]">
      <div className="flex flex-col">
        <Eyebrow number={number}>How it works</Eyebrow>
        <Headline
          id={titleId}
          lines={["Ask once."]}
          className="text-[length:clamp(48px,min(6.6vw,11vh),112px)]"
        />
        <Reveal
          order={3}
          as="p"
          className="mt-[clamp(18px,3.4vh,32px)] max-w-[26rem] text-[15px] leading-relaxed text-fg-secondary"
        >
          Your lead reads the job and hands each part to the agent that does it best, in any harness you're
          signed in to. They work at once, warn each other before touching the same files, and report back to
          the lead.
        </Reveal>
        <Reveal order={4} className="mt-[clamp(22px,4vh,40px)] flex flex-wrap items-center gap-2">
          <span className="mr-1 font-mono text-[10.5px] tracking-[0.16em] text-fg-tertiary uppercase">
            Try
          </span>
          {DEMO_RUNS.map((each, index) => (
            <button
              key={each.id}
              type="button"
              onClick={() => replay(index)}
              aria-pressed={index === runIndex}
              className="flex h-8 items-center gap-1.5 rounded-full border border-line-subtle px-3.5 text-[12.5px] text-fg-secondary transition-colors hover:border-line-strong hover:text-fg-primary aria-pressed:border-line-strong aria-pressed:bg-surface-raised aria-pressed:text-fg-primary"
            >
              {index === runIndex && moment.finished ? <RotateCcw size={12} strokeWidth={1.75} /> : null}
              {each.label}
            </button>
          ))}
        </Reveal>
      </div>

      <div className="flex min-w-0 flex-col gap-[clamp(14px,2.6vh,28px)]" aria-live="polite">
        <Reveal order={2} className="flex justify-end">
          <div
            data-light="message"
            className="max-w-[min(30rem,100%)] rounded-2xl rounded-br-md border border-line-subtle bg-surface-raised px-4 py-3 text-[14px] leading-relaxed text-fg-primary shadow-raised backdrop-blur-xl"
          >
            <span className="sr-only">{run.prompt}</span>
            {/* Typed a letter at a time, with the rest held unseen so the bubble keeps its size. */}
            <span aria-hidden="true">
              {run.prompt.slice(0, moment.typed)}
              {moment.sent ? null : (
                <span className="relative inline-block w-0 align-baseline">
                  <span className="absolute -top-[0.95em] left-0 h-[1.15em] w-px animate-pulse bg-fg-primary" />
                </span>
              )}
              <span className="invisible">{run.prompt.slice(moment.typed)}</span>
            </span>
          </div>
        </Reveal>

        <div className="grid grid-cols-[clamp(104px,12vw,180px)_minmax(0,1fr)] items-center gap-x-[clamp(28px,5vw,88px)]">
          <Reveal order={3} className="flex flex-col items-center gap-3">
            {/* The light draws the mark here. */}
            <div data-light="mark" className="aspect-square w-full" />
            <div className="flex flex-col items-center gap-0.5 text-center">
              <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg-primary">
                <ProviderLogo provider={DEMO_LEAD} size={13} />
                {harnessName[DEMO_LEAD]}
              </span>
              <span
                key={leadStatus(moment)}
                className={`animate-[launch-fade_400ms_ease-out_both] text-[12px] ${
                  moment.lead === "done" || moment.lead === "idle" ? "text-fg-tertiary" : "text-shimmer"
                }`}
              >
                Lead · {leadStatus(moment)}
              </span>
            </div>
          </Reveal>

          <ul className="flex flex-col gap-[clamp(8px,1.4vh,14px)]">
            {run.agents.map((agent, index) => {
              const state = moment.agents[index]!;
              return (
                <li
                  key={`${run.id}:${agent.provider}`}
                  data-light={agent.provider}
                  data-phase={state.phase}
                  className="relative overflow-hidden rounded-2xl border border-line-subtle bg-surface-raised shadow-raised backdrop-blur-xl transition-[opacity,translate,filter] duration-700 ease-out-soft data-[phase=waiting]:translate-x-4 data-[phase=waiting]:opacity-0 data-[phase=waiting]:blur-sm"
                >
                  <div className="flex items-center gap-3 px-3.5 py-[clamp(9px,1.5vh,13px)]">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-panel text-fg-primary">
                      <ProviderLogo provider={agent.provider} size={15} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-baseline gap-2 truncate">
                        <span className="text-[13px] font-medium text-fg-primary">
                          {harnessName[agent.provider]}
                        </span>
                        <span className="truncate font-mono text-[11px] text-fg-tertiary">{agent.file}</span>
                      </span>
                      <span
                        key={state.phase}
                        className={`truncate animate-[launch-fade_400ms_ease-out_both] text-[12.5px] ${
                          state.phase === "done" ? "text-fg-secondary" : "text-shimmer"
                        }`}
                      >
                        {state.phase === "done" ? agent.result : agent.task}
                      </span>
                    </div>
                    <span className="grid size-6 shrink-0 place-items-center">
                      {state.phase === "done" ? (
                        <Check
                          size={15}
                          strokeWidth={2}
                          className="animate-[launch-settle_500ms_var(--ease-out-soft)_both] text-success"
                        />
                      ) : (
                        <span className="size-1.5 animate-pulse rounded-full bg-running" />
                      )}
                    </span>
                  </div>
                  <span
                    aria-hidden="true"
                    style={{ scale: `${state.progress} 1` } as CSSProperties}
                    className="absolute inset-x-0 bottom-0 h-px origin-left bg-fg-tertiary/60"
                  />
                </li>
              );
            })}
          </ul>
        </div>

        <div
          data-shown={moment.answered ? "" : undefined}
          className="ml-[calc(clamp(104px,12vw,180px)+clamp(28px,5vw,88px))] flex flex-col gap-2 opacity-0 transition-[opacity,translate] duration-700 ease-out-soft not-data-shown:translate-y-2 data-shown:opacity-100"
        >
          <p className="text-[14px] leading-relaxed text-fg-primary">{run.answer}</p>
          <span className="flex flex-wrap items-center gap-x-2 font-mono text-[11.5px] whitespace-nowrap text-fg-tertiary">
            <span className="text-success">+{run.added}</span>
            <span className="text-error">−{run.removed}</span>
            <span>· {run.files} files</span>
            <span>· a sample, nothing ran</span>
          </span>
        </div>
      </div>
    </div>
  );
}
