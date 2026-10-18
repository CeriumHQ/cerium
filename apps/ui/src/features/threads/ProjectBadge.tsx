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

/** The project's own icon when it has one, otherwise its wordmark on a quiet tile. */
export function ProjectBadge({ folder, name }: { folder: string; name: string }) {
  const icon = AsyncResult.getOrElse(useAtomValue(projectIconAtom(folder)), () => undefined);
  if (icon !== undefined) {
    return (
      <img src={icon} alt="" draggable={false} className="size-4.5 shrink-0 rounded-[5px] object-contain" />
    );
  }
  return (
    <span
      aria-hidden
      className="grid size-4.5 shrink-0 place-items-center rounded-[5px] border border-line-subtle bg-surface-raised text-[8.5px] leading-none font-semibold tracking-tight text-fg-secondary"
    >
      {wordmark(name)}
    </span>
  );
}
