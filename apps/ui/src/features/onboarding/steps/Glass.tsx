import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useAtom } from "@effect/atom-react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useRef, type CSSProperties } from "react";
import { flushSync } from "react-dom";

import { paletteAtom, palettes, type Palette } from "../../settings/palettes.ts";
import { themeAtom, themes, type Theme } from "../../settings/preferences.ts";
import { useShownTheme } from "../../settings/theme.ts";
import { Eyebrow, Headline, Reveal } from "../parts.tsx";
import type { StepProps } from "../Welcome.tsx";

/** Each glass as the welcome tells it: what the trade calls it, and how it takes the light. */
const GLASSES: Record<Palette, { readonly kind: string; readonly light: string }> = {
  cerium: {
    kind: "Clear",
    light: "The clearest glass, polished with ceria. Colour is kept for what it means.",
  },
  amber: { kind: "Bottle glass", light: "Brown bottle glass with honey in the light." },
  uranium: { kind: "Vaseline glass", light: "Olive in daylight, glowing chartreuse under a lamp." },
  seaglass: { kind: "Tide-frosted", light: "Frosted by the tide: aqua, with coral and sand in the code." },
  cobalt: { kind: "Smalt blue", light: "Deep blue bottle glass, with gold in the code." },
  cranberry: { kind: "Gold ruby", light: "Plum glass and a rose accent, with gold in the code." },
};

const MODES: Record<Theme, { readonly label: string; readonly icon: LucideIcon }> = {
  dark: { label: "Dark", icon: Moon },
  light: { label: "Light", icon: Sun },
  system: { label: "System", icon: Monitor },
};

/**
 * Swaps the theme over the welcome as a widening circle from `from`, where the browser can: the new
 * glass spreads out from the pane that was picked.
 */
const wipe = (update: () => void, from: { readonly x: number; readonly y: number } | undefined) => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.startViewTransition === undefined || reduce || !("types" in ViewTransition.prototype)) {
    update();
    return;
  }
  const root = document.documentElement;
  const x = from?.x ?? innerWidth / 2;
  const y = from?.y ?? innerHeight / 2;
  root.style.setProperty("--wipe-x", `${x}px`);
  root.style.setProperty("--wipe-y", `${y}px`);
  root.style.setProperty(
    "--wipe-r",
    `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`,
  );
  document.startViewTransition({ update: () => flushSync(update), types: ["glass"] });
};

