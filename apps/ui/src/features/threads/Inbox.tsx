import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  CheckCheck,
  Clock,
  Inbox as InboxIcon,
  ListFilter,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
  Undo2,
} from "lucide-react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import {
  memo,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

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
import { Reveal } from "../../components/Reveal.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { BulkBar, useBulkSelection, type SelectMode } from "./BulkBar.tsx";
import { useArrivals, useGlide, useLingering } from "../../lib/motion.ts";
import { usePaging } from "../../lib/paging.ts";
import { remember, stored } from "../../lib/storage.ts";
import type { NewThreadDraft } from "../composer/drafts.ts";
import { inboxProjects, inboxSections } from "./sections.ts";
import { ExportMenuItems } from "../export/ExportItems.tsx";
import { DraftRow, type DraftActions } from "./DraftRow.tsx";
import { EmptyList } from "./EmptyList.tsx";
import { InboxCard, type CardAction } from "./InboxCard.tsx";
import {
  backLabel,
  canArchive,
  canDelete,
  boxOf,
  groupRuns,
  isPutOff,
  type InboxBox,
  type InboxEntry,
  laterTime,
  laterWork,
  needsYou,
  overflow,
  runSummary,
  sameSummary,
  type ThreadSummary,
} from "./model.ts";
import { pinnedAtom, togglePin, withPinned } from "./pins.ts";
import { ProjectBadge } from "./ProjectBadge.tsx";
import { type RenameThread } from "./Rename.tsx";
import { RunScoreboard } from "./RunScoreboard.tsx";
import type { RowControls } from "./ThreadRow.tsx";

const SCOPE_KEY = "cerium:inboxScope";
const BOX_KEY = "cerium:inboxBox";

/** A thread this new set the inbox's cap working, the first time this window sees it. */
const FRESH = 2 * 60_000;
/** How long the note about threads the cap archived stays, with its Undo. */
const NOTE_FOR = 6_000;

interface InboxProps {
  /** Work threads in the inbox or put off for later. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Threads not started yet, listed under what needs the user. */
  readonly drafts: ReadonlyArray<NewThreadDraft>;
  readonly draftActions: DraftActions;
  readonly archived: ReadonlyArray<ThreadSummary>;
  /** Threads open in a tab, which the cap leaves alone. */
  readonly open: ReadonlyArray<string>;
  readonly selectedId: string | undefined;
  /** Opens the thread; `newTab` keeps it in a tab of its own rather than the preview. */
  readonly onSelect: (threadId: string, newTab?: boolean) => void;
  readonly onMarkRead: (threads: ReadonlyArray<ThreadSummary>) => void;
  readonly onMarkUnread: (threadId: string) => void;
  /** Opens a new thread in the folder, ready to type. */
  readonly onNewThreadIn: (folder: string) => void;
  readonly onRename: RenameThread;
  /** Each resolves whether the thread went, so the bulk bar reports what worked. */
  readonly onArchive: (threadId: string) => Promise<boolean>;
  readonly onRestore: (threadId: string) => Promise<boolean>;
  /** Puts a thread off until then, or brings it back; absent where the machine can't. */
  readonly onLater: ((threadId: string, until: number | undefined) => Promise<boolean>) | undefined;
  readonly onDelete: (threadId: string) => Promise<boolean>;
  /** Opens a thread in a window of its own; absent where there are no such windows. */
  readonly onOpenWindow: ((threadId: string) => void) | undefined;
}

/**
 * Every project's work threads, in lists: the inbox, what needs the user first, which keeps
 * `INBOX_CAP` threads by archiving the oldest quiet one as a new one starts; Drafts, threads not sent
 * yet; Later, what the user put off until tomorrow; and Archive. Each can be scoped to one folder.
 */
