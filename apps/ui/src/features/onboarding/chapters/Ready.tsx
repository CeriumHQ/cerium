import { OFFERED_PROVIDERS, type HarnessStatus } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";

import { accountAtom, harnessesAtom } from "../../../backend/atoms.ts";
import { ProviderLogo } from "../../../components/ProviderLogo.tsx";
import { keyCaps } from "../../../lib/keys.ts";
import { paletteAtom, palettes } from "../../settings/palettes.ts";
import { themeAtom } from "../../settings/preferences.ts";
import { useShownTheme } from "../../settings/theme.ts";
import { harnessReadiness } from "../model.ts";
import { Eyebrow, Headline, Keycap, Reveal } from "../parts.tsx";
import { fan, markIn, usePose, type Posing } from "../scene.tsx";
import type { ChapterProps } from "../Welcome.tsx";

/** The keys worth knowing from the first minute. */
const SHORTCUTS = [
  { keys: "Ctrl K", label: "Find anything" },
  { keys: "Ctrl N", label: "New thread" },
  { keys: "Ctrl ,", label: "Settings" },
] as const;

/** The light comes in level from the left, through the mark in the middle, and out across the stage. */
const pose =
  (lit: ReadonlyArray<boolean>): Posing =>
  (stage) => {
    const { x, y, size } = markIn(stage, "ready", {
      x: stage.width / 2,
      y: stage.height * 0.3,
      size: 200,
    });
    return {
      mark: { x, y, size, opacity: 1 },
      incoming: { from: { x: -80, y: y - stage.height * 0.05 }, intensity: 1 },
      beams: fan(
        stage,
        { x, y },
        stage.height * 0.075,
        lit.map((each) => (each ? 1 : 0.3)),
      ),
      dust: 1,
    };
  };

/** The last chapter: what was chosen, each a step back to change it, and the keys to start with. */
export function Ready({ number, titleId, active, onGo }: ChapterProps) {
  const statuses = AsyncResult.getOrElse(useAtomValue(harnessesAtom), (): ReadonlyArray<HarnessStatus> => []);
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  const palette = useAtomValue(paletteAtom);
  const theme = useAtomValue(themeAtom);
  const shown = useShownTheme();
  const ready = OFFERED_PROVIDERS.filter(
    (provider) => harnessReadiness(statuses.find((status) => status.provider === provider)) === "ready",
  );
  usePose(active, pose(OFFERED_PROVIDERS.map((provider) => ready.includes(provider))), ready.join());

  const glass = palettes.find((each) => each.id === palette)?.label ?? "Cerium";
  const mode = theme === "system" ? `follows the system, ${shown} now` : theme;
  return (
    <div className="flex h-full flex-col items-center justify-center px-(--welcome-gutter) pb-[2vh] text-center">
      {/* The light draws the mark here. */}
      <div data-light="mark" className="aspect-square w-[clamp(120px,22vh,220px)]" />
      <div className="mt-[clamp(8px,2vh,24px)] flex flex-col items-center">
        <Eyebrow number={number}>All set</Eyebrow>
        <Headline
          id={titleId}
          lines={["Ready when you are."]}
          className="text-[length:clamp(40px,min(5.6vw,9.5vh),96px)]"
        />
      </div>
      <Reveal
        order={3}
        as="ul"
        className="mt-[clamp(20px,4vh,40px)] flex flex-wrap items-center justify-center gap-2.5"
      >
        <Fact onClick={() => onGo("glass")} label="Change the glass">
          <span className="size-3 rounded-full bg-accent ring-1 ring-line-strong" />
          {glass} glass, {mode}
        </Fact>
        <Fact
          onClick={() => onGo("agents")}
          label="Set up harnesses"
          tone={ready.length === 0 ? "attention" : "quiet"}
        >
          {ready.length === 0 ? null : (
            <span className="flex -space-x-1">
              {ready.map((provider) => (
                <span
                  key={provider}
                  className="grid size-5 place-items-center rounded-full border border-line-subtle bg-surface-panel"
                >
                  <ProviderLogo provider={provider} size={11} />
                </span>
              ))}
            </span>
          )}
          {ready.length === 0
            ? "No harness ready yet"
            : `${ready.length} ${ready.length === 1 ? "harness" : "harnesses"} ready`}
        </Fact>
        <Fact onClick={() => onGo("everywhere")} label="Change the account">
          {account?._tag === "SignedIn"
            ? `Signed in as ${account.account.name ?? account.account.email ?? "you"}`
            : "On this computer only"}
        </Fact>
      </Reveal>
      <Reveal
        order={4}
        className="mt-[clamp(20px,4.4vh,44px)] flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
      >
        {SHORTCUTS.map((shortcut) => (
          <span key={shortcut.keys} className="flex items-center gap-2 text-[12.5px] text-fg-tertiary">
            <span className="flex gap-1">
              {keyCaps(shortcut.keys).map((cap) => (
                <Keycap key={cap}>{cap}</Keycap>
              ))}
            </span>
            {shortcut.label}
          </span>
        ))}
      </Reveal>
    </div>
  );
}

/** One thing chosen along the way, which goes back to where it was chosen. */
function Fact({
  onClick,
  label,
  tone = "quiet",
  children,
}: {
  readonly onClick: () => void;
  /** What the click does, for screen readers and the tooltip. */
  readonly label: string;
  readonly tone?: "quiet" | "attention";
  readonly children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={label}
        className={`flex h-9 items-center gap-2 rounded-full border border-line-subtle bg-surface-raised px-3.5 text-[12.5px] shadow-raised backdrop-blur-xl transition-colors hover:border-line-strong hover:text-fg-primary ${
          tone === "attention" ? "text-attention" : "text-fg-secondary"
        }`}
      >
        {children}
      </button>
    </li>
  );
}
