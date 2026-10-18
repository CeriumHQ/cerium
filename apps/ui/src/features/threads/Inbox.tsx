import { Button } from "@base-ui/react/button";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Archive,
  CheckCheck,
  ChevronDown,
  GitBranch,
  ListFilter,
  Mail,
  MailOpen,
  Pencil,
  SquarePen,
  Trash2,
  Monitor,
} from "lucide-react";
import { useState } from "react";

import {
  ContextMenuArea,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/Menu.tsx";
import { gitBranchAtom } from "../../backend/projects.ts";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { remember, stored } from "../../lib/storage.ts";
import { shortAgo } from "../../lib/time.ts";
import { inboxProjects, inboxSections, type ThreadSection } from "./sections.ts";
import { ArchivedSection } from "./Archived.tsx";
import { DeleteThreadDialog } from "./Delete.tsx";
import { canArchive, canDelete, type ThreadSummary } from "./model.ts";
import { ProjectBadge } from "./ProjectBadge.tsx";
import { TitleField, useRename, type RenameThread } from "./Rename.tsx";
import { CornerStatus, ProviderStack } from "./StatusIndicator.tsx";

const SCOPE_KEY = "cerium:inboxScope";

interface InboxProps {
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Archived threads, listed apart at the foot. */
  readonly archived: ReadonlyArray<ThreadSummary>;
  readonly onRestore: (threadId: string) => void;
  readonly selectedId: string | undefined;
  readonly onSelect: (threadId: string) => void;
  readonly onMarkRead: (threads: ReadonlyArray<ThreadSummary>) => void;
  readonly onMarkUnread: (threadId: string) => void;
  /** Opens a new thread in the folder, ready to type. */
  readonly onNewThreadIn: (folder: string) => void;
  readonly onRename: RenameThread;
  readonly onArchive: (threadId: string) => void;
  readonly onDelete: (threadId: string) => void;
}

type RowProps = Omit<InboxProps, "threads" | "archived" | "onRestore"> & {
  /** The folder the inbox is scoped to, if any. */
  readonly scope: string | undefined;
  readonly onScope: (folder: string) => void;
};

/** Every project's work threads in one list, what needs the user first; optionally scoped to one folder. */
export function Inbox({ threads, archived, onRestore, ...actions }: InboxProps) {
  const projects = inboxProjects(threads);
  /** The folder the inbox is scoped to; empty for every project. */
  const [scope, setScope] = useState(() => stored(SCOPE_KEY) ?? "");
  // A remembered folder with no threads left falls back to every project.
  const project = projects.find((candidate) => candidate.folder === scope);
  const inScope = (thread: ThreadSummary) => project === undefined || thread.folder === project.folder;
  const scoped = threads.filter(inScope);
  const sections = inboxSections(scoped);
  const unread = scoped.filter((thread) => thread.unread);

  const chooseScope = (folder: string) => {
    remember(SCOPE_KEY, folder);
    setScope(folder);
  };

  return (
    <>
      <div className="flex items-center gap-2 pr-2 pb-1.5 pl-4">
        <h2 className="text-[13px] font-semibold text-fg-primary max-md:text-[15px]">Inbox</h2>
        <MenuRoot>
          <MenuTrigger>
            <Button
              aria-label="Projects shown"
              className="ml-auto flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-hover data-popup-open:text-fg-secondary max-md:h-9 max-md:px-2 max-md:text-[13px]"
            >
              <span className="truncate">{project?.name ?? "All projects"}</span>
              <ChevronDown size={12} strokeWidth={2} className="shrink-0" />
            </Button>
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuRadioGroup
              value={project?.folder ?? ""}
              onValueChange={(value: string) => chooseScope(value)}
            >
              <MenuRadioItem value="">All projects</MenuRadioItem>
              {projects.length > 0 ? (
                <>
                  <MenuSeparator />
                  <MenuGroupLabel>Projects</MenuGroupLabel>
                </>
              ) : null}
              {projects.map(({ folder, name }) => (
                <MenuRadioItem key={folder} value={folder}>
                  <span className="truncate" title={folder}>
                    {name}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem
              icon={CheckCheck}
              disabled={unread.length === 0}
              onClick={() => actions.onMarkRead(unread)}
            >
              Mark all as read
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      </div>

      <ScrollArea className="flex-1">
        <nav className="flex flex-col gap-3 px-2 pb-3" aria-label="Threads">
          {sections.map((section, index) => (
            <InboxSection
              key={section.key}
              section={section}
              // Today's threads leading the list need no heading; below a status section they do.
              headed={!(index === 0 && section.key === "Today")}
              scope={project?.folder}
              onScope={chooseScope}
              {...actions}
            />
          ))}
          {sections.length === 0 ? (
            <p className="px-2 py-1.5 text-xs leading-relaxed text-fg-tertiary">
              Threads you start in any folder show up here, the ones that need you first.
            </p>
          ) : null}
        </nav>
      </ScrollArea>

      <ArchivedSection
        threads={archived.filter(inScope)}
        selectedId={actions.selectedId}
        onSelect={actions.onSelect}
        onRename={actions.onRename}
        onRestore={onRestore}
        onDelete={actions.onDelete}
      />
    </>
  );
}

function InboxSection({
  section,
  headed,
  ...rowProps
}: { section: ThreadSection; headed: boolean } & RowProps) {
  return (
    <section aria-label={section.label}>
      {headed ? (
        <h3 className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-fg-secondary/80">
          {section.label}
          {section.kind === "status" ? (
            <span className="text-fg-tertiary tabular-nums">{section.threads.length}</span>
          ) : null}
        </h3>
      ) : null}
      <ul className="flex flex-col gap-px">
        {section.threads.map((thread) => (
          <li key={thread.id}>
            <InboxRow thread={thread} {...rowProps} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function InboxRow({
  thread,
  selectedId,
  onSelect,
  onMarkRead,
  onMarkUnread,
  onNewThreadIn,
  onRename,
  onArchive,
  onDelete,
  scope,
  onScope,
}: { thread: ThreadSummary } & RowProps) {
  const selected = thread.id === selectedId;
  const [deleting, setDeleting] = useState(false);
  const unread = thread.unread && !selected;
  const { editing, start, finish, title, row } = useRename(thread, onRename);
  const { folder, project } = thread;
  const rowClass = `flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 data-popup-open:bg-surface-hover max-md:gap-3 max-md:rounded-lg max-md:py-2.5 ${
    selected || editing
      ? "bg-surface-selected text-fg-primary"
      : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
  }`;
  const titleClass = `min-w-0 flex-1 truncate text-[13px] leading-5 max-md:text-[15px] max-md:leading-6 ${unread ? "font-medium text-fg-primary" : ""}`;
  const content = (
    <>
      <span className="relative mt-px shrink-0">
        {folder && project ? (
          <ProjectBadge folder={folder} name={project} lookup={thread.elsewhere === undefined} />
        ) : (
          <span className="block size-4.5" />
        )}
        <CornerStatus status={thread.status} unread={unread} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          {editing ? (
            <TitleField title={thread.title} onDone={finish} className={`-mx-1 ${titleClass}`} />
          ) : (
            <span className={titleClass}>{title}</span>
          )}
          <span className="shrink-0 text-2xs text-fg-tertiary tabular-nums max-md:text-xs">
            {shortAgo(thread.updatedAt)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-fg-tertiary max-md:text-xs">
          {thread.machine ? (
            <MachineLabel name={thread.machine} online={thread.elsewhere?.online ?? true} />
          ) : null}
          {project ? <span className="max-w-[55%] shrink-0 truncate">{project}</span> : null}
          {folder && thread.elsewhere === undefined ? <Branch folder={folder} /> : null}
          <span className="ml-auto shrink-0 pl-1">
            <ProviderStack providers={thread.providers} />
          </span>
        </span>
      </span>
    </>
  );

  // While renaming, the row is a field rather than a button, and right-clicks get the text menu.
  if (editing) return <div className={rowClass}>{content}</div>;
  return (
    <>
      <ContextMenuArea
        menu={
          <>
            {thread.unread ? (
              <MenuItem icon={MailOpen} onClick={() => onMarkRead([thread])}>
                Mark as read
              </MenuItem>
            ) : (
              <MenuItem icon={Mail} onClick={() => onMarkUnread(thread.id)}>
                Mark as unread
              </MenuItem>
            )}
            {folder && project ? (
              <>
                {thread.elsewhere ? null : (
                  <MenuItem icon={SquarePen} onClick={() => onNewThreadIn(folder)}>
                    <span className="max-w-64 truncate">New thread in {project}</span>
                  </MenuItem>
                )}
                {scope === folder ? (
                  <MenuItem icon={ListFilter} onClick={() => onScope("")}>
                    Show all projects
                  </MenuItem>
                ) : (
                  <MenuItem icon={ListFilter} onClick={() => onScope(folder)}>
                    <span className="max-w-64 truncate">Show only {project}</span>
                  </MenuItem>
                )}
              </>
            ) : null}
            {/* Renaming, archiving and deleting happen on the thread's own machine: open it there. */}
            {thread.elsewhere ? null : (
              <>
                <MenuSeparator />
                <MenuItem icon={Pencil} onClick={start}>
                  Rename
                </MenuItem>
                <MenuItem icon={Archive} disabled={!canArchive(thread)} onClick={() => onArchive(thread.id)}>
                  Archive
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={Trash2}
                  tone="danger"
                  disabled={!canDelete(thread)}
                  onClick={() => setDeleting(true)}
                >
                  Delete
                </MenuItem>
              </>
            )}
          </>
        }
      >
        <Button
          ref={row}
          onClick={() => onSelect(thread.id)}
          aria-current={selected ? "page" : undefined}
          className={rowClass}
        >
          {content}
        </Button>
      </ContextMenuArea>
      <DeleteThreadDialog
        thread={thread}
        open={deleting}
        onOpenChange={setDeleting}
        onConfirm={() => onDelete(thread.id)}
      />
    </>
  );
}

/** The computer a thread lives on, when it isn't this one; faint while it's offline. */
function MachineLabel({ name, online }: { name: string; online: boolean }) {
  return (
    <span
      className={`flex max-w-[45%] min-w-0 shrink-0 items-center gap-1 ${online ? "" : "opacity-60"}`}
      title={online ? `On ${name}` : `On ${name}, which is offline`}
    >
      <Monitor size={10} strokeWidth={2} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** The branch checked out in the thread's folder; nothing outside git. */
function Branch({ folder }: { folder: string }) {
  const branch = AsyncResult.getOrElse(useAtomValue(gitBranchAtom(folder)), () => undefined);
  if (branch === undefined) return null;
  return (
    <span className="flex min-w-0 items-center gap-0.5" title={branch}>
      <GitBranch size={10} strokeWidth={2} className="shrink-0" aria-hidden />
      <span className="truncate">{branch}</span>
    </span>
  );
}