export function Inbox({
  threads,
  drafts,
  draftActions,
  archived,
  open,
  selectedId,
  onSelect,
  onMarkRead,
  onMarkUnread,
  onNewThreadIn,
  onRename,
  onArchive,
  onRestore,
  onLater,
  onDelete,
  onOpenWindow,
}: InboxProps) {
  const now = useNowPast(threads.map((thread) => thread.laterUntil));
  // The list chosen is remembered, so it stays put when the sidebar mounts again, as it does across
  // window sizes.
  const [box, setBox] = useState<InboxBox>(() => {
    const saved = stored(BOX_KEY);
    return saved === "drafts" || saved === "later" || saved === "archive" ? saved : "inbox";
  });
  const chooseBox = (next: InboxBox) => {
    remember(BOX_KEY, next);
    setBox(next);
  };
  // The list follows what opens: a draft shows Drafts, a new thread the inbox, and a thread opened
  // from the palette the list it's in. Only a different one counts: the selection drops out for a
  // moment while a file or settings shows.
  const [followed, setFollowed] = useState(selectedId);
  if (selectedId !== undefined && followed !== selectedId) {
    setFollowed(selectedId);
    setBox(
      drafts.some((draft) => draft.key === selectedId)
        ? "drafts"
        : boxOf(
            [...threads, ...archived].find((thread) => thread.id === selectedId),
            now,
          ),
    );
  }
  const pins = useAtomValue(pinnedAtom);
  const projects = inboxProjects([...threads, ...archived]);
  /** The folder the lists are scoped to; empty for every project. */
  const [scope, setScope] = useState(() => stored(SCOPE_KEY) ?? "");
  // A remembered folder with no threads left falls back to every project.
  const project = projects.find((candidate) => candidate.folder === scope);
  const inScope = (thread: ThreadSummary) => project === undefined || thread.folder === project.folder;
  const chooseScope = (folder: string) => {
    remember(SCOPE_KEY, folder);
    setScope(folder);
  };

  const inbox = threads.filter((thread) => !isPutOff(thread, now));
  const later = laterWork(threads, now).filter(inScope);
  const archive = archived.filter(inScope);
  const sections = inboxSections(inbox.filter(inScope), now);
  // What needs the user leads, then pinned threads, then the rest.
  const listed = [
    ...sections.filter((section) => section.key === "needsYou"),
    ...withPinned(
      sections.filter((section) => section.key !== "needsYou"),
      pins,
    ),
  ].flatMap(({ threads }) => threads);
  // A draft with no project chosen yet shows in every scope.
  const scopedDrafts = drafts.filter(
    (draft) => project === undefined || draft.folder === undefined || draft.folder === project.folder,
  );
  const unread = listed.filter((thread) => thread.unread);

  const note = useCap(inbox, (thread) => pins.includes(thread.id) || open.includes(thread.id), {
    selectedId,
    onArchive,
    onRestore,
  });

  const actions = useSteadyActions({
    onSelect,
    onMarkRead,
    onMarkUnread,
    onNewThreadIn,
    onRename,
    onArchive,
    onRestore,
    onLater,
    onDelete,
    onOpenWindow,
  });
  // Built from each prop rather than the rest of them, so it keeps its identity while only the drafts
  // change, as they do with every key typed into a new thread's first line: the lists' rows, all of
  // the Archive's among them, then don't render again.
  const rowProps: RowProps = {
    selectedId,
    ...actions,
    scope: project?.folder,
    onScope: chooseScope,
  };

  // Bulk picking, in the showing list's order so Shift click ticks a run of it. The pick drops
  // when the list changes; what an action moves away drops out of the list by itself.
  const ordered = useMemo<ReadonlyArray<string>>(() => {
    if (box === "later") return later.map((thread) => thread.id);
    if (box === "archive") return archive.map((thread) => thread.id);
    return groupRuns(listed).flatMap((entry) =>
      entry.kind === "thread" ? [entry.thread.id] : entry.threads.map((thread) => thread.id),
    );
  }, [box, listed, later, archive]);
  const {
    selected: picked,
    toggle: togglePicked,
    setAll: setPicked,
    clear: clearPicked,
  } = useBulkSelection(ordered);
  useEffect(() => clearPicked(), [box, scope, clearPicked]);
  const byId = useMemo(() => {
    const known = new Map<string, ThreadSummary>();
    for (const thread of [...threads, ...archived]) known.set(thread.id, thread);
    return known;
  }, [threads, archived]);
  const pickedHere = useMemo(() => {
    const ticked = new Set(picked);
    return ordered.flatMap((id) => {
      const thread = byId.get(id);
      return thread !== undefined && ticked.has(id) ? [thread] : [];
    });
  }, [ordered, picked, byId]);
  /** What a bulk action says it did, and which threads it skipped with why; shown for a moment. */
  const [bulkNote, setBulkNote] = useState<string>();
  useEffect(() => {
    if (bulkNote === undefined) return;
    const timer = setTimeout(() => setBulkNote(undefined), NOTE_FOR);
    return () => clearTimeout(timer);
  }, [bulkNote]);
  const bulkBar = (forBox: InboxBox) =>
    forBox !== box || pickedHere.length === 0 ? null : (
      <BulkBar
        box={forBox}
        threads={pickedHere}
        onArchive={actions.onArchive}
        onRestore={actions.onRestore}
        onLater={forBox === "inbox" ? actions.onLater : undefined}
        onMarkRead={actions.onMarkRead}
        onDelete={actions.onDelete}
        onSettled={(taken) => setPicked(taken, false)}
        onNote={setBulkNote}
      />
    );
  // Esc clears the pick, unless it belongs to a field, a menu or a dialog.
  const clearOnEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || picked.length === 0) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, [role='dialog'], [role='alertdialog'], [role='menu']")
    ) {
      return;
    }
    clearPicked();
  });
  useEffect(() => {
    window.addEventListener("keydown", clearOnEscape);
    return () => window.removeEventListener("keydown", clearOnEscape);
  }, []);

  return (
    <Tabs.Root
      value={box}
      onValueChange={(value) => chooseBox(value as InboxBox)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center gap-1 px-2 pb-2.5">
        <Tabs.List
          className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none]"
          aria-label="Threads"
        >
          <BoxTab value="inbox" label="Inbox" />
          {/* Drafts come and go, so their tab shows only while there are some. */}
          {scopedDrafts.length > 0 || box === "drafts" ? (
            <BoxTab value="drafts" label="Drafts" count={scopedDrafts.length} />
          ) : null}
          <BoxTab value="later" label="Later" count={later.length} />
          {/* The archive only grows, so a count there would say nothing. */}
          <BoxTab value="archive" label="Archive" />
        </Tabs.List>
        {/* One menu for the view: which projects show, and marking the inbox read. */}
        {projects.length > 1 || unread.length > 0 ? (
          <MenuRoot>
            <Tooltip label={project?.name ?? (projects.length > 1 ? "All projects" : "View")}>
              <MenuTrigger>
                <Button
                  aria-label={projects.length > 1 ? `Projects shown: ${project?.name ?? "all"}` : "View"}
                  className="ml-auto grid size-6.5 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-hover data-popup-open:text-fg-secondary max-md:size-9"
                >
                  {project ? (
                    <ProjectBadge folder={project.folder} name={project.name} size="small" />
                  ) : (
                    <ListFilter size={14} strokeWidth={1.75} />
                  )}
                </Button>
              </MenuTrigger>
            </Tooltip>
            <MenuPopup align="end">
              {unread.length > 0 ? (
                <MenuItem icon={CheckCheck} onClick={() => onMarkRead(unread)}>
                  Mark all as read
                </MenuItem>
              ) : null}
              {projects.length > 1 ? (
                <>
                  {unread.length > 0 ? <MenuSeparator /> : null}
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
                </>
              ) : null}
            </MenuPopup>
          </MenuRoot>
        ) : null}
      </div>

      {bulkNote === undefined ? null : (
        <div className="px-4 pt-0 pb-2 text-meta text-fg-tertiary max-md:text-[13px]">
          <output className="block truncate" title={bulkNote}>
            {bulkNote}
          </output>
        </div>
      )}

      <BoxPanel
        value="inbox"
        label="Inbox"
        empty={
          listed.length > 0 ? undefined : threads.length + archived.length + drafts.length > 0 ? (
            "You're all caught up."
          ) : (
            <EmptyList
              icon={InboxIcon}
              title="No threads yet"
              hint="Threads from every project gather here."
            />
          )
        }
        bar={bulkBar("inbox")}
      >
        <Entries
          threads={listed}
          box="inbox"
          now={now}
          picked={picked}
          onToggle={togglePicked}
          setAll={setPicked}
          {...rowProps}
        />
      </BoxPanel>
      {box === "inbox" && note ? (
        <div className="flex items-baseline gap-2 border-t border-line-subtle px-4 pt-2 pb-1 text-meta text-fg-tertiary max-md:text-[13px]">
          <output className="min-w-0 flex-1 truncate">{note.label}</output>
          <Button
            onClick={note.undo}
            className="font-medium text-fg-secondary transition-colors hover:text-fg-primary"
          >
            Undo
          </Button>
        </div>
      ) : null}

      <BoxPanel value="drafts" label="Drafts" empty={scopedDrafts.length === 0 ? "No drafts." : undefined}>
        {scopedDrafts.map((draft) => (
          <li key={draft.key}>
            <DraftRow draft={draft} mark="badge" card {...draftActions} />
          </li>
        ))}
      </BoxPanel>

      <BoxPanel
        value="later"
        label="Later"
        empty={later.length === 0 ? "Nothing put off." : undefined}
        bar={bulkBar("later")}
      >
        <Entries
          threads={later}
          box="later"
          now={now}
          picked={picked}
          onToggle={togglePicked}
          setAll={setPicked}
          {...rowProps}
        />
      </BoxPanel>

      <BoxPanel
        value="archive"
        label="Archive"
        empty={archive.length === 0 ? "Nothing archived yet." : undefined}
        bar={bulkBar("archive")}
      >
        <Entries
          threads={archive}
          box="archive"
          now={now}
          picked={picked}
          onToggle={togglePicked}
          setAll={setPicked}
          {...rowProps}
        />
      </BoxPanel>
    </Tabs.Root>
  );
}

