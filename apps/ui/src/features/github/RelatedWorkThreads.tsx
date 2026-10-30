import { Button } from "@base-ui/react/button";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Archive, MessageSquare } from "lucide-react";

import { relatedWorkThreadsAtom } from "../../backend/sourceControl.ts";
import { Fact } from "./parts.tsx";

type RelatedThread = { readonly id: string; readonly title: string; readonly active: boolean };

/** The threads working on a pull request, active ones first; none while they load. */
export const useRelatedThreads = (url: string): ReadonlyArray<RelatedThread> =>
  AsyncResult.getOrElse(
    useAtomValue(relatedWorkThreadsAtom(url)),
    (): ReadonlyArray<RelatedThread> => [],
  ).toSorted((left, right) => Number(right.active) - Number(left.active));

/** The pull request's facts' row of the threads that work on it, each opening its thread. */
export function RelatedThreadsFact({
  threads,
  onOpen,
}: {
  readonly threads: ReadonlyArray<RelatedThread>;
  readonly onOpen?: ((id: string) => void) | undefined;
}) {
  return (
    <Fact name="Threads">
      {threads.map((thread) => {
        const Icon = thread.active ? MessageSquare : Archive;
        return (
          <Button
            key={thread.id}
            disabled={!onOpen}
            onClick={() => onOpen?.(thread.id)}
            title={thread.active ? thread.title : `${thread.title} (archived)`}
            className={`inline-flex h-6 max-w-64 min-w-0 items-center gap-1.5 rounded-full border border-line-subtle px-2 transition-colors hover:border-line-strong hover:bg-surface-hover disabled:pointer-events-none ${
              thread.active ? "text-fg-primary" : "text-fg-tertiary"
            }`}
          >
            <Icon size={12} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
            <span className="truncate">{thread.title}</span>
          </Button>
        );
      })}
    </Fact>
  );
}