/** The second step: the glass Cerium is cut from, and light or dark. */
export function Glass({ number, titleId }: StepProps) {
  const [palette, setPalette] = useAtom(paletteAtom);
  const [theme, setTheme] = useAtom(themeAtom);
  const shown = useShownTheme();
  /** Where the pointer last pressed, which a pick's wipe spreads from. */
  const pressed = useRef<{ x: number; y: number }>(undefined);

  const tilt = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty(
      "--tilt-x",
      String(((event.clientX - box.left) / box.width) * 2 - 1),
    );
    event.currentTarget.style.setProperty(
      "--tilt-y",
      String(((event.clientY - box.top) / box.height) * 2 - 1),
    );
  };
  const untilt = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.removeProperty("--tilt-x");
    event.currentTarget.style.removeProperty("--tilt-y");
  };
  const remember = (event: React.PointerEvent) => {
    pressed.current = { x: event.clientX, y: event.clientY };
  };
  /** Where a pick's wipe spreads from: the press that made it, or the pane picked with the keys. */
  const fromElement = (element: Element | null) => {
    const press = pressed.current;
    pressed.current = undefined;
    if (press !== undefined) return press;
    const box = element?.getBoundingClientRect();
    return box === undefined ? undefined : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };

  return (
    <div className="flex h-full flex-col justify-center gap-[clamp(28px,6vh,64px)] px-(--welcome-gutter) pb-[2vh]">
      <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
        <div>
          <Eyebrow number={number}>Appearance</Eyebrow>
          <Headline
            id={titleId}
            lines={["Choose", "your glass."]}
            className="text-[length:clamp(48px,min(6.6vw,11vh),112px)]"
          />
        </div>
        <Reveal order={3} className="flex max-w-[22rem] flex-col items-start gap-5 pb-2">
          <p
            key={palette}
            className="min-h-[3lh] animate-[launch-fade_500ms_ease-out_both] text-[14.5px] leading-relaxed text-fg-secondary"
          >
            <span className="text-fg-primary">{palettes.find((each) => each.id === palette)?.label}.</span>{" "}
            {GLASSES[palette].light}
          </p>
          <RadioGroup
            value={theme}
            onValueChange={(value, details) =>
              wipe(() => setTheme(value as Theme), fromElement(details.event.target as Element | null))
            }
            aria-label="Mode"
            className="flex rounded-full border border-line-subtle bg-surface-hover p-1"
          >
            {themes.map((option) => {
              const { label, icon: Icon } = MODES[option];
              return (
                <Radio.Root
                  key={option}
                  value={option}
                  nativeButton
                  onPointerDown={remember}
                  render={<button type="button" aria-label={label} />}
                  className="flex h-7.5 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] text-fg-tertiary outline-none transition-colors duration-200 hover:text-fg-secondary focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:bg-surface-raised data-checked:text-fg-primary data-checked:shadow-raised"
                >
                  <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                  {label}
                </Radio.Root>
              );
            })}
          </RadioGroup>
        </Reveal>
      </div>

      <div className="relative">
        {/* A ray of light runs behind every pane, so each tints it as it passes through. */}
        <Reveal
          order={3}
          className="welcome-ray pointer-events-none absolute top-[46%] right-[calc(-1*var(--welcome-gutter))] left-[calc(-1*var(--welcome-gutter))] h-px"
        />
        <RadioGroup
          value={palette}
          onValueChange={(value, details) =>
            wipe(() => setPalette(value as Palette), fromElement(details.event.target as Element | null))
          }
          aria-label="Theme"
          onPointerMove={tilt}
          onPointerLeave={untilt}
          className="relative grid h-[clamp(168px,34vh,300px)] grid-cols-6 gap-[clamp(10px,1.4vw,22px)]"
        >
          {palettes.map((option, index) => (
            <Reveal key={option.id} order={4 + index * 0.6} className="min-w-0">
              <Radio.Root
                value={option.id}
                nativeButton
                onPointerDown={remember}
                render={<button type="button" aria-label={`${option.label}: ${GLASSES[option.id].kind}`} />}
                style={{ "--px": (index - 2.5) / 2.5 } as CSSProperties}
                className="group relative block size-full rounded-[clamp(14px,1.6vw,24px)] text-left outline-none"
              >
                <Pane palette={option.id} theme={shown} label={option.label} kind={GLASSES[option.id].kind} />
              </Radio.Root>
            </Reveal>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}

/**
 * One pane of a glass, drawn in its own theme's tokens: tinted by its accent, blurring the light behind
 * it, with a sheen that slides as the pane turns towards the pointer. The pane picked stands forward.
 */
function Pane({
  palette,
  theme,
  label,
  kind,
}: {
  readonly palette: Palette;
  readonly theme: "dark" | "light";
  readonly label: string;
  readonly kind: string;
}) {
  return (
    <span
      data-palette={palette}
      data-theme={theme}
      className="welcome-pane absolute inset-0 flex flex-col justify-end overflow-hidden rounded-[inherit] border border-line-strong p-[clamp(12px,1.3vw,20px)] text-fg-primary group-hover:-translate-y-1.5 group-focus-visible:ring-2 group-focus-visible:ring-focus-ring group-data-checked:-translate-y-3 group-data-checked:border-accent/70"
    >
      <span aria-hidden="true" className="welcome-pane-sheen pointer-events-none absolute inset-0" />
      <span
        aria-hidden="true"
        className="welcome-pane-glow pointer-events-none absolute inset-x-0 bottom-0 h-2/3"
      />
      <span aria-hidden="true" className="welcome-pane-caustic pointer-events-none absolute" />
      <span className="absolute top-[clamp(10px,1.1vw,16px)] right-[clamp(10px,1.1vw,16px)] grid size-4 place-items-center rounded-full border border-fg-primary/30 transition-colors group-data-checked:border-accent group-data-checked:bg-accent">
        <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg" />
      </span>
      <span className="relative truncate font-display text-[clamp(14px,1.35vw,20px)] font-light tracking-tight font-stretch-expanded [font-size-adjust:none]">
        {label}
      </span>
      <span className="relative mt-1 truncate font-mono text-[10px] tracking-[0.12em] text-fg-tertiary uppercase group-data-checked:text-fg-secondary">
        {kind}
      </span>
    </span>
  );
}