function BoxTab({ value, label, count = 0 }: { value: InboxBox; label: string; count?: number }) {
  return (
    <Tabs.Tab
      value={value}
      className="flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 text-meta font-medium text-fg-secondary transition-colors duration-150 outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-focus-ring data-active:bg-surface-selected data-active:text-fg-primary max-md:h-9 max-md:px-2.5 max-md:text-sm"
    >
      {label}
      {count > 0 ? <span className="font-normal text-fg-tertiary tabular-nums">{count}</span> : null}
    </Tabs.Tab>
  );
}

/** One list's rows; `empty`, a line of text or a whole empty state, when it has none. */
function BoxPanel({
  value,
  label,
  empty,
  bar,
  children,
}: {
  value: InboxBox;
  label: string;
  empty: ReactNode;
  /** The bulk-action bar, while threads of this list are picked. */
  bar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tabs.Panel value={value} className="flex min-h-0 flex-1 flex-col pt-0 outline-none">
      {bar}
      <ScrollArea className="flex-1">
        <nav aria-label={label} className="px-2 pb-3">
          <ul className="flex flex-col gap-0.5">{children}</ul>
          {typeof empty === "string" ? (
            <p className="px-2 py-12 text-center text-meta text-fg-tertiary max-md:text-sm">{empty}</p>
          ) : (
            empty
          )}
        </nav>
      </ScrollArea>
    </Tabs.Panel>
  );
}

