import type { CSSProperties, ReactNode } from "react";

/**
 * A step's headline, a line at a time, set as a new thread's question is: large, light and
 * expanded. Coming in, each letter stretches out from narrow and sharpens, one after another; screen
 * readers read the line whole.
 */
export function Headline({
  lines,
  id,
  className = "",
  delay = 0,
}: {
  readonly lines: ReadonlyArray<string>;
  readonly id?: string;
  readonly className?: string;
  /** How many letters' worth of time it waits before its first letter. */
  readonly delay?: number;
}) {
  let letter = delay;
  return (
    <h1
      id={id}
      tabIndex={-1}
      className={`font-display leading-[1.02] font-extralight tracking-[-0.015em] font-stretch-expanded outline-none [font-size-adjust:none] ${className}`}
    >
      <span className="sr-only">{lines.join(" ")}</span>
      <span aria-hidden="true">
        {lines.map((line) => (
          <span key={line} className="block whitespace-nowrap">
            {line.split("").map((character, index) => (
              <span key={index} data-letter="" style={{ "--i": letter++ } as CSSProperties}>
                {character === " " ? " " : character}
              </span>
            ))}
          </span>
        ))}
      </span>
    </h1>
  );
}

/**
 * Comes in with its step, `order` steps after the headline starts, and goes with it: the
 * step's own lines, controls and pictures, each in its turn.
 */
export function Reveal({
  order,
  as: Tag = "div",
  className = "",
  children,
}: {
  readonly order: number;
  readonly as?: "div" | "p" | "span" | "li" | "ul";
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <Tag data-reveal="" style={{ "--d": order } as CSSProperties} className={className}>
      {children}
    </Tag>
  );
}

/** The small capitals over a step's headline: its number and what it's about. */
export function Eyebrow({ number, children }: { readonly number: number; readonly children: ReactNode }) {
  return (
    <Reveal
      order={0}
      className="mb-[clamp(14px,2.4vh,26px)] flex items-center gap-3 font-mono text-caption tracking-[0.18em] text-fg-tertiary uppercase"
    >
      <span className="text-fg-secondary tabular-nums">{String(number).padStart(2, "0")}</span>
      <span className="h-px w-8 bg-line-strong" />
      <span>{children}</span>
    </Reveal>
  );
}
