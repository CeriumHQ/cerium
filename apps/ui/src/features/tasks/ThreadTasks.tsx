import { Button } from "@base-ui/react/button";
import { useAtom } from "@effect/atom-react";
import { Check, CircleCheck, ListTodo, X } from "lucide-react";

import { InlineSelect } from "../../components/ui/InlineSelect.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { linkedTasks, linkTaskThreads, listTasks, tasksAtom, tickTask, unlinkTaskThread } from "./tasks.ts";

/**
 * The tasks a thread works on, in a strip over its transcript: each opens on the Tasks page, can be
 * unlinked, and once the thread has finished can be ticked off from here. Another task can be linked
 * from the strip's end; with none linked yet, that's all it shows, quietly at the right.
 */
export function ThreadTasks({
  threadId,
  finished,
  onOpenTask,
}: {
  readonly threadId: string;
  readonly finished: boolean;
  readonly onOpenTask: (id: string) => void;
}) {
  const [store, setStore] = useAtom(tasksAtom);
  const tasks = listTasks(store);
  const linked = linkedTasks(tasks, threadId);
  const available = tasks.filter((task) => !task.threadIds?.includes(threadId));

  if (linked.length === 0 && available.length === 0) return null;

  const picker =
    available.length === 0 ? null : (
      <label className="ml-auto flex min-w-0 shrink-0 items-center">
        <span className="sr-only">Link an existing task</span>
        <InlineSelect
          value=""
          onChange={(event) => {
            const id = event.target.value;
            if (id !== "") setStore((latest) => linkTaskThreads(latest, id, [threadId], Date.now()));
          }}
          className="max-w-48 [&_select]:font-normal [&_select]:text-fg-tertiary"
        >
          <option value="" disabled>
            {linked.length === 0 ? "Link a task…" : "Link another…"}
          </option>
          {available.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title || "Untitled task"}
            </option>
          ))}
        </InlineSelect>
      </label>
    );

  return (
    <section
      aria-label="Linked tasks"
      className={`flex shrink-0 items-center gap-2 px-4 text-meta max-md:text-[13px] ${
        linked.length === 0 ? "h-8 max-md:h-10" : "min-h-9 flex-wrap border-b border-line-subtle py-1.5"
      }`}
    >
      {linked.length === 0 ? null : (
        <>
          <h2 className="flex shrink-0 items-center gap-1.5 text-caption font-medium text-fg-tertiary max-md:text-[13px]">
            <ListTodo size={13} strokeWidth={1.75} aria-hidden />
            Linked tasks
          </h2>
          <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
            {linked.map((task) => {
              const name = task.title || "untitled task";
              const done = task.doneAt !== undefined;
              return (
                <li
                  key={task.id}
                  className="group/task flex h-6 max-w-full min-w-0 items-center rounded-md border border-line-subtle bg-surface-raised shadow-raised max-md:h-8"
                >
                  <Button
                    onClick={() => onOpenTask(task.id)}
                    title={`Open “${task.title || "Untitled task"}” in Tasks`}
                    className={`flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1 pl-2 transition-colors hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none ${
                      done ? "text-fg-tertiary" : "text-fg-secondary"
                    }`}
                  >
                    <span
                      className={`min-w-0 max-w-56 truncate ${done ? "line-through decoration-fg-tertiary/60" : ""}`}
                    >
                      {task.title || "Untitled task"}
                    </span>
                  </Button>
                  {done ? (
                    <span className="flex shrink-0 items-center gap-1 pr-1 text-caption text-success-text max-md:text-[12px]">
                      <CircleCheck size={11} strokeWidth={2} aria-hidden />
                      Done
                    </span>
                  ) : finished ? (
                    // The thread is through, so its task may be too: one press ticks it off.
                    <Button
                      aria-label={`Mark ${name} done`}
                      onClick={() => setStore((latest) => tickTask(latest, task.id, true, Date.now()))}
                      className="flex h-4.5 shrink-0 items-center gap-1 rounded bg-accent-soft px-1.5 text-caption font-medium text-fg-primary transition-colors hover:bg-accent hover:text-accent-fg focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none max-md:h-6 max-md:text-[12px]"
                    >
                      <Check size={10} strokeWidth={2.5} aria-hidden />
                      Mark task done
                    </Button>
                  ) : null}
                  <Tooltip label="Unlink from this thread" side="bottom">
                    <Button
                      aria-label={`Unlink ${name}`}
                      onClick={() =>
                        setStore((latest) => unlinkTaskThread(latest, task.id, threadId, Date.now()))
                      }
                      className="mr-0.5 ml-0.5 grid size-5 shrink-0 place-items-center rounded text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none max-md:size-7"
                    >
                      <X size={11} strokeWidth={2} />
                    </Button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {picker}
    </section>
  );
}
