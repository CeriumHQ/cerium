import { CeriumMark } from "./CeriumMark.tsx";

/**
 * Cerium's lockup: the mark, and beside it the name set in the display face, expanded like the
 * question a new thread asks. `nameClassName` decides when the name shows (a breakpoint's `hidden`),
 * so only the mark stays where room is short.
 *
 * The launch screen draws this lockup larger, in the same proportions, and flies its mark and name to
 * these (app/LaunchScreen.tsx): a change to the sizes here changes `LOCKUP` there too.
 */
export function CeriumBrand({ nameClassName }: { nameClassName?: string }) {
  return (
    <span className="flex items-center gap-2 text-fg-primary select-none">
      <CeriumMark size={22} landing />
      <span
        data-launch-name=""
        className={`font-display text-[16px] leading-none font-semibold tracking-[0.02em] font-stretch-expanded [font-size-adjust:none] ${nameClassName ?? ""}`}
      >
        cerium
      </span>
    </span>
  );
}
