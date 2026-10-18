import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { projectIconAtom } from "../../backend/projects.ts";

/**
 * Up to two letters that stand for a project: the initials of its first two words ("roblox-suite",
 * "myApp" → "RS", "MA"), or a single word's first two letters ("cerium" → "Ce").
 */
export const wordmark = (name: string): string => {
  const words = name
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const [first = name, second] = words;
  if (second !== undefined) return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
  return first.charAt(0).toUpperCase() + first.charAt(1).toLowerCase();
};

const sizes = {
  /** Inline with 12.5px toolbar text. */
  small: { tile: "size-3.5 rounded-[4px]", text: "text-[6.5px]" },
  medium: { tile: "size-4.5 rounded-[5px]", text: "text-[8.5px]" },
};

/** The project's own icon when it has one, otherwise its wordmark on a quiet tile. */
export function ProjectBadge({
  folder,
  name,
  size = "medium",
}: {
  folder: string;
  name: string;
  size?: keyof typeof sizes;
}) {
  const icon = AsyncResult.getOrElse(useAtomValue(projectIconAtom(folder)), () => undefined);
  const { tile, text } = sizes[size];
  if (icon !== undefined) {
    return <img src={icon} alt="" draggable={false} className={`${tile} shrink-0 object-contain`} />;
  }
  return (
    <span
      aria-hidden
      className={`grid ${tile} shrink-0 place-items-center border border-line-subtle bg-surface-raised ${text} leading-none font-semibold tracking-tight text-fg-secondary`}
    >
      {wordmark(name)}
    </span>
  );
}