/** The time now, moving on by itself when the next of `times` passes, so put-off threads come back. */
function useNowPast(times: ReadonlyArray<number | undefined>): number {
  const [now, setNow] = useState(Date.now);
  const next = Math.min(...times.filter((time) => time !== undefined && time > now).map(Number));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    // Timers can't wait longer than about 24 days; a later one just sets another.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - Date.now() + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}

/**
 * Keeps the inbox to `INBOX_CAP` threads: as a new thread arrives, the oldest quiet ones beyond it are
 * archived, and a note offers to bring them back.
 */
function useCap(
  inbox: ReadonlyArray<ThreadSummary>,
  keep: (thread: ThreadSummary) => boolean,
  { selectedId, onArchive, onRestore }: Pick<InboxProps, "selectedId" | "onArchive" | "onRestore">,
) {
  const [note, setNote] = useState<{ label: string; undo: () => void }>();
  /** Threads already looked at, so only a new one sets the cap working, and only once. */
  const seen = useRef(new Set<string>());
  const settle = useEffectEvent(() => {
    const at = Date.now();
    const fresh = inbox.some(
      (thread) =>
        !seen.current.has(thread.id) && thread.createdAt !== undefined && at - thread.createdAt < FRESH,
    );
    for (const thread of inbox) seen.current.add(thread.id);
    if (!fresh) return;
    const gone = overflow(inbox, (thread) => thread.id === selectedId || keep(thread), at);
    if (gone.length === 0) return;
    for (const thread of gone) void onArchive(thread.id);
    // The note shows once this effect is done, rather than rendering again inside it.
    queueMicrotask(() =>
      setNote({
        label: gone.length === 1 ? `Archived “${gone[0]!.title}”` : `Archived ${gone.length} older threads`,
        undo: () => {
          for (const thread of gone) void onRestore(thread.id);
          setNote(undefined);
        },
      }),
    );
  });
  const ids = inbox.map((thread) => thread.id).join(" ");
  useEffect(() => settle(), [ids]);
  useEffect(() => {
    if (note === undefined) return;
    const timer = setTimeout(() => setNote(undefined), NOTE_FOR);
    return () => clearTimeout(timer);
  }, [note]);
  return note;
}

type RowProps = Omit<InboxProps, "threads" | "drafts" | "draftActions" | "archived" | "open"> & {
  /** The folder the lists are scoped to, if any. */
  readonly scope: string | undefined;
  readonly onScope: (folder: string) => void;
};

/** What a row does to its threads. */
type RowActions = Pick<
  InboxProps,
  | "onSelect"
  | "onMarkRead"
  | "onMarkUnread"
  | "onNewThreadIn"
  | "onRename"
  | "onArchive"
  | "onRestore"
  | "onLater"
  | "onDelete"
  | "onOpenWindow"
>;

/**
 * `actions` as functions that stay the same from one render to the next and call the latest given.
 * The window makes them afresh each time it renders, so rows that took them as they came all rendered
 * again, menus and tooltips and all, each time another thread opened.
 */
function useSteadyActions(actions: RowActions): RowActions {
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });
  const [steady] = useState((): RowActions => ({
    onSelect: (threadId, newTab) => latest.current.onSelect(threadId, newTab),
    onMarkRead: (threads) => latest.current.onMarkRead(threads),
    onMarkUnread: (threadId) => latest.current.onMarkUnread(threadId),
    onNewThreadIn: (folder) => latest.current.onNewThreadIn(folder),
    onRename: (threadId, title) => latest.current.onRename(threadId, title),
    onArchive: (threadId) => latest.current.onArchive(threadId),
    onRestore: (threadId) => latest.current.onRestore(threadId),
    onLater: (threadId, until) => latest.current.onLater?.(threadId, until) ?? Promise.resolve(false),
    onDelete: (threadId) => latest.current.onDelete(threadId),
    onOpenWindow: (threadId) => latest.current.onOpenWindow?.(threadId),
  }));
  // Rows offer to put a thread off only where the machine can, and a window of its own only where
  // there are such windows.
  const onLater = actions.onLater === undefined ? undefined : steady.onLater;
  const onOpenWindow = actions.onOpenWindow === undefined ? undefined : steady.onOpenWindow;
  return { ...steady, onLater, onOpenWindow };
}

