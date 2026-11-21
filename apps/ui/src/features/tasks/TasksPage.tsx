import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { useAtom } from "@effect/atom-react";
import { ArrowUpRight, Check, FolderOpen, Plus, Text, Trash2, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useCompact } from "../../app/compact.ts";
import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { buttonClass } from "../../components/ui/Button.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { InlineSelect } from "../../components/ui/InlineSelect.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { shortAgo } from "../../lib/time.ts";
import { useMinute } from "../../lib/useMinute.ts";
import { ProjectPicker } from "../composer/ProjectPicker.tsx";
import { projectName } from "../composer/projectList.ts";
import type { ThreadSummary } from "../threads/model.ts";
import {
  addTask,
  deleteTask,
  editTask,
  linkTaskThreads,
  listTasks,
  splitTasks,
  tasksAtom,
  tasksInProject,
  tickTask,
  unlinkTaskThread,
  type Task,
  type TaskPatch,
} from "./tasks.ts";
import { paneClass } from "../../components/ui/Pane.tsx";

const ago = (at: number, now: number) => {
  const short = shortAgo(at, now);
  return short === "now" ? "just now" : `${short} ago`;
};

/** Starts a work thread with the task in its message box, in its project when it has one. */
export type HandOff = (task: Pick<Task, "id" | "title" | "note" | "folder">) => void;

interface TaskThreadAccess {
  readonly threads: ReadonlyMap<string, ThreadSummary>;
  readonly onOpenThread: (id: string) => void;
}

/**
 * The rail's Tasks page on a wide window: the list down the middle, and the picked task's detail
 * beside it.
 */
export function TasksPage({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className={`flex h-full overflow-hidden ${paneClass}`}>
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
  project,
  onProjectChange,
  threads,
  onOpenThread,
}: {
  selected: string | undefined;
  onSelect: (id: string) => void;
  onHandOff: HandOff;
  project: string | null | undefined;
  onProjectChange: (project: string | null | undefined) => void;
} & TaskThreadAccess) {
  const [store, setStore] = useAtom(tasksAtom);
  const [title, setTitle] = useState("");
  const compact = useCompact();
  const tasks = listTasks(store);
  const folders = [
    ...new Set(tasks.flatMap(({ folder }) => (folder === undefined ? [] : [folder]))),
  ].toSorted();
  const { open, done } = splitTasks(tasksInProject(tasks, project));

  const add = (handOff: boolean) => {
    const text = title.trim();
    if (text === "") return;
    const id = crypto.randomUUID();
    const task = { id, title: text, ...(project == null ? {} : { folder: project }) };
    setStore((latest) => addTask(latest, task, Date.now(), id));
    setTitle("");
    if (handOff) onHandOff(task);
  };
  const tick = (id: string, checked: boolean) => {
    setStore((latest) => tickTask(latest, id, checked, Date.now()));
  };

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col px-6 pt-10 pb-12 max-md:px-3 max-md:pt-1">
      <header className="mb-5 flex items-end gap-3 px-1 max-md:mb-3 max-md:px-1.5">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[22px] leading-tight font-semibold font-stretch-expanded [font-size-adjust:none] max-md:text-[20px]">
            Tasks
          </h1>
          <p className="mt-0.5 text-body text-fg-tertiary max-md:text-[14px]">
            {open.length > 0 ? `${open.length} to do` : done.length > 0 ? "All done" : "Nothing to do yet"}
          </p>
        </div>
        {/* Which project's tasks show: all of them, those without one, or one project's. */}
        <label className="-mr-1 flex min-w-0 shrink items-center gap-1 text-fg-tertiary">
          <span className="sr-only">Filter tasks by project</span>
          <FolderOpen size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <InlineSelect
            value={project === undefined ? "all" : project === null ? "none" : `project:${project}`}
            onChange={(event) => {
              const value = event.target.value;
              onProjectChange(
                value === "all" ? undefined : value === "none" ? null : value.slice("project:".length),
              );
            }}
            title={typeof project === "string" ? project : undefined}
            className={`max-w-52 ${project === undefined ? "[&_select]:text-fg-tertiary" : ""}`}
          >
            <option value="all">All projects</option>
            <option value="none">No project</option>
            {folders.map((folder) => (
              <option key={folder} value={`project:${folder}`}>
                {projectName(folder)} ({folder})
              </option>
            ))}
            {typeof project === "string" && !folders.includes(project) ? (
              <option value={`project:${project}`}>
                {projectName(project)} ({project})
              </option>
            ) : null}
          </InlineSelect>
        </label>
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
          className="h-full min-w-0 flex-1 bg-transparent text-reading text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[15px]"
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
            threads={threads}
            onOpenThread={onOpenThread}
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
                threads={threads}
                onOpenThread={onOpenThread}
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
  threads,
  onOpenThread,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
  onTick: (id: string, done: boolean) => void;
} & TaskThreadAccess) {
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
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 self-stretch rounded-md py-2 pr-3 text-left focus-visible:-outline-offset-2"
      >
        <span
          className={`min-w-0 flex-1 truncate text-reading max-md:text-[15px] ${
            done ? "text-fg-tertiary line-through decoration-fg-tertiary/60" : "text-fg-primary"
          } ${task.title.trim() === "" ? "text-fg-tertiary italic" : ""}`}
        >
          {task.title.trim() === "" ? "Untitled" : task.title}
        </span>
        {task.note ? <Text size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" /> : null}
        {task.folder ? (
          <span className="max-w-32 shrink-0 truncate text-meta text-fg-tertiary">
            {projectName(task.folder)}
          </span>
        ) : null}
      </Button>
      <TaskThreadLinks task={task} threads={threads} onOpenThread={onOpenThread} />
    </li>
  );
}

