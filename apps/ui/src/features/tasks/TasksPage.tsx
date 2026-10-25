import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { useAtom } from "@effect/atom-react";
import { ArrowUpRight, Check, Plus, Text, Trash2, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useCompact } from "../../app/compact.ts";
import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { shortAgo } from "../../lib/time.ts";
import { useMinute } from "../../lib/useMinute.ts";
import { ProjectPicker } from "../composer/ProjectPicker.tsx";
import { projectName } from "../composer/projectList.ts";
import {
  addTask,
  deleteTask,
  editTask,
  listTasks,
  splitTasks,
  tasksAtom,
  tickTask,
  type Task,
  type TaskPatch,
} from "./tasks.ts";

const ago = (at: number, now: number) => {
  const short = shortAgo(at, now);
  return short === "now" ? "just now" : `${short} ago`;
};

/** Starts a work thread with the task in its message box, in its project when it has one. */
export type HandOff = (task: Pick<Task, "title" | "note" | "folder">) => void;

/**
 * The rail's Tasks page on a wide window: the list down the middle, and the picked task's detail
 * beside it.
 */
export function TasksPage({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className="flex h-full overflow-hidden rounded-xl border border-line-subtle bg-surface-panel shadow-raised">
      <ScrollArea className="flex-1">{list}</ScrollArea>
      {detail === null ? null : (
        <aside className="w-[min(360px,40%)] shrink-0 border-l border-line-subtle">{detail}</aside>
      )}
    </div>
  );
}

/**
 * The user's tasks: a line to add one, what's still to do newest first, and what's done folded
 * under it. Tab in the line adds the task and hands it to an agent at once.
 */
