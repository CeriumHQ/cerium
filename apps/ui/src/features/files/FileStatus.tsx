import type { FileState } from "@cerium/rpc";
import { PencilLine } from "lucide-react";

import { stateLetter, stateWord, touchWord } from "./model.ts";

/** Colour only where it means something: what needs a look is amber or red, what's new is green. */
export const stateTone: Readonly<Record<FileState, string>> = {
  modified: "text-attention-text",
  added: "text-success-text",
  untracked: "text-success-text",
  deleted: "text-error-text",
  renamed: "text-running-text",
  conflicted: "text-error-text",
};

/** The letter beside a changed file, as editors show it. */
export function StateLetter({ state }: { state: FileState }) {
  return (
    <span
      className={`w-3 shrink-0 text-center text-caption leading-none font-semibold ${stateTone[state]}`}
      // A letter that stands for a word, which `img` can't hold.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="img"
      aria-label={stateWord[state]}
    >
      {stateLetter[state]}
    </span>
  );
}

/** A dot for a folder with changes inside it, in the colour of what stands for them. */
export function StateDot({ state, count }: { state: FileState; count: number }) {
  return (
    <span
      className={`grid w-3 shrink-0 place-items-center ${stateTone[state]}`}
      // A dot that stands for a count, which `img` can't hold.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="img"
      aria-label={count === 1 ? "1 change inside" : `${count} changes inside`}
    >
      <span className="size-[5px] rounded-full bg-current" />
    </span>
  );
}

/** Marks what this thread's agents changed. */
export function TouchedMark({ change }: { change: "created" | "modified" | "deleted" }) {
  return (
    <PencilLine
      size={11}
      strokeWidth={2}
      className="shrink-0 text-fg-tertiary"
      // The icon is the mark, so it takes the name itself.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="img"
      aria-label={touchWord(change)}
    />
  );
}
