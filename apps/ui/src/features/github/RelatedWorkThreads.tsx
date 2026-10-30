import { Button } from "@base-ui/react/button";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { relatedWorkThreadsAtom } from "../../backend/sourceControl.ts";

export function RelatedWorkThreads({
  url,
  onOpen,
}: {
  readonly url: string;
  readonly onOpen?: ((id: string) => void) | undefined;
}) {
  const threads = AsyncResult.getOrElse(useAtomValue(relatedWorkThreadsAtom(url)), () => []);
  if (threads.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-meta text-fg-secondary">
      <span>Related conversations</span>
      {threads.map((thread) => (
        <Button
          key={thread.id}
          disabled={!onOpen}
          className="max-w-64 truncate rounded-md bg-surface-active px-2 py-1 text-fg-primary disabled:opacity-70"
          onClick={() => onOpen?.(thread.id)}
        >
          {thread.title}
          {thread.active ? "" : " · Archived"}
        </Button>
      ))}
    </div>
  );
}