/** A list's threads, each multi-agent run's in one card. */
function Entries({
  threads,
  box,
  now,
  selectedId,
  picked,
  onToggle,
  setAll,
  ...rowProps
}: {
  threads: ReadonlyArray<ThreadSummary>;
  box: InboxBox;
  now: number;
  /** Ids picked for bulk actions; rows read only whether they hold one. */
  picked: ReadonlyArray<string>;
  onToggle: (threadId: string, mode: SelectMode) => void;
  setAll: (threadIds: ReadonlyArray<string>, on: boolean) => void;
} & RowProps) {
  // A card that moves glides to its new place; one that comes grows into the list and one that goes
  // (archived, put off) folds out of it, so the cards around it close up smoothly.
  const entries = groupRuns(threads);
  const [rows, release] = useLingering(entries, entryKey);
  const arrived = useArrivals(entries.map(entryKey));
  const glide = useGlide();
  // A long list, the archive's above all, renders a page at a time as it scrolls.
  const { shown, more, end } = usePaging<HTMLLIElement>(
    rows.length,
    selectedId === undefined
      ? -1
      : rows.findIndex(({ item }) =>
          item.kind === "thread"
            ? item.thread.id === selectedId
            : item.threads.some((thread) => thread.id === selectedId),
        ),
  );
  // A fragment, not the bare array: the React Compiler takes a function for a component, and memoizes
  // its rows, only when it returns JSX itself.
  return (
    <>
      {rows.slice(0, shown).map(({ key, item: entry, present }) => (
        <li key={key} ref={glide(key)}>
          <Reveal appear={arrived(key)} onGone={() => release(key)}>
            {!present ? null : entry.kind === "thread" ? (
              <InboxRow
                thread={entry.thread}
                box={box}
                now={now}
                selected={entry.thread.id === selectedId}
                checked={picked.includes(entry.thread.id)}
                onToggle={onToggle}
                {...rowProps}
              />
            ) : (
              <InboxRun
                threads={entry.threads}
                box={box}
                now={now}
                selectedId={selectedId}
                picked={picked}
                onToggle={onToggle}
                setAll={setAll}
                {...rowProps}
              />
            )}
          </Reveal>
        </li>
      ))}
      {more ? <li ref={end} aria-hidden className="h-px" /> : null}
    </>
  );
}

