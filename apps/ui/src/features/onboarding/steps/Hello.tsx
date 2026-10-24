import { GlassMark } from "../GlassMark.tsx";
import { Headline } from "../parts.tsx";
import type { StepProps } from "../Welcome.tsx";

/** The first step: the mark in glass, and hello. */
export function Hello({ titleId, active }: StepProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-(--welcome-gutter) pb-[3vh]">
      {/* The mark the launch screen's flies to, and from which the window's takes over at the end. It
          comes in on its own, turning in from the side as it settles. */}
      <div data-launch-mark="" className="size-[min(54vh,44vw)]">
        <GlassMark running={active} className="size-full" />
      </div>
      <Headline
        id={titleId}
        lines={["Welcome to Cerium"]}
        delay={8}
        className="mt-[clamp(8px,2.4vh,28px)] text-center text-[length:clamp(36px,min(4.6vw,8vh),80px)]"
      />
    </div>
  );
}
