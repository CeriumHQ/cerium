import { OFFERED_PROVIDERS } from "@cerium/protocol";

import { ProviderLogo } from "../../../components/ProviderLogo.tsx";
import { harnessName } from "../../settings/Harnesses.tsx";
import { Eyebrow, Headline, Reveal } from "../parts.tsx";
import { fan, usePose, type Posing } from "../scene.tsx";
import type { ChapterProps } from "../Welcome.tsx";

/** The light falls from above into the mark at the right, and fans out across the stage from it. */
const pose: Posing = (stage) => {
  const size = Math.min(stage.width * 0.27, stage.height * 0.56, 460);
  const mark = { x: stage.width * 0.76, y: stage.height * 0.46 };
  return {
    mark: { ...mark, size, opacity: 1 },
    incoming: { from: { x: stage.width * 0.46, y: -80 }, intensity: 1 },
    beams: fan(stage, mark, stage.height * 0.09),
    dust: 1,
  };
};

/** The first chapter: what Cerium is, in two lines, and the harnesses it brings together. */
export function Hello({ number, titleId, active }: ChapterProps) {
  usePose(active, pose);
  return (
    <div className="flex h-full flex-col justify-center px-(--welcome-gutter) pb-[4vh]">
      <Eyebrow number={number}>Welcome to Cerium</Eyebrow>
      <Headline
        id={titleId}
        lines={["One thread.", "Every agent."]}
        className="text-[length:clamp(52px,min(7.2vw,13.5vh),132px)]"
      />
      <Reveal
        order={4}
        as="p"
        className="mt-[clamp(20px,4vh,40px)] max-w-[30rem] text-[15px] leading-relaxed text-fg-secondary"
      >
        Ask once, and a lead agent hands each part of the job to the harness that does it best. They work side
        by side, on your own plans, in one thread.
      </Reveal>
      <Reveal
        order={5}
        as="ul"
        className="mt-[clamp(18px,3.4vh,32px)] flex flex-wrap items-center gap-x-5 gap-y-2"
      >
        {OFFERED_PROVIDERS.map((provider) => (
          <li key={provider} className="flex items-center gap-2 text-[12.5px] text-fg-tertiary">
            <ProviderLogo provider={provider} size={14} className="opacity-80" />
            {harnessName[provider]}
          </li>
        ))}
      </Reveal>
    </div>
  );
}