export function TaskList({
  selected,
  onSelect,
  onHandOff,
}: {
  selected: string | undefined;
  onSelect: (id: string) => void;
  onHandOff: HandOff;
}) {
  const [store, setStore] = useAtom(tasksAtom);
  const [title, setTitle] = useState("");
  const compact = useCompact();
  const { open, done } = splitTasks(listTasks(store));

  const add = (handOff: boolean) => {
    const text = title.trim();
    if (text === "") return;
    setStore(addTask(store, text, Date.now()));
    setTitle("");
    if (handOff) onHandOff({ title: text });
  };
  const tick = (id: string, checked: boolean) => {
    setStore(tickTask(store, id, checked, Date.now()));
  };

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col px-6 pt-10 pb-12 max-md:px-3 max-md:pt-1">
      <header className="mb-5 px-1 max-md:mb-3 max-md:px-1.5">
        <h1 className="font-display text-[22px] leading-tight font-semibold font-stretch-expanded [font-size-adjust:none] max-md:text-[20px]">
          Tasks
        </h1>
        <p className="mt-0.5 text-[13px] text-fg-tertiary max-md:text-sm">
          {open.length > 0 ? `${open.length} to do` : done.length > 0 ? "All done" : "Nothing to do yet"}
        </p>
      </header>

      {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control */}
      <label className="mb-3 flex h-10 items-center gap-3 rounded-lg border border-line-subtle bg-surface-sunken px-3 focus-within:border-line-strong max-md:h-12">
        <Plus size={16} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add(false);
            } else if (event.key === "Tab" && !event.shiftKey && title.trim() !== "") {
              event.preventDefault();
              add(true);
            } else if (event.key === "Escape") setTitle("");
          }}
          // A phone has no Tab key to offer.
          placeholder={compact ? "Add a task" : "Add a task, or press Tab to hand it to an agent"}
          aria-label="Add a task"
          maxLength={500}
          className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[15px]"
        />
      </label>

      <ul className="flex flex-col">
        {open.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            selected={task.id === selected}
            onSelect={() => onSelect(task.id)}
            onTick={tick}
          />
        ))}
      </ul>

      {done.length > 0 ? (
        <Disclosure summary="Done" hint={String(done.length)} className="mt-4 px-1">
          <ul className="-mx-1 flex flex-col">
            {done.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                selected={task.id === selected}
                onSelect={() => onSelect(task.id)}
                onTick={tick}
              />
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}

function TaskCheck({
  done,
  onTick,
  label,
}: {
  done: boolean;
  onTick: (done: boolean) => void;
  label: string;
}) {
  return (
    <Checkbox.Root
      checked={done}
      onCheckedChange={onTick}
      aria-label={label}
      className="group grid size-6 shrink-0 cursor-default place-items-center rounded-full outline-none max-md:size-9"
    >
      <span className="grid size-4 place-items-center rounded-full border-[1.5px] border-line-strong transition-colors group-hover:border-fg-tertiary group-focus-visible:border-fg-secondary group-data-checked:border-accent group-data-checked:bg-accent max-md:size-5">
        <Checkbox.Indicator className="text-accent-fg data-unchecked:hidden">
          <Check size={10} strokeWidth={3} />
        </Checkbox.Indicator>
      </span>
    </Checkbox.Root>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
  onTick,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
  onTick: (id: string, done: boolean) => void;
}) {
  const done = task.doneAt !== undefined;
  return (
    <li
      className={`group/row flex min-h-10 items-center gap-1.5 rounded-lg pl-1.5 transition-colors max-md:min-h-12 ${
        selected ? "bg-surface-selected" : "hover:bg-surface-hover"
      }`}
    >
      <TaskCheck
        done={done}
        onTick={(checked) => onTick(task.id, checked)}
        label={done ? "Mark as to do" : "Mark as done"}
      />
      <Button
        onClick={onSelect}
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 self-stretch py-2 pr-3 text-left outline-none"
      >
        <span
          className={`min-w-0 flex-1 truncate text-[13.5px] max-md:text-[15px] ${
            done ? "text-fg-tertiary line-through decoration-fg-tertiary/60" : "text-fg-primary"
          } ${task.title.trim() === "" ? "text-fg-tertiary italic" : ""}`}
        >
          {task.title.trim() === "" ? "Untitled" : task.title}
        </span>
        {task.note ? <Text size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" /> : null}
        {task.folder ? (
          <span className="max-w-32 shrink-0 truncate text-[12px] text-fg-tertiary">
            {projectName(task.folder)}
          </span>
        ) : null}
      </Button>
    </li>
  );
}

/** A task's own page: its title, a note, where an agent would work on it, and handing it to one. */
export function TaskDetail({
  id,
  onClose,
  onDeleted,
  onHandOff,
}: {
  id: string;
  /** Closes the detail; none on a phone, whose bar has the way back. */
  onClose?: () => void;
  onDeleted: () => void;
  onHandOff: HandOff;
}) {
  const [store, setStore] = useAtom(tasksAtom);
  const [picking, setPicking] = useState(false);
  const now = useMinute();
  const task = listTasks(store).find((each) => each.id === id);
  if (task === undefined) return null;
  const done = task.doneAt !== undefined;
  const edit = (patch: TaskPatch) => {
    setStore(editTask(store, id, patch, Date.now()));
  };
  const tick = (checked: boolean) => {
    setStore(tickTask(store, id, checked, Date.now()));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        {onClose ? <IconButton icon={X} label="Close" onClick={onClose} /> : null}
        <span className="ml-auto" />
        <IconButton
          icon={Trash2}
          label="Delete task"
          onClick={() => {
            setStore(deleteTask(store, id, Date.now()));
            onDeleted();
          }}
          className="max-md:size-10"
        />
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col px-4 pb-6">
          <div className="flex items-start gap-1.5">
            <div className="pt-0.5 max-md:pt-0">
              <TaskCheck done={done} onTick={tick} label={done ? "Mark as to do" : "Mark as done"} />
            </div>
            <textarea
              value={task.title}
              onChange={(event) => edit({ title: event.target.value.replaceAll("\n", " ") })}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder="Untitled"
              aria-label="Title"
              rows={1}
              maxLength={500}
              className={`min-w-0 flex-1 resize-none bg-transparent py-0.5 text-[15px] leading-snug font-medium outline-none [field-sizing:content] placeholder:text-fg-tertiary max-md:text-[17px] ${
                done ? "text-fg-tertiary line-through" : "text-fg-primary"
              }`}
            />
          </div>
          <textarea
            value={task.note ?? ""}
            onChange={(event) => edit({ note: event.target.value === "" ? undefined : event.target.value })}
            placeholder="Add a note"
            aria-label="Note"
            maxLength={20_000}
            className="mt-2 min-h-20 resize-none bg-transparent pl-[30px] text-[13px] leading-relaxed text-fg-secondary outline-none [field-sizing:content] placeholder:text-fg-tertiary max-md:pl-[42px] max-md:text-[15px]"
          />

          <section className="mt-6 flex flex-col gap-2.5 border-t border-line-subtle pt-4">
            <h3 className="text-[12px] font-medium text-fg-tertiary max-md:text-[13px]">
              Hand it to an agent
            </h3>
            <div className="flex items-center gap-2">
              <div className="-ml-2 min-w-0">
                <ProjectPicker
                  folder={task.folder}
                  onChoose={(folder) => edit({ folder })}
                  open={picking}
                  onOpenChange={setPicking}
                />
              </div>
              <Button
                onClick={() => onHandOff(task)}
                className="ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 max-md:h-10 max-md:text-sm"
              >
                Start
                <ArrowUpRight size={14} strokeWidth={2} />
              </Button>
            </div>
          </section>

          <p className="mt-6 text-[12px] text-fg-tertiary">
            Added {ago(task.createdAt, now)}
            {task.doneAt === undefined ? null : ` · done ${ago(task.doneAt, now)}`}
          </p>
        </div>
      </ScrollArea>
    </div>
  );
}
