import { CeriumMark } from "./CeriumMark.tsx";

/**
 * Cerium's lockup: the mark, and beside it the name set in the display face, expanded like the
 * question a new thread asks. `nameClassName` decides when the name shows (a breakpoint's `hidden`),
 * so only the mark stays where room is short.
 */
export function CeriumBrand({ nameClassName }: { nameClassName?: string }) {
  return (
    <span className="flex items-center gap-2 text-fg-primary select-none">
      <CeriumMark size={22} landing />
      <span
        className={`font-display text-[16px] leading-none font-semibold tracking-[0.02em] font-stretch-expanded [font-size-adjust:none] ${nameClassName ?? ""}`}
      >
        cerium
      </span>
    </span>
  );
}
