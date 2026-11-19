import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";

const tone = {
  primary: "bg-accent text-accent-fg hover:bg-accent-strong active:bg-accent-strong",
  neutral: "border border-line-strong text-fg-primary hover:bg-surface-hover active:bg-surface-active",
  danger: "border border-error/35 bg-error/15 text-error-text hover:bg-error/25",
  quiet: "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary active:bg-surface-active",
} as const;

const size = {
  sm: "h-7 rounded-md px-2.5 text-meta max-md:h-10 max-md:px-3 max-md:text-[14px]",
  md: "h-8 rounded-lg px-3 text-body max-md:h-10 max-md:px-4 max-md:text-[15px]",
} as const;

export type ButtonTone = keyof typeof tone;
export type ButtonSize = keyof typeof size;

/** The class of a text button, for elements that render through another primitive (a dialog's Close, a menu trigger). */
export const buttonClass = ({
  tone: t = "neutral",
  size: s = "md",
}: { tone?: ButtonTone | undefined; size?: ButtonSize | undefined } = {}) =>
  `inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-40 data-disabled:pointer-events-none data-disabled:opacity-40 ${tone[t]} ${size[s]}`;

/** A text button: `primary` for the choice most people want, `danger` for what can't be undone, `quiet` for a secondary action without a border. */
export function Button({
  tone,
  size,
  className,
  ...props
}: ComponentProps<typeof BaseButton> & { readonly tone?: ButtonTone; readonly size?: ButtonSize }) {
  return (
    <BaseButton
      {...props}
      className={(state) =>
        `${buttonClass({ tone, size })} ${typeof className === "function" ? (className(state) ?? "") : (className ?? "")}`
      }
    />
  );
}
