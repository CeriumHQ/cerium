import type { ComponentType, ReactNode } from "react";

/** How a settings glyph is sized and weighted, as an icon from lucide-react takes it. */
export interface GlyphProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
  "aria-hidden"?: boolean;
}

/** A diamond, the Prism C's facet: the one filled shape each glyph carries. */
const facet = (x: number, y: number, r: number) =>
  `M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`;

/**
 * The settings categories' glyphs, drawn for Cerium rather than taken from an icon set: a thin line on
 * a 24-unit grid with one facet filled in the accent colour, the way the Prism C has its facet.
 */
function glyph(art: ReactNode) {
  return function Glyph({ size = 18, strokeWidth = 2, className, "aria-hidden": hidden = true }: GlyphProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={hidden}
        className={`shrink-0 ${className ?? ""}`}
      >
        {art}
      </svg>
    );
  };
}

/** Each category's glyph: a slider with its knobs, a person, a ping, a prism, a fan of agents, a slash, a frame, a branch, a gauge and keycaps. */
export const settingsGlyphs: Record<
  | "general"
  | "account"
  | "notifications"
  | "appearance"
  | "agents"
  | "prompts"
  | "harnesses"
  | "sourceControl"
  | "usage"
  | "keyboard",
  ComponentType<GlyphProps>
> = {
  general: glyph(
    <>
      <path d="M3 7h18M3 17h18" />
      <path d={facet(9, 7, 2.5)} className="fill-accent stroke-none" />
      <path d={facet(15, 17, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  account: glyph(
    <>
      <path d={facet(12, 8, 3.5)} className="fill-accent stroke-none" />
      <path d="M5 20.5a7 7 0 0 1 14 0" />
    </>,
  ),
  notifications: glyph(
    <>
      <path d={facet(7.5, 12, 2)} className="fill-accent stroke-none" />
      <path d="M11.5 8.5a5 5 0 0 1 0 7" />
      <path d="M15 5.5a9.5 9.5 0 0 1 0 13" />
    </>,
  ),
  appearance: glyph(
    <>
      <path d="M12 3.5 20.5 12 12 20.5 3.5 12Z" />
      <path d="M12 3.5 3.5 12 12 20.5Z" className="fill-accent stroke-none" />
    </>,
  ),
  agents: glyph(
    <>
      <path d={facet(12, 5.5, 2.5)} className="fill-accent stroke-none" />
      <circle cx="6" cy="18.5" r="2.5" />
      <circle cx="18" cy="18.5" r="2.5" />
      <path d="M12 8v3.5L6.5 16M12 11.5 17.5 16" />
    </>,
  ),
  prompts: glyph(
    <>
      <path d="M8.5 20 15.5 4" />
      <path d={facet(17, 18, 2)} className="fill-accent stroke-none" />
    </>,
  ),
  harnesses: glyph(
    <>
      <path d="M3.5 8V6.5a3 3 0 0 1 3-3H8M16 3.5h1.5a3 3 0 0 1 3 3V8M20.5 16v1.5a3 3 0 0 1-3 3H16M8 20.5H6.5a3 3 0 0 1-3-3V16" />
      <path d={facet(12, 12, 3)} className="fill-accent stroke-none" />
    </>,
  ),
  sourceControl: glyph(
    <>
      <circle cx="6" cy="5.5" r="2.5" />
      <circle cx="6" cy="18.5" r="2.5" />
      <path d="M6 8v8M18 9.5C18 14 6 12.5 6 15.5" />
      <path d={facet(18, 7, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  usage: glyph(
    <>
      <path d="M6 18A8.5 8.5 0 1 1 18 18" />
      <path d="M12 12l3.5-3.5" />
      <path d={facet(12, 12, 2)} className="fill-accent stroke-none" />
    </>,
  ),
  keyboard: glyph(
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6.5 10h.01M10.5 10h.01M14.5 10h.01M17.5 10h.01M7.5 14.5h9" />
    </>,
  ),
};
