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

/**
 * Each page's glyph: a slider with its knobs, a person, a ping, a prism, a fan of agents, a slash, a
 * frame, four blocks round a hub, a book, a branch, a gauge, bars, keycaps, a microphone, a turning
 * arrow, a pen, a ranked list, a plug, a fork in the road, a screen beside a phone, a speech bubble and
 * a bubble with a spark leaping from it.
 */
export const settingsGlyphs: Record<
  | "general"
  | "account"
  | "notifications"
  | "appearance"
  | "agents"
  | "prompts"
  | "harnesses"
  | "mcp"
  | "skills"
  | "sourceControl"
  | "limits"
  | "tokens"
  | "keyboard"
  | "dictation"
  | "updates"
  | "threads"
  | "roster"
  | "advisor"
  | "router"
  | "devices"
  | "discord"
  | "assistants",
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
  mcp: glyph(
    <>
      <rect x="3" y="3" width="5" height="5" rx="1.5" />
      <rect x="16" y="3" width="5" height="5" rx="1.5" />
      <rect x="3" y="16" width="5" height="5" rx="1.5" />
      <rect x="16" y="16" width="5" height="5" rx="1.5" />
      <path d="M8 8l2 2M16 8l-2 2M8 16l2-2M16 16l-2-2" />
      <path d={facet(12, 12, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  skills: glyph(
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H17v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19V6" />
      <path d={facet(11, 10.5, 2.5)} className="fill-accent stroke-none" />
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
  limits: glyph(
    <>
      <path d="M6 18A8.5 8.5 0 1 1 18 18" />
      <path d="M12 12l3.5-3.5" />
      <path d={facet(12, 12, 2)} className="fill-accent stroke-none" />
    </>,
  ),
  tokens: glyph(
    <>
      <path d="M4 20.5h16M6 17v-5M10.5 17V8M15 17v-3" />
      <path d={facet(18.5, 7, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  keyboard: glyph(
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6.5 10h.01M10.5 10h.01M14.5 10h.01M17.5 10h.01M7.5 14.5h9" />
    </>,
  ),
  dictation: glyph(
    <>
      <path d={facet(12, 8, 4)} className="fill-accent stroke-none" />
      <path d="M5.5 12.5a6.5 6.5 0 0 0 13 0M12 19v2" />
    </>,
  ),
  updates: glyph(
    <>
      <path d="M19.5 12A7.5 7.5 0 1 1 17 6.4" />
      <path d="M19.5 3.5v4h-4" />
      <path d={facet(12, 12, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  threads: glyph(
    <>
      <path d="M4 20l1-4L15.5 5.5a2.1 2.1 0 0 1 3 3L8 19Z" />
      <path d={facet(18, 18, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  roster: glyph(
    <>
      <path d={facet(5, 6, 2.5)} className="fill-accent stroke-none" />
      <path d="M10.5 6h10M10.5 12h10M10.5 18h10M5 12h.01M5 18h.01" />
    </>,
  ),
  advisor: glyph(
    <>
      <path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0ZM12 16v4.5" />
      <path d={facet(12, 11, 2)} className="fill-accent stroke-none" />
    </>,
  ),
  router: glyph(
    <>
      <path d="M3.5 12h5.5l6-6h5.5M9 12l6 6h5.5" />
      <path d={facet(9, 12, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  devices: glyph(
    <>
      <path d="M13 15.5H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2V8M7 19.5h6" />
      <rect x="16" y="10.5" width="5" height="9" rx="1.5" />
      <path d={facet(9.5, 10, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  discord: glyph(
    <>
      <path d="M5 4.5h14A1.5 1.5 0 0 1 20.5 6v8.5A1.5 1.5 0 0 1 19 16h-7l-4.5 3.5V16H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5Z" />
      <path d={facet(12, 10.25, 2.5)} className="fill-accent stroke-none" />
    </>,
  ),
  assistants: glyph(
    <>
      <path d="M13.5 6.5H5A1.5 1.5 0 0 0 3.5 8v7.5A1.5 1.5 0 0 0 5 17h2.5v3l4-3H17a1.5 1.5 0 0 0 1.5-1.5V12" />
      <path d="M8 11.5h5" />
      <path d={facet(18, 6, 2.75)} className="fill-accent stroke-none" />
    </>,
  ),
};
