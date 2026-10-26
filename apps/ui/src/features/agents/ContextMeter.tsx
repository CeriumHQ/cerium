import { compactTokens } from "../../lib/format.ts";
import { CONTEXT_NEARLY_FULL, contextFill, type AgentContext } from "./model.ts";

// How full an agent's context is, as its harness measured it: a ring where it sits beside a name, a bar
// where there is room. Without a window to measure against there is no fill to show, only the count.

/** "42k of 200k · 21%", or the count alone without a window. */
export const contextLabel = (context: AgentContext): string => {
  const fill = contextFill(context);
  return fill === undefined || context.window === undefined
    ? `${compactTokens(context.tokens)} in context`
    : `${compactTokens(context.tokens)} of ${compactTokens(context.window)} · ${Math.round(fill * 100)}%`;
};

const tone = (fill: number) => (fill >= CONTEXT_NEARLY_FULL ? "stroke-attention" : "stroke-fg-secondary");

/** A thin ring that fills with the context; nothing without a window. */
export function ContextRing({
  context,
  size = 12,
}: {
  readonly context: AgentContext | undefined;
  readonly size?: number;
}) {
  const fill = contextFill(context);
  if (fill === undefined) return null;
  const stroke = 1.75;
  const radius = size / 2 - stroke / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <>
      <span className="sr-only">Context {Math.round(fill * 100)}% full</span>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0 -rotate-90"
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-line-subtle"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.max(fill, 0.04))}
          className={`transition-[stroke-dashoffset,stroke] duration-500 ease-out-soft ${tone(fill)}`}
        />
      </svg>
    </>
  );
}

/** A full-width bar with the count after it. */
export function ContextBar({ context }: { readonly context: AgentContext }) {
  const fill = contextFill(context);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 tabular-nums">
      {fill === undefined ? null : (
        <span className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-line-strong">
          <span
            className={`block h-full rounded-full transition-[width,background-color] duration-500 ease-out-soft ${fill >= CONTEXT_NEARLY_FULL ? "bg-attention" : "bg-fg-tertiary"}`}
            style={{ width: `${Math.max(fill, 0.02) * 100}%` }}
          />
        </span>
      )}
      <span className="shrink-0">{contextLabel(context)}</span>
    </span>
  );
}
