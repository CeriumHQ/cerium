import { Button } from "@base-ui/react/button";
import {
  Archive,
  CheckCheck,
  ChevronDown,
  Inbox as InboxIcon,
  ListFilter,
  Mail,
  MailOpen,
  Pencil,
  SquarePen,
  Trash2,
} from "lucide-react";
import { Fragment, useState } from "react";

import {
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/Menu.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { remember, stored } from "../../lib/storage.ts";
import type { NewThreadDraft } from "../composer/drafts.ts";
import { inboxProjects, inboxSections, type ThreadSection } from "./sections.ts";
import { ArchivedSection } from "./Archived.tsx";
import { DraftSection, type DraftActions } from "./DraftRow.tsx";
import { EmptyList } from "./EmptyList.tsx";
import { canArchive, canDelete, type ThreadSummary } from "./model.ts";
import { ProjectBadge } from "./ProjectBadge.tsx";
import { type RenameThread } from "./Rename.tsx";
import { ThreadRow, type RowControls, type RowMark } from "./ThreadRow.tsx";

const SCOPE_KEY = "cerium:inboxScope";

interface InboxProps {
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Threads not started yet, listed under what needs the user. */
  readonly drafts: ReadonlyArray<NewThreadDraft>;
  readonly draftActions: DraftActions;
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

type RowProps = Omit<InboxProps, "threads" | "drafts" | "draftActions" | "archived" | "onRestore"> & {
  /** The folder the inbox is scoped to, if any. */
  readonly scope: string | undefined;
  readonly onScope: (folder: string) => void;
  /** What leads each row; see `RowMark`. */
  readonly mark: RowMark;
  /** Whether the threads in view use more than one harness, which makes each row's worth saying. */
  readonly harness: boolean;
};

/**
 * Every project's work threads in one list, what needs the user first; optionally scoped to one
 * folder. A row says only what tells it apart: its project badge when the list spans projects, its
 * harness when the list spans harnesses.
 */
export function Inbox({ threads, drafts, draftActions, archived, onRestore, ...actions }: InboxProps) {
  const projects = inboxProjects(threads);
  /** The folder the inbox is scoped to; empty for every project. */
  const [scope, setScope] = useState(() => stored(SCOPE_KEY) ?? "");
  // A remembered folder with no threads left falls back to every project.
  const project = projects.find((candidate) => candidate.folder === scope);
  const inScope = (thread: ThreadSummary) => project === undefined || thread.folder === project.folder;
  const scoped = threads.filter(inScope);
  const sections = inboxSections(scoped);
  // A draft with no project chosen yet shows in every scope.
  const scopedDrafts = drafts.filter(
    (draft) => project === undefined || draft.folder === undefined || draft.folder === project.folder,
  );
  // Drafts follow what needs the user: a request waiting on them still comes first.
  const needsYou = sections.filter((section) => section.key === "needsYou");
  const rest = sections.filter((section) => section.key !== "needsYou");
  const unread = scoped.filter((thread) => thread.unread);
  const inView = [...scoped, ...archived.filter(inScope)];
  const mark: RowMark = new Set(inView.map((thread) => thread.folder)).size > 1 ? "badge" : "dot";
  const harness = new Set(inView.flatMap((thread) => thread.providers)).size > 1;

  const chooseScope = (folder: string) => {
    remember(SCOPE_KEY, folder);
    setScope(folder);
  };

  return (
    <>
      <div className="flex items-center gap-1 pr-2 pb-1.5 pl-4">
        <h2 className="text-[13px] font-semibold text-fg-primary max-md:text-[15px]">Inbox</h2>
        <div className="ml-auto flex min-w-0 items-center gap-0.5">
          {projects.length > 1 ? (
            <MenuRoot>
              <MenuTrigger>
                <Button
                  aria-label="Projects shown"
                  className="flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-hover data-popup-open:text-fg-secondary max-md:h-9 max-md:px-2 max-md:text-[13px]"
                >
                  {project ? <ProjectBadge folder={project.folder} name={project.name} size="small" /> : null}
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
                  <MenuSeparator />
                  <MenuGroupLabel>Projects</MenuGroupLabel>
                  {projects.map(({ folder, name }) => (
                    <MenuRadioItem key={folder} value={folder}>
                      <ProjectBadge folder={folder} name={name} size="small" />
                      <span className="truncate" title={folder}>
                        {name}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </MenuRoot>
          ) : null}
          {unread.length > 0 ? (
            <IconButton
              icon={CheckCheck}
              label="Mark all as read"
              onClick={() => actions.onMarkRead(unread)}
              className="max-md:size-9"
            />
          ) : null}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <nav className="flex flex-col gap-3 px-2 pb-3" aria-label="Threads">
          {[...needsYou, ...rest].map((section, index) => (
            <Fragment key={section.key}>
              {index === needsYou.length ? (
                <DraftSection drafts={scopedDrafts} list="inbox" mark={mark} {...draftActions} />
              ) : null}
              <InboxSection
                section={section}
                // Today's threads leading the list need no heading; below drafts or a status section they do.
                headed={!(index === 0 && section.key === "Today" && scopedDrafts.length === 0)}
                scope={project?.folder}
                onScope={chooseScope}
                mark={mark}
                harness={harness}
                {...actions}
              />
            </Fragment>
          ))}
          {rest.length === 0 ? (
            <DraftSection drafts={scopedDrafts} list="inbox" mark={mark} {...draftActions} />
          ) : null}
          {sections.length === 0 && scopedDrafts.length === 0 ? (
            <EmptyList
              icon={InboxIcon}
              title="No threads yet"
              hint="Threads from every project gather here."
            />
          ) : null}
        </nav>
      </ScrollArea>

      <ArchivedSection
        threads={archived.filter(inScope)}
        selectedId={actions.selectedId}
        mark={mark}
        harness={harness}
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
  mark,
  harness,
}: { thread: ThreadSummary } & RowProps) {
  const { folder, project } = thread;
  const menu = ({ rename, remove }: RowControls) => (
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
          <MenuItem icon={Pencil} onClick={rename}>
            Rename
          </MenuItem>
          <MenuItem icon={Archive} disabled={!canArchive(thread)} onClick={() => onArchive(thread.id)}>
            Archive
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash2} tone="danger" disabled={!canDelete(thread)} onClick={remove}>
            Delete
          </MenuItem>
        </>
      )}
    </>
  );
  return (
    <ThreadRow
      thread={thread}
      selected={thread.id === selectedId}
      mark={mark}
      harness={harness}
      onSelect={onSelect}
      onRename={onRename}
      onDelete={onDelete}
      menu={menu}
    />
  );
}