/** A task's own page: its title, a note, where an agent would work on it, and handing it to one. */
export function TaskDetail({
  id,
  onClose,
  onDeleted,
  onHandOff,
  threads,
  onOpenThread,
}: {
  id: string;
  /** Closes the detail; none on a phone, whose bar has the way back. */
  onClose?: () => void;
  onDeleted: () => void;
  onHandOff: HandOff;
} & TaskThreadAccess) {
  const [store, setStore] = useAtom(tasksAtom);
  const [picking, setPicking] = useState(false);
  const linksId = useId();
  const now = useMinute();
  const task = listTasks(store).find((each) => each.id === id);
  if (task === undefined) return null;
  const done = task.doneAt !== undefined;
  const available = [...threads.values()].filter((thread) => !task.threadIds?.includes(thread.id));
  const edit = (patch: TaskPatch) => {
    setStore((latest) => editTask(latest, id, patch, Date.now()));
  };
  const tick = (checked: boolean) => {
    setStore((latest) => tickTask(latest, id, checked, Date.now()));
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
            setStore((latest) => deleteTask(latest, id, Date.now()));
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
              className={`min-w-0 flex-1 resize-none bg-transparent py-0.5 text-reading leading-snug font-medium outline-none [field-sizing:content] placeholder:text-fg-tertiary max-md:text-[17px] ${
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
            className="mt-2 min-h-20 resize-none bg-transparent pl-[30px] text-body leading-relaxed text-fg-secondary outline-none [field-sizing:content] placeholder:text-fg-tertiary max-md:pl-[42px] max-md:text-[15px]"
          />

          <section
            aria-labelledby={linksId}
            className="mt-6 flex flex-col gap-2 border-t border-line-subtle pt-4"
          >
            <div className="flex min-h-6 items-center gap-2">
              <h3 id={linksId} className="text-meta font-medium text-fg-tertiary max-md:text-[13px]">
                Linked threads
              </h3>
              {available.length === 0 ? null : (
                <label className="-mr-1.5 ml-auto flex min-w-0 items-center">
                  <span className="sr-only">Link an existing thread</span>
                  <InlineSelect
                    value=""
                    onChange={(event) => {
                      const threadId = event.target.value;
                      if (threadId !== "")
                        setStore((latest) => linkTaskThreads(latest, id, [threadId], Date.now()));
                    }}
                    className="max-w-48 [&_select]:font-normal [&_select]:text-fg-tertiary"
                  >
                    <option value="" disabled>
                      Link a thread…
                    </option>
                    {available.map((thread) => (
                      <option key={thread.id} value={thread.id}>
                        {thread.title} ({thread.project ?? (thread.mode === "chat" ? "Chat" : "Work")})
                      </option>
                    ))}
                  </InlineSelect>
                </label>
              )}
            </div>
            {task.threadIds?.length ? (
              <TaskThreadLinks
                task={task}
                threads={threads}
                onOpenThread={onOpenThread}
                onUnlink={(threadId) =>
                  setStore((latest) => unlinkTaskThread(latest, id, threadId, Date.now()))
                }
              />
            ) : (
              <p className="text-meta text-fg-tertiary max-md:text-[13px]">
                Threads started from this task, or linked to it, show here with how they're doing.
              </p>
            )}
          </section>

          <section className="mt-6 flex flex-col gap-2.5 border-t border-line-subtle pt-4">
            <h3 className="text-meta font-medium text-fg-tertiary max-md:text-[13px]">Hand it to an agent</h3>
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
                className={`${buttonClass({ tone: "primary" })} ml-auto`}
              >
                Start
                <ArrowUpRight size={14} strokeWidth={2} />
              </Button>
            </div>
          </section>

          <p className="mt-6 text-meta text-fg-tertiary">
            Added {ago(task.createdAt, now)}
            {task.doneAt === undefined ? null : ` · done ${ago(task.doneAt, now)}`}
          </p>
        </div>
      </ScrollArea>
    </div>
  );
}

const threadStatus = {
  running: "Running",
  awaitingApproval: "Needs approval",
  idle: "Idle",
  failed: "Failed",
} satisfies Record<ThreadSummary["status"], string>;

/** A linked thread's state as a dot, in the colour its row in the sidebar shows. */
function StatusDot({ thread }: { thread: ThreadSummary | undefined }) {
  const offline = thread?.elsewhere?.online === false;
  const tone =
    thread === undefined || offline
      ? "border border-fg-tertiary"
      : thread.status === "running"
        ? "bg-running"
        : thread.status === "awaitingApproval"
          ? "bg-attention"
          : thread.status === "failed"
            ? "bg-error"
            : "bg-fg-tertiary/60";
  return (
    <span aria-hidden className="grid size-3 shrink-0 place-items-center">
      <span
        className={`size-1.5 rounded-full ${tone} ${
          thread?.status === "running" && !offline ? "motion-safe:animate-pulse" : ""
        }`}
      />
    </span>
  );
}

/**
 * The threads working on a task, each with how it's doing now: in a task's row, small and beside its
 * title; in its detail, a line each with a way to unlink it.
 */
function TaskThreadLinks({
  task,
  threads,
  onOpenThread,
  onUnlink,
}: TaskThreadAccess & {
  readonly task: Task;
  readonly onUnlink?: (id: string) => void;
}) {
  if (!task.threadIds?.length) return null;
  const detail = onUnlink !== undefined;
  return (
    <ul
      aria-label="Linked threads"
      className={detail ? "-mx-2 flex flex-col" : "flex max-w-[45%] shrink-0 items-center gap-1 pr-1.5"}
    >
      {task.threadIds.map((id) => {
        const thread = threads.get(id);
        const status =
          thread === undefined
            ? undefined
            : `${thread.elsewhere?.online === false ? "Computer offline" : threadStatus[thread.status]}${
                thread.archivedAt === undefined ? "" : " · Archived"
              }`;
        return (
          <li
            key={id}
            className={
              detail
                ? "group/link flex h-8 min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-surface-hover max-md:h-10"
                : "min-w-0"
            }
          >
            {thread === undefined ? (
              <span
                className={`flex min-w-0 items-center gap-1.5 text-fg-tertiary italic ${
                  detail ? "flex-1 px-2 text-body max-md:text-[15px]" : "h-6 px-1.5 text-caption"
                }`}
              >
                <StatusDot thread={undefined} />
                <span className="truncate">Thread unavailable</span>
              </span>
            ) : detail ? (
              <Button
                onClick={() => onOpenThread(id)}
                title={thread.title}
                className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <StatusDot thread={thread} />
                <span className="min-w-0 flex-1 truncate text-body text-fg-secondary group-hover/link:text-fg-primary max-md:text-[15px]">
                  {thread.title}
                </span>
                <span className="shrink-0 text-caption text-fg-tertiary max-md:text-[12px]">{status}</span>
              </Button>
            ) : (
              <Button
                onClick={() => onOpenThread(id)}
                title={`${thread.title} · ${status}`}
                className="flex h-6 max-w-full min-w-0 cursor-default items-center gap-1 rounded-md border border-line-subtle px-1.5 text-caption text-fg-tertiary transition-colors outline-none hover:bg-surface-hover hover:text-fg-secondary focus-visible:ring-2 focus-visible:ring-focus-ring max-md:h-8 max-md:text-[12px]"
              >
                <StatusDot thread={thread} />
                <span className="min-w-0 truncate">{status}</span>
              </Button>
            )}
            {onUnlink === undefined ? null : (
              <Tooltip label="Unlink from this task" side="left">
                <Button
                  aria-label={`Unlink ${thread?.title ?? "unavailable thread"}`}
                  onClick={() => onUnlink(id)}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-surface-active hover:text-fg-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none group-hover/link:opacity-100 pointer-coarse:opacity-100 max-md:size-9 max-md:opacity-100"
                >
                  <X size={13} strokeWidth={1.75} />
                </Button>
              </Tooltip>
            )}
          </li>
        );
      })}
    </ul>
  );
}