const entryKey = (entry: InboxEntry) => (entry.kind === "thread" ? entry.thread.id : entry.id);

/**
 * A multi-agent run: one card for the message its threads were started with, a tally of where they
 * are, and, folded out, how each one did. It opens by itself while one of them needs the user or is
 * open; its actions take every thread in it along.
 */
function InboxRun({
  threads,
  box,
  now,
  selectedId,
  onSelect,
  onMarkRead,
  onMarkUnread,
  onNewThreadIn,
  onRename,
  onArchive,
  onRestore,
  onLater,
  scope,
  onScope,
  picked,
  onToggle,
  setAll,
}: { threads: ReadonlyArray<ThreadSummary>; box: InboxBox; now: number } & RowProps & {
    picked: ReadonlyArray<string>;
    onToggle: (threadId: string, mode: SelectMode) => void;
    setAll: (threadIds: ReadonlyArray<string>, on: boolean) => void;
  }) {
  const run = runSummary(threads);
  const holdsSelected = threads.some((thread) => thread.id === selectedId);
  const [toggled, setToggled] = useState<boolean>();
  const open = toggled ?? (threads.some(needsYou) || holdsSelected);
  const { folder, project } = run;
  const here = threads.every((thread) => thread.elsewhere === undefined);
  const archivable = threads.every(canArchive);
  const each = (act: (threadId: string) => unknown) => () => {
    for (const thread of threads) void act(thread.id);
  };
  const putOff =
    onLater && here && archivable
      ? () => {
          const until = laterTime(Date.now());
          for (const thread of threads) void onLater(thread.id, until);
        }
      : undefined;
  const back =
    box === "later" && onLater
      ? each((threadId) => onLater(threadId, undefined))
      : box === "archive"
        ? each(onRestore)
        : undefined;

  const quick: Array<CardAction> = [];
  if (box === "inbox" && here && archivable) {
    if (putOff) quick.push({ icon: Clock, label: "Later", key: "h", run: putOff });
    quick.push({ icon: Archive, label: "Archive", key: "e", run: each(onArchive) });
  }
  if (back && here) quick.push({ icon: Undo2, label: "Back to Inbox", key: "u", run: back });

  const count = (status: ThreadSummary["status"]) =>
    threads.filter((thread) => thread.status === status).length;
  const tally = [
    { count: count("running"), label: "working", tone: "text-running" },
    { count: count("failed"), label: "failed", tone: "text-error" },
    { count: count("idle"), label: "done", tone: "" },
  ].filter((part) => part.count > 0);

  const menu = () => (
    <>
      {box === "inbox" ? (
        run.unread ? (
          <MenuItem icon={MailOpen} onClick={() => onMarkRead(threads.filter((thread) => thread.unread))}>
            Mark as read
          </MenuItem>
        ) : (
          <MenuItem icon={Mail} onClick={each(onMarkUnread)}>
            Mark as unread
          </MenuItem>
        )
      ) : null}
      {folder && project ? (
        <>
          {here ? (
            <MenuItem icon={SquarePen} onClick={() => onNewThreadIn(folder)}>
              <span className="max-w-64 truncate">New thread in {project}</span>
            </MenuItem>
          ) : null}
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
      {here ? (
        <>
          <MenuSeparator />
          {box === "inbox" && putOff ? (
            <MenuItem icon={Clock} onClick={putOff}>
              Later
            </MenuItem>
          ) : null}
          {back ? (
            <MenuItem icon={box === "archive" ? ArchiveRestore : Undo2} onClick={back}>
              Back to Inbox
            </MenuItem>
          ) : null}
          {box === "archive" ? null : (
            <MenuItem icon={Archive} disabled={!archivable} onClick={each(onArchive)}>
              Archive all {threads.length}
            </MenuItem>
          )}
        </>
      ) : null}
    </>
  );
  const laterUntil = Math.max(...threads.map((thread) => thread.laterUntil ?? 0));
  // Ticking the card ticks every thread of the run; Shift ticks a run of the list through its
  // first thread, then takes the rest of the run along.
  const memberIds = threads.map((thread) => thread.id);
  const held = memberIds.filter((id) => picked.includes(id));
  return (
    <>
      <InboxCard
        thread={run}
        selected={holdsSelected && !open}
        pinned={false}
        {...(box === "later" && laterUntil > 0 ? { when: backLabel(laterUntil, now) } : {})}
        actions={quick}
        onSelect={onSelect}
        onRename={onRename}
        menu={menu}
        selection={{
          checked: held.length === memberIds.length,
          mixed: held.length > 0 && held.length < memberIds.length,
          onToggle: (mode) => {
            if (mode === "range") {
              onToggle(memberIds[0]!, "range");
              setAll(memberIds, true);
            } else if (held.length === memberIds.length) {
              setAll(memberIds, false);
            } else {
              setAll(memberIds, true);
            }
          },
        }}
        group={{
          count: threads.length,
          open,
          onToggle: () => setToggled(!open),
          tally: tally.map((part, index) => (
            <span key={part.label} className={part.tone}>
              {index > 0 ? " · " : ""}
              {part.count} {part.label}
            </span>
          )),
        }}
      />
      {open ? (
        <RunScoreboard
          threads={threads}
          selectedId={selectedId}
          onSelect={onSelect}
          onArchive={box === "archive" ? undefined : onArchive}
        />
      ) : null}
    </>
  );
}

type InboxRowProps = {
  thread: ThreadSummary;
  box: InboxBox;
  now: number;
  selected: boolean;
  /** Whether the thread is picked for bulk actions; a primitive, so memo'd rows keep skipping. */
  checked: boolean;
  onToggle: (threadId: string, mode: SelectMode) => void;
} & Omit<RowProps, "selectedId">;

/**
 * A thread's card. It renders again only when what it shows changes: opening another thread, which
 * renders the whole window, re-rendered every card's menus and tooltips (264 components a switch).
 */
const InboxRow = memo(
  InboxRowCard,
  ({ thread: before, ...rest }: InboxRowProps, { thread: after, ...next }: InboxRowProps) =>
    sameSummary(before, after) &&
    (Object.keys(rest) as Array<keyof typeof rest>).every((key) => Object.is(rest[key], next[key])),
);

function InboxRowCard({
  thread,
  box,
  now,
  selected,
  checked,
  onToggle,
  onSelect,
  onMarkRead,
  onMarkUnread,
  onNewThreadIn,
  onRename,
  onArchive,
  onRestore,
  onLater,
  onDelete,
  onOpenWindow,
  scope,
  onScope,
}: InboxRowProps) {
  const { folder, project } = thread;
  const pins = useAtomValue(pinnedAtom);
  const setPins = useAtomSet(pinnedAtom);
  const pinned = pins.includes(thread.id);
  // Another machine's thread is put off, archived, renamed and deleted there: open it there.
  const here = thread.elsewhere === undefined;
  const putOff =
    onLater && here && canArchive(thread) ? () => onLater(thread.id, laterTime(Date.now())) : undefined;
  const back =
    box === "later" && onLater
      ? () => onLater(thread.id, undefined)
      : box === "archive"
        ? () => onRestore(thread.id)
        : undefined;

  const quick: Array<CardAction> = [];
  if (box === "inbox" && here && canArchive(thread)) {
    if (putOff) quick.push({ icon: Clock, label: "Later", key: "h", run: putOff });
    quick.push({ icon: Archive, label: "Archive", key: "e", run: () => onArchive(thread.id) });
  }
  if (back && here) quick.push({ icon: Undo2, label: "Back to Inbox", key: "u", run: back });

  const menu = ({ rename, remove }: RowControls) => (
    <>
      {box === "inbox" ? (
        thread.unread ? (
          <MenuItem icon={MailOpen} onClick={() => onMarkRead([thread])}>
            Mark as read
          </MenuItem>
        ) : (
          <MenuItem icon={Mail} onClick={() => onMarkUnread(thread.id)}>
            Mark as unread
          </MenuItem>
        )
      ) : null}
      {box === "archive" ? null : (
        <MenuItem icon={pinned ? PinOff : Pin} onClick={() => setPins(togglePin(pins, thread.id))}>
          {pinned ? "Unpin" : "Pin"}
        </MenuItem>
      )}
      {onOpenWindow && here ? (
        <MenuItem icon={AppWindow} onClick={() => onOpenWindow(thread.id)}>
          Open in new window
        </MenuItem>
      ) : null}
      {folder && project ? (
        <>
          {here ? (
            <MenuItem icon={SquarePen} onClick={() => onNewThreadIn(folder)}>
              <span className="max-w-64 truncate">New thread in {project}</span>
            </MenuItem>
          ) : null}
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
      {here ? (
        <>
          <MenuSeparator />
          <MenuItem icon={Pencil} onClick={rename}>
            Rename
          </MenuItem>
          {box === "inbox" && putOff ? (
            <MenuItem icon={Clock} onClick={putOff}>
              Later
            </MenuItem>
          ) : null}
          {back ? (
            <MenuItem icon={box === "archive" ? ArchiveRestore : Undo2} onClick={back}>
              Back to Inbox
            </MenuItem>
          ) : null}
          {box === "archive" ? null : (
            <MenuItem icon={Archive} disabled={!canArchive(thread)} onClick={() => onArchive(thread.id)}>
              Archive
            </MenuItem>
          )}
          <MenuSeparator />
          <ExportMenuItems threadId={thread.id} />
          <MenuSeparator />
          <MenuItem icon={Trash2} tone="danger" disabled={!canDelete(thread)} onClick={remove}>
            Delete
          </MenuItem>
        </>
      ) : null}
    </>
  );
  return (
    <InboxCard
      thread={thread}
      selected={selected}
      pinned={pinned && box !== "archive"}
      {...(box === "later" && thread.laterUntil !== undefined
        ? { when: backLabel(thread.laterUntil, now) }
        : {})}
      actions={quick}
      onSelect={onSelect}
      onRename={onRename}
      onDelete={onDelete}
      menu={menu}
      selection={{ checked, mixed: false, onToggle: (mode) => onToggle(thread.id, mode) }}
    />
  );
}
