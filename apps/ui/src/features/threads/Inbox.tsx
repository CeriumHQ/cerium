import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  CheckCheck,
  Clock,
  CornerDownRight,
  FunnelX,
  GitFork,
  ListFilter,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  SquarePen,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import {
  memo,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
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
import { buttonClass } from "../../components/ui/Button.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { BulkBar, BulkNote, useBulkSelection, type SelectMode } from "./BulkBar.tsx";
import { useArrivals, useGlide, useLingering, usePresence, useRetained } from "../../lib/motion.ts";
import { usePaging } from "../../lib/paging.ts";
import { remember, stored } from "../../lib/storage.ts";
import type { NewThreadDraft } from "../composer/drafts.ts";
import { inboxCapAtom } from "../settings/preferences.ts";
import {
  filterInboxEntries,
  inboxProjects,
  inboxSections,
  inboxStatusFilters,
  type InboxStatusFilter,
} from "./sections.ts";
import { CopyLinkMenuItem } from "../launch/CopyLink.tsx";
import { ExportMenuItems } from "../export/ExportItems.tsx";
import { DraftRow, type DraftActions } from "./DraftRow.tsx";
import { EmptyList } from "./EmptyList.tsx";
import { InboxCard, type CardAction, type CardSwipe } from "./InboxCard.tsx";
import { inboxFocusAfterRemoval, inboxNavigationTarget } from "./inboxNavigation.ts";
import {
  archivedWork,
  backLabel,
  canArchive,
  canDelete,
  boxOf,
  entryThreads,
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
import { summarizeBulk, type BulkPlan } from "./bulk.ts";
import { haptic } from "./SwipeableCard.tsx";
import type { RowControls } from "./ThreadRow.tsx";

const SCOPE_KEY = "cerium:inboxScope";
const BOX_KEY = "cerium:inboxBox";

/** A thread this new set the inbox's cap working, the first time this window sees it. */
const FRESH = 2 * 60_000;
/** How long an action note stays at the foot of the list. */
const NOTE_FOR = 6_000;
const NO_PICKS: ReadonlyArray<string> = [];
/** How long the undo pill a swipe leaves stays. */
const UNDO_FOR = 4_000;
/** How far the list is pulled down before letting go refreshes it. */
const PULL_ARM = 64;
/** Where the list waits, pulled down, while it refreshes. */
const PULL_HOLD = 44;

/** A swipe's action: `act` resolves whether it worked, and only then does the pill offer `undo`. */
export interface SwipeCommit {
  readonly message: "Archived" | "Moved to Later" | "Back in Inbox";
  readonly act: () => Promise<boolean>;
  readonly undo: () => void;
}

interface BulkMove {
  readonly box: InboxBox;
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly taken?: ReadonlyArray<string>;
}

/** Keeps moving rows in their source list until the bulk action has a result to show. */
function withMovingRows(
  threads: ReadonlyArray<ThreadSummary>,
  box: InboxBox,
  moves: ReadonlyArray<BulkMove>,
) {
  const here = moves.filter((move) => move.box === box);
  if (here.length === 0) return threads;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  for (const move of here) {
    if (move.taken) {
      for (const id of move.taken) byId.delete(id);
    } else {
      for (const thread of move.threads) {
        if (!byId.has(thread.id)) byId.set(thread.id, thread);
      }
    }
  }
  return [...byId.values()];
}

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
  readonly onKeepRun: (winnerId: string) => Promise<BulkPlan>;
  readonly onRestore: (threadId: string) => Promise<boolean>;
  /** Puts a thread off until then, or brings it back; absent where the machine can't. */
  readonly onLater: ((threadId: string, until: number | undefined) => Promise<boolean>) | undefined;
  /** Goes on with a thread in a new one that starts small; absent where the machine can't. */
  readonly onContinue: ((threadId: string) => Promise<boolean>) | undefined;
  readonly onDelete: (threadId: string) => Promise<boolean>;
  /** Opens a thread in a window of its own; absent where there are no such windows. */
  readonly onOpenWindow: ((threadId: string) => void) | undefined;
  /** Pulling the list down from its top runs it: reloading threads and retrying the connection. */
  readonly onRefresh?: (() => void | Promise<void>) | undefined;
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
  onKeepRun,
  onRestore,
  onLater,
  onContinue,
  onDelete,
  onOpenWindow,
  onRefresh,
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
  const selectedBox =
    selectedId === undefined
      ? undefined
      : drafts.some((draft) => draft.key === selectedId)
        ? "drafts"
        : boxOf(
            [...threads, ...archived].find((thread) => thread.id === selectedId),
            now,
          );
  const [followed, setFollowed] = useState({ id: selectedId, box: selectedBox });
  if (selectedId !== undefined && (followed.id !== selectedId || followed.box !== selectedBox)) {
    if (followed.id !== selectedId && selectedBox !== undefined) {
      // Closing an archived thread's tab can select a thread in another list. Keep triage in place.
      const archiving =
        followed.box === box && box !== "archive" && archived.some(({ id }) => id === followed.id);
      if (!archiving) setBox(selectedBox);
    }
    setFollowed({ id: selectedId, box: selectedBox });
  }
  const pins = useAtomValue(pinnedAtom);
  const projects = inboxProjects([...threads, ...archived]);
  /** The folder the lists are scoped to; empty for every project. */
  const [scope, setScope] = useState(() => stored(SCOPE_KEY) ?? "");
  const [status, setStatus] = useState<InboxStatusFilter>("all");
  // A remembered folder with no threads left falls back to every project.
  const project = projects.find((candidate) => candidate.folder === scope);
  const inScope = (thread: ThreadSummary) => project === undefined || thread.folder === project.folder;
  const chooseScope = (folder: string) => {
    remember(SCOPE_KEY, folder);
    setScope(folder);
  };
  const clearFilters = () => {
    chooseScope("");
    setStatus("all");
  };
  const activeStatus = box === "drafts" ? "all" : status;
  const statusLabel = inboxStatusFilters.find(({ key }) => key === activeStatus)?.label ?? "All statuses";
  let viewLabel = project?.name ?? "View";
  if (activeStatus !== "all") viewLabel = project ? `${project.name}, ${statusLabel}` : statusLabel;
  const filteredEmpty =
    project !== undefined || status !== "all" ? (
      <EmptyList
        title="No threads match this filter."
        hint={`${[project?.name, activeStatus === "all" ? undefined : statusLabel].filter(Boolean).join(", ")} shows nothing in this list.`}
        action={
          <button
            type="button"
            onClick={clearFilters}
            className={buttonClass({ tone: "neutral", size: "sm" })}
          >
            <FunnelX size={13} strokeWidth={1.75} aria-hidden />
            Clear filters
          </button>
        }
      />
    ) : undefined;

  const [movingRows, setMovingRows] = useState<ReadonlyArray<BulkMove>>([]);
  const holdMovingRows = (box: InboxBox, threads: ReadonlyArray<ThreadSummary>) => {
    const move: BulkMove = { box, threads };
    setMovingRows((current) => [...current, move]);
    return (taken: ReadonlyArray<string>) =>
      setMovingRows((current) => current.map((each) => (each === move ? { ...move, taken } : each)));
  };
  const inbox = threads.filter((thread) => !isPutOff(thread, now));
  const deferred = laterWork(threads, now);
  // Keep successful rows out until the refreshed list agrees, so late updates can't bring them back mid-fold.
  const moves = movingRows.filter(({ box, taken }) => {
    const source = box === "inbox" ? inbox : box === "later" ? deferred : archived;
    return taken === undefined || source.some((thread) => taken.includes(thread.id));
  });
  if (moves.length !== movingRows.length) setMovingRows(moves);
  const later = filterInboxEntries(
    groupRuns(laterWork(withMovingRows(deferred, "later", moves), now).filter(inScope)),
    status,
  );
  const archive = filterInboxEntries(
    groupRuns(archivedWork(withMovingRows(archived, "archive", moves)).filter(inScope)),
    status,
  );
  const sections = inboxSections(withMovingRows(inbox, "inbox", moves).filter(inScope), now);
  // What needs the user leads, then pinned threads, then the rest.
  const listed = filterInboxEntries(
    groupRuns(
      [
        ...sections.filter((section) => section.key === "needsYou"),
        ...withPinned(
          sections.filter((section) => section.key !== "needsYou"),
          pins,
        ),
      ].flatMap(({ threads }) => threads),
    ),
    status,
  );
  // A draft with no project chosen yet shows in every scope.
  const scopedDrafts = drafts.filter(
    (draft) => project === undefined || draft.folder === undefined || draft.folder === project.folder,
  );
  const unread = listed.flatMap(entryThreads).filter((thread) => thread.unread);
  const allRuns = new Map<string, Array<ThreadSummary>>();
  for (const thread of threads) {
    if (thread.runId === undefined) continue;
    const run = allRuns.get(thread.runId);
    if (run) run.push(thread);
    else allRuns.set(thread.runId, [thread]);
  }

  const [keeping, setKeeping] = useState(false);
  const [keepNote, setKeepNote] = useState<string>();
  const keepRun = async (winnerId: string) => {
    if (keeping) return;
    setKeeping(true);
    setKeepNote(undefined);
    const note = await onKeepRun(winnerId).then(
      (result) => summarizeBulk("archive", result),
      () => "The comparison could not be archived.",
    );
    setKeepNote(note);
    setKeeping(false);
  };
  const comparisonNote =
    keepNote === undefined ? null : (
      <div className="mx-2 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-line-subtle bg-surface-raised py-2 pr-1.5 pl-2.5 text-meta text-fg-secondary shadow-raised transition-[opacity,translate] duration-200 ease-out-soft starting:translate-y-1.5 starting:opacity-0 max-md:text-[13px]">
        <Archive size={13} strokeWidth={1.75} aria-hidden className="mt-px shrink-0 text-fg-tertiary" />
        <output className="min-w-0 flex-1 leading-[1.4]">{keepNote}</output>
        <Tooltip label="Dismiss">
          <Button
            aria-label="Dismiss"
            onClick={() => setKeepNote(undefined)}
            className="-my-0.5 grid size-5 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:-my-1.5 max-md:size-8"
          >
            <X size={12} strokeWidth={1.75} />
          </Button>
        </Tooltip>
      </div>
    );

  const cap = useAtomValue(inboxCapAtom);
  const { note, archiveRow, clearNote } = useArchiveNote(
    inbox,
    (thread) => pins.includes(thread.id) || open.includes(thread.id),
    cap,
    {
      selectedId,
      onArchive,
    },
  );

  const actions = useSteadyActions({
    onSelect,
    onMarkRead,
    onMarkUnread,
    onNewThreadIn,
    onRename,
    onArchive: archiveRow,
    onRestore,
    onLater,
    onContinue,
    onDelete,
    onOpenWindow,
  });
  // A swipe's action leaves a pill to undo it, one at a time: a newer swipe takes its place.
  const [swipeUndo, setSwipeUndo] = useState<{ readonly message: string; readonly undo: () => void }>();
  const [onSwipe] = useState(() => (commit: SwipeCommit) => {
    void commit.act().then(
      (done) => {
        if (done) setSwipeUndo({ message: commit.message, undo: commit.undo });
      },
      () => undefined,
    );
  });
  useEffect(() => {
    if (swipeUndo === undefined) return;
    const timer = setTimeout(() => setSwipeUndo(undefined), UNDO_FOR);
    return () => clearTimeout(timer);
  }, [swipeUndo]);
  // Built from each prop rather than the rest of them, so it keeps its identity while only the drafts
  // change, as they do with every key typed into a new thread's first line: the lists' rows, all of
  // the Archive's among them, then don't render again.
  const rowProps: RowProps = {
    selectedId,
    ...actions,
    scope: project?.folder,
    onScope: chooseScope,
    onSwipe,
  };

  // Bulk picking, in the showing list's order so Shift click ticks a run of it. The pick drops
  // when the list changes; what an action moves away drops out of the list by itself.
  const orderedThreads = (
    box === "later" ? later : box === "archive" ? archive : box === "inbox" ? listed : []
  ).flatMap(entryThreads);
  const ordered = orderedThreads.map((thread) => thread.id);
  const { selected, toggle: togglePicked, setAll: setPicked, clear: clearPicked } = useBulkSelection(ordered);
  useEffect(() => clearPicked(), [box, scope, status, clearPicked]);
  const ticked = new Set(selected);
  const pickedHere = orderedThreads.filter((thread) => ticked.has(thread.id));
  const picked = pickedHere.map((thread) => thread.id);
  /** What a bulk action says it did, and which threads it skipped with why; shown for a moment. */
  const [bulkNote, setBulkNote] = useState<{ box: InboxBox; text: string }>();
  useEffect(() => {
    if (bulkNote === undefined) return;
    const timer = setTimeout(() => setBulkNote(undefined), NOTE_FOR);
    return () => clearTimeout(timer);
  }, [bulkNote]);
  const bulkBar = (forBox: InboxBox) => {
    if (forBox !== box) return null;
    const bar = picked.length ? (
      <BulkBar
        box={forBox}
        threads={pickedHere}
        total={ordered.length}
        onSelectAll={() => setPicked(ordered, true)}
        onArchive={actions.onArchive}
        onRestore={actions.onRestore}
        onLater={forBox === "inbox" ? actions.onLater : undefined}
        onMarkRead={actions.onMarkRead}
        onDelete={actions.onDelete}
        onMoving={(moving) => holdMovingRows(forBox, moving)}
        onSettled={(taken) => setPicked(taken, false)}
        onNote={(text) => setBulkNote({ box: forBox, text })}
      />
    ) : null;
    const note = !bar && bulkNote?.box === forBox ? <BulkNote note={bulkNote.text} /> : null;
    return <BulkFooter bar={bar} note={note} />;
  };
  // Esc clears the pick, unless it belongs to a field, a menu or a dialog.
  const clearOnEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || selected.length === 0) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(
        "input, textarea, select, dialog, [role='dialog'], [role='alertdialog'], [role='menu']",
      )
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
      className="relative flex min-h-0 flex-1 flex-col"
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
        {activeStatus === "all" ? null : (
          // The status the lists are narrowed to, in sight while the menu is closed; pressing it shows every status again.
          <Tooltip label="Show all statuses">
            <Button
              aria-label={`Status filter: ${statusLabel}. Show all statuses`}
              onClick={() => setStatus("all")}
              className="group/chip ml-auto flex h-5.5 max-w-28 min-w-0 shrink items-center gap-1 rounded-md bg-surface-selected pr-1 pl-1.5 text-caption font-medium text-fg-secondary transition-colors duration-150 hover:text-fg-primary max-md:h-8 max-md:max-w-36 max-md:text-[13px]"
            >
              <StatusMark status={activeStatus} />
              <span className="min-w-0 truncate">{statusLabel}</span>
              <X
                size={11}
                strokeWidth={2}
                aria-hidden
                className="shrink-0 text-fg-tertiary group-hover/chip:text-fg-primary"
              />
            </Button>
          </Tooltip>
        )}
        {/* One menu for the view: which projects and statuses show, and marking the inbox read. */}
        {box !== "drafts" || projects.length > 1 || unread.length > 0 ? (
          <MenuRoot>
            <Tooltip label={viewLabel}>
              <MenuTrigger>
                <Button
                  aria-label={`Filter threads, ${project?.name ?? "all projects"}, ${statusLabel}`}
                  className={`${activeStatus === "all" ? "ml-auto" : ""} grid size-6.5 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-active data-popup-open:text-fg-secondary max-md:size-9`}
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
              {box === "drafts" ? null : (
                <>
                  {unread.length > 0 || projects.length > 1 ? <MenuSeparator /> : null}
                  <MenuRadioGroup value={status} onValueChange={setStatus}>
                    <MenuGroupLabel>Status</MenuGroupLabel>
                    {inboxStatusFilters.map(({ key, label }) => (
                      <MenuRadioItem key={key} value={key}>
                        <StatusMark status={key} />
                        {label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </>
              )}
              {project !== undefined || activeStatus !== "all" ? (
                <>
                  <MenuSeparator />
                  <MenuItem icon={FunnelX} onClick={clearFilters}>
                    Clear filters
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </MenuRoot>
        ) : null}
      </div>

      <ThreadPanel
        box="inbox"
        label="Inbox"
        empty={
          listed.length > 0
            ? undefined
            : (filteredEmpty ??
              (threads.length + archived.length + drafts.length > 0 ? (
                "You're all caught up."
              ) : (
                <EmptyList title="No threads yet" hint="Threads from every project gather here." />
              )))
        }
        bar={
          <>
            {bulkBar("inbox")}
            <ArchiveUndo
              note={box === "inbox" ? note : undefined}
              onUndo={(ids) => {
                for (const id of ids) void onRestore(id);
                clearNote();
              }}
            />
          </>
        }
        entries={listed}
        allRuns={allRuns}
        onKeep={keepRun}
        keeping={keeping}
        now={now}
        picked={box === "inbox" ? picked : NO_PICKS}
        onRefresh={onRefresh}
        onToggle={togglePicked}
        setAll={setPicked}
        {...rowProps}
      />
      <BoxPanel value="drafts" label="Drafts" empty={scopedDrafts.length === 0 ? "No drafts." : undefined}>
        {scopedDrafts.map((draft) => (
          <li key={draft.key}>
            <DraftRow draft={draft} mark="badge" card {...draftActions} />
          </li>
        ))}
      </BoxPanel>

      <ThreadPanel
        box="later"
        label="Later"
        empty={later.length === 0 ? (filteredEmpty ?? "Nothing put off.") : undefined}
        bar={bulkBar("later")}
        entries={later}
        allRuns={allRuns}
        onKeep={keepRun}
        keeping={keeping}
        now={now}
        picked={box === "later" ? picked : NO_PICKS}
        onRefresh={onRefresh}
        onToggle={togglePicked}
        setAll={setPicked}
        {...rowProps}
      />

      <ThreadPanel
        box="archive"
        label="Archive"
        empty={archive.length === 0 ? (filteredEmpty ?? "Nothing archived yet.") : undefined}
        bar={bulkBar("archive")}
        entries={archive}
        allRuns={allRuns}
        keeping={keeping}
        now={now}
        picked={box === "archive" ? picked : NO_PICKS}
        onRefresh={onRefresh}
        onToggle={togglePicked}
        setAll={setPicked}
        {...rowProps}
      />
      {comparisonNote}
      <UndoPill
        undo={swipeUndo}
        onUndo={() => {
          swipeUndo?.undo();
          setSwipeUndo(undefined);
        }}
      />
    </Tabs.Root>
  );
}

/** A status filter's mark in the view menu and its chip: the colour a row of that status shows. */
function StatusMark({ status }: { status: InboxStatusFilter }) {
  if (status === "all") return null;
  if (status === "worktree")
    return <GitFork size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-tertiary" />;
  const tone =
    status === "needsYou" ? "bg-attention" : status === "working" ? "bg-running" : "bg-fg-secondary";
  return (
    <span aria-hidden className="grid size-3 shrink-0 place-items-center">
      <span className={`size-1.5 rounded-full ${tone}`} />
    </span>
  );
}

function BoxTab({ value, label, count = 0 }: { value: InboxBox; label: string; count?: number }) {
  return (
    <Tabs.Tab
      value={value}
      className="flex h-6.5 shrink-0 items-center gap-1 rounded-md px-1.5 text-meta font-medium text-fg-secondary transition-colors duration-150 outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-focus-ring data-active:bg-surface-selected data-active:text-fg-primary max-md:h-9 max-md:px-2.5 max-md:text-[14px]"
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
  panelRef,
  handlers,
  onRefresh,
  children,
}: {
  value: InboxBox;
  label: string;
  empty: ReactNode;
  /** The bulk-action bar at the list's foot while threads of this list are picked, or its note after. */
  bar?: ReactNode;
  panelRef?: RefObject<HTMLDivElement | null>;
  handlers?: Pick<ComponentProps<typeof Tabs.Panel>, "onKeyDown" | "onFocusCapture" | "onBlurCapture">;
  onRefresh?: (() => void | Promise<void>) | undefined;
  children: ReactNode;
}) {
  const { viewport, content, indicator, refreshing } = usePullToRefresh(onRefresh);
  return (
    <Tabs.Panel
      value={value}
      ref={panelRef}
      {...handlers}
      className="relative flex min-h-0 flex-1 flex-col pt-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
    >
      {onRefresh === undefined ? null : (
        <output
          ref={indicator}
          aria-label="Refresh threads"
          aria-busy={refreshing}
          className="pointer-events-none absolute top-0 left-1/2 z-10 -ml-4 grid size-8 place-items-center opacity-0"
        >
          <RefreshCw
            size={16}
            strokeWidth={1.75}
            aria-hidden
            className={`text-fg-tertiary ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
        </output>
      )}
      <ScrollArea className="flex-1" viewportRef={viewport}>
        <nav ref={content} aria-label={label} className="px-2 pb-3">
          <ul className="flex flex-col gap-0.5">{children}</ul>
          {typeof empty === "string" ? (
            <p className="px-2 py-12 text-center text-meta text-fg-tertiary max-md:text-[14px]">{empty}</p>
          ) : (
            empty
          )}
        </nav>
      </ScrollArea>
      {bar}
    </Tabs.Panel>
  );
}

function restorePanelFocus(element: HTMLElement | null, afterRemoval = false) {
  const active = document.activeElement;
  if (element && (element.contains(active) || (afterRemoval && active === document.body))) {
    element.closest<HTMLElement>('[role="tabpanel"]')?.focus({ preventScroll: true });
  }
}

/** Both layers share the foot of the list while the footer sizes to the one taking over. */
function BulkFooter({ bar, note }: { bar: ReactNode; note: ReactNode }) {
  const footer = useRef<HTMLDivElement>(null);
  const barLayer = useRef<HTMLDivElement>(null);
  const noteLayer = useRef<HTMLDivElement>(null);
  const barFocused = useRef(false);
  const hasBar = bar !== null;
  const hasNote = note !== null;
  const barPhase = usePresence(hasBar, barLayer);
  const notePhase = usePresence(hasNote, noteLayer);
  const lastBar = useRetained(bar, hasBar);
  const lastNote = useRetained(note, hasNote);
  useLayoutEffect(() => {
    if (hasBar || !barFocused.current) return;
    // An action can remove its own focused button or close a dialog as the bar leaves.
    restorePanelFocus(footer.current, true);
    if (barPhase === "gone") barFocused.current = false;
  }, [hasBar, barPhase]);
  useLayoutEffect(() => {
    const element = footer.current;
    if (element === null) return;
    const active = hasBar ? barLayer.current : hasNote ? noteLayer.current : null;
    const resize = () => {
      element.style.height = `${active?.offsetHeight ?? 0}px`;
    };
    resize();
    if (active === null) return;
    const observer = new ResizeObserver(resize);
    observer.observe(active);
    return () => observer.disconnect();
  }, [hasBar, hasNote]);

  return (
    <div ref={footer} className="relative h-0 shrink-0 transition-[height] duration-200 ease-out-soft">
      {barPhase === "gone" ? null : (
        <div
          ref={barLayer}
          data-phase={barPhase}
          inert={barPhase === "leaving"}
          onFocusCapture={() => {
            barFocused.current = true;
          }}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (next && next !== document.body && !event.currentTarget.contains(next))
              barFocused.current = false;
          }}
          className="absolute inset-x-0 bottom-0 transition-[opacity,translate] duration-200 ease-out-soft starting:translate-y-1.5 starting:opacity-0 data-[phase=leaving]:translate-y-1.5 data-[phase=leaving]:opacity-0"
        >
          {lastBar}
        </div>
      )}
      {notePhase === "gone" ? null : (
        <div
          ref={noteLayer}
          data-phase={notePhase}
          inert={notePhase === "leaving"}
          className="absolute inset-x-0 bottom-0 transition-opacity duration-200 ease-out-soft starting:opacity-0 data-[phase=leaving]:opacity-0"
        >
          {lastNote}
        </div>
      )}
    </div>
  );
}

interface UndoNote {
  readonly label: string;
  readonly ids: ReadonlyArray<string>;
}

function ArchiveUndo({
  note,
  onUndo,
}: {
  note: UndoNote | undefined;
  onUndo: (ids: ReadonlyArray<string>) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!note) restorePanelFocus(content.current);
  }, [note]);
  return (
    <Reveal>
      {note ? (
        <div
          ref={content}
          className="flex items-baseline gap-2 border-t border-line-subtle px-4 pt-2 pb-1 text-meta text-fg-tertiary max-md:text-[13px]"
        >
          <output className="min-w-0 flex-1 truncate">{note.label}</output>
          <Button
            onClick={() => onUndo(note.ids)}
            className="font-medium text-fg-secondary transition-colors hover:text-fg-primary"
          >
            Undo
          </Button>
        </div>
      ) : null}
    </Reveal>
  );
}

/** What a swipe did, floating above the bottom rail with a way to take it back. */
function UndoPill({ undo, onUndo }: { undo: { readonly message: string } | undefined; onUndo: () => void }) {
  const pill = useRef<HTMLDivElement>(null);
  const phase = usePresence(undo !== undefined, pill, { appear: true });
  const shown = useRetained(undo, undo !== undefined);
  if (phase === "gone" || shown === undefined) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
      <div
        ref={pill}
        data-phase={phase}
        inert={phase === "leaving"}
        className="pointer-events-auto flex h-10 items-center gap-2 rounded-full bg-surface-overlay pr-1 pl-4 text-[14px] text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,translate] duration-200 ease-out-soft starting:translate-y-2 starting:opacity-0 data-[phase=leaving]:translate-y-2 data-[phase=leaving]:opacity-0 data-[phase=leaving]:duration-150 data-[phase=leaving]:ease-in-soft motion-reduce:translate-y-0!"
      >
        <output>{shown.message}</output>
        <Button
          onClick={onUndo}
          className="h-8 rounded-full px-3 font-medium text-fg-secondary transition-colors duration-150 hover:text-fg-primary active:bg-surface-active"
        >
          Undo
        </Button>
      </div>
    </div>
  );
}

/** Moves the pulled list and turns its arrow by how far it is pulled; `settle` eases it there. */
function drawPull(list: HTMLElement | null, mark: HTMLElement | null, distance: number, settle: boolean) {
  const transition =
    settle && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "250ms var(--ease-out-soft)" : "0ms";
  if (list) {
    list.style.transition = `translate ${transition}`;
    list.style.translate = distance === 0 ? "" : `0 ${distance}px`;
  }
  if (mark) {
    const progress = Math.min(distance / PULL_ARM, 1);
    mark.style.transition = `opacity ${transition}, transform ${transition}`;
    mark.style.opacity = String(progress);
    mark.style.transform = `translateY(${distance / 2 - 12}px) rotate(${progress * 270}deg)`;
  }
}

/**
 * Pulling a list down from its top refreshes it: the list follows at half the finger's travel, a
 * turning arrow arms at `PULL_ARM` with a tick, and letting go spins it until `onRefresh` settles.
 */
function usePullToRefresh(onRefresh: (() => void | Promise<void>) | undefined) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLOutputElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const draw = (distance: number, settle: boolean) =>
    drawPull(content.current, indicator.current, distance, settle);
  const refresh = useEffectEvent(() => {
    if (onRefresh === undefined || busy.current) return;
    busy.current = true;
    setRefreshing(true);
    draw(PULL_HOLD, true);
    // A refresh that settles at once still spins long enough to be seen.
    const shown = new Promise((resolve) => setTimeout(resolve, 400));
    void Promise.all([Promise.resolve().then(onRefresh), shown])
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
        setRefreshing(false);
        draw(0, true);
      });
  });
  const enabled = onRefresh !== undefined;
  useEffect(() => {
    const element = viewport.current;
    const list = content.current;
    const mark = indicator.current;
    if (!enabled || element === null) return;
    let start: { x: number; y: number } | undefined;
    let pulling = false;
    let armed = false;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 && touch && element.scrollTop <= 0 && !busy.current
          ? { x: touch.clientX, y: touch.clientY }
          : undefined;
      pulling = false;
      armed = false;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (start === undefined || touch === undefined) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!pulling) {
        if (dy > 10 && dy > 1.5 * Math.abs(dx) && element.scrollTop <= 0) pulling = true;
        else {
          if (Math.abs(dx) > 10 || dy < -10) start = undefined;
          return;
        }
      }
      if (event.cancelable) event.preventDefault();
      const distance = Math.max(0, dy - 10) * 0.5;
      const nowArmed = distance >= PULL_ARM;
      if (nowArmed && !armed) haptic(8);
      armed = nowArmed;
      drawPull(list, mark, distance, false);
    };
    const onEnd = (event: TouchEvent) => {
      if (pulling) {
        if (armed && event.type === "touchend") refresh();
        else drawPull(list, mark, 0, true);
      }
      start = undefined;
      pulling = false;
      armed = false;
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onEnd);
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);
  return { viewport, content, indicator, refreshing };
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
 * Keeps the inbox to its configured cap: as a new thread arrives, the oldest quiet ones beyond it are
 * archived, and a note offers to bring them back. The same note follows a single row archive.
 */
function useArchiveNote(
  inbox: ReadonlyArray<ThreadSummary>,
  keep: (thread: ThreadSummary) => boolean,
  cap: number,
  { selectedId, onArchive }: Pick<InboxProps, "selectedId" | "onArchive">,
) {
  const [note, setNote] = useState<UndoNote>();
  const offerUndo = (archived: ReadonlyArray<Pick<ThreadSummary, "id" | "title">>) => {
    setNote({
      label:
        archived.length === 1
          ? `Archived “${archived[0]!.title}”`
          : `Archived ${archived.length} older threads`,
      ids: archived.map((thread) => thread.id),
    });
  };
  const archiveRow = async (id: string, title?: string) => {
    const archived = await onArchive(id);
    if (archived && title !== undefined) offerUndo([{ id, title }]);
    return archived;
  };
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
    const gone = overflow(inbox, (thread) => thread.id === selectedId || keep(thread), at, cap);
    if (gone.length === 0) return;
    for (const thread of gone) void onArchive(thread.id);
    // The note shows once this effect is done, rather than rendering again inside it.
    queueMicrotask(() => offerUndo(gone));
  });
  const ids = inbox.map((thread) => thread.id).join(" ");
  useEffect(() => settle(), [ids]);
  useEffect(() => {
    if (note === undefined) return;
    const timer = setTimeout(() => setNote(undefined), NOTE_FOR);
    return () => clearTimeout(timer);
  }, [note]);
  return { note, archiveRow, clearNote: () => setNote(undefined) };
}

type RowProps = Omit<
  InboxProps,
  "threads" | "drafts" | "draftActions" | "archived" | "open" | "onArchive" | "onKeepRun" | "onRefresh"
> & {
  readonly onArchive: (threadId: string, undoTitle?: string) => Promise<boolean>;
  /** Runs an action a swipe committed, and offers to undo it once it worked. */
  readonly onSwipe: (commit: SwipeCommit) => void;
  /** The folder the lists are scoped to, if any. */
  readonly scope: string | undefined;
  readonly onScope: (folder: string) => void;
};

/** What a row does to its threads. */
type RowActions = Pick<
  RowProps,
  | "onSelect"
  | "onMarkRead"
  | "onMarkUnread"
  | "onNewThreadIn"
  | "onRename"
  | "onArchive"
  | "onRestore"
  | "onLater"
  | "onContinue"
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
    onArchive: (threadId, undoTitle) => latest.current.onArchive(threadId, undoTitle),
    onRestore: (threadId) => latest.current.onRestore(threadId),
    onLater: (threadId, until) => latest.current.onLater?.(threadId, until) ?? Promise.resolve(false),
    onContinue: (threadId) => latest.current.onContinue?.(threadId) ?? Promise.resolve(false),
    onDelete: (threadId) => latest.current.onDelete(threadId),
    onOpenWindow: (threadId) => latest.current.onOpenWindow?.(threadId),
  }));
  // Rows offer to put a thread off or continue it only where the machine can, and a window of its
  // own only where there are such windows.
  const onLater = actions.onLater === undefined ? undefined : steady.onLater;
  const onContinue = actions.onContinue === undefined ? undefined : steady.onContinue;
  const onOpenWindow = actions.onOpenWindow === undefined ? undefined : steady.onOpenWindow;
  return { ...steady, onLater, onContinue, onOpenWindow };
}

/** A list's threads, each multi-agent run's in one card. */
function ThreadPanel({
  entries,
  box,
  label,
  empty,
  bar,
  allRuns,
  onKeep,
  keeping,
  now,
  selectedId,
  picked,
  onToggle,
  setAll,
  onRefresh,
  ...rowProps
}: {
  entries: ReadonlyArray<InboxEntry>;
  box: InboxBox;
  label: string;
  empty: ReactNode;
  bar: ReactNode;
  allRuns: ReadonlyMap<string, ReadonlyArray<ThreadSummary>>;
  onKeep?: (winnerId: string) => void;
  keeping: boolean;
  now: number;
  /** Ids picked for bulk actions; rows read only whether they hold one. */
  picked: ReadonlyArray<string>;
  onToggle: (threadId: string, mode: SelectMode) => void;
  setAll: (threadIds: ReadonlyArray<string>, on: boolean) => void;
  onRefresh: (() => void | Promise<void>) | undefined;
} & RowProps) {
  // A card that moves glides to its new place; one that comes grows into the list and one that goes
  // (archived, put off) folds out of it, so the cards around it close up smoothly.
  const [rows, release] = useLingering(entries, entryKey);
  const keys = entries.map(entryKey);
  const arrived = useArrivals(keys);
  const glide = useGlide();
  const panel = useRef<HTMLDivElement>(null);
  const focused = useRef<string | undefined>(undefined);
  const previousKeys = useRef(keys);
  const [request, setRequest] = useState<{ key: string; from: HTMLElement }>();
  const handledRequest = useRef<typeof request>(undefined);
  const focusCard = (key: string | undefined) => {
    const root = panel.current;
    if (root === null) return;
    const row = [...root.querySelectorAll<HTMLElement>("[data-inbox-entry]")].find(
      (row) => row.dataset["inboxEntry"] === key,
    );
    const card = row?.querySelector<HTMLElement>("[data-thread]");
    if (card?.closest("[inert]") === null) card.focus();
    else root.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const before = previousKeys.current;
    previousKeys.current = keys;
    const active = document.activeElement;
    if (request !== undefined && request !== handledRequest.current) {
      handledRequest.current = request;
      if (active === request.from && keys.includes(request.key)) focusCard(request.key);
    }
    const activeRow = active?.closest("[data-inbox-entry]");
    if (
      focused.current !== undefined &&
      !keys.includes(focused.current) &&
      (active === document.body ||
        (panel.current?.contains(activeRow ?? null) &&
          activeRow?.getAttribute("data-inbox-entry") === focused.current))
    ) {
      focusCard(inboxFocusAfterRemoval(before, keys, focused.current));
    }
  });
  const handlers: NonNullable<ComponentProps<typeof BoxPanel>["handlers"]> = {
    onFocusCapture: (event) => {
      if (!event.currentTarget.contains(event.target)) return;
      focused.current = event.target.closest<HTMLElement>("[data-inbox-entry]")?.dataset["inboxEntry"];
    },
    onBlurCapture: (event) => {
      const next = event.relatedTarget;
      if (next && next !== document.body && !event.currentTarget.contains(next)) {
        focused.current = undefined;
      }
    },
    onKeyDown: (event) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.nativeEvent.isComposing ||
        !(event.target instanceof HTMLElement) ||
        !event.currentTarget.contains(event.target) ||
        event.target.closest(
          "input, textarea, select, [contenteditable], [role='menu'], [role='dialog'], [role='alertdialog'], dialog",
        )
      )
        return;
      const at = event.target.closest<HTMLElement>("[data-inbox-entry]")?.dataset["inboxEntry"];
      const next = inboxNavigationTarget(keys, at, event.key);
      if (next === undefined) return;
      event.preventDefault();
      setRequest({ key: next, from: event.target });
    },
  };
  // A long list, the archive's above all, renders a page at a time as it scrolls.
  const { shown, more, end } = usePaging<HTMLLIElement>(
    rows.length,
    Math.max(
      request === undefined ? -1 : rows.findIndex(({ key }) => key === request.key),
      selectedId === undefined
        ? -1
        : rows.findIndex(({ item }) =>
            item.kind === "thread"
              ? item.thread.id === selectedId
              : item.threads.some((thread) => thread.id === selectedId),
          ),
    ),
  );
  return (
    <BoxPanel
      value={box}
      label={label}
      empty={empty}
      bar={bar}
      panelRef={panel}
      handlers={handlers}
      onRefresh={onRefresh}
    >
      {rows.slice(0, shown).map(({ key, item: entry, present }) => (
        <li key={key} ref={glide(key)} data-inbox-entry={key}>
          <Reveal appear={arrived(key)} onGone={() => release(key)}>
            {!present ? null : entry.kind === "thread" ? (
              <InboxRow
                thread={entry.thread}
                box={box}
                now={now}
                selected={entry.thread.id === selectedId}
                checked={picked.includes(entry.thread.id)}
                selecting={picked.length > 0}
                onToggle={onToggle}
                {...rowProps}
              />
            ) : (
              <InboxRun
                threads={entry.threads}
                comparisonThreads={allRuns.get(entry.id) ?? entry.threads}
                onKeep={onKeep}
                keeping={keeping}
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
    </BoxPanel>
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
  comparisonThreads,
  onKeep,
  keeping,
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
}: {
  threads: ReadonlyArray<ThreadSummary>;
  comparisonThreads: ReadonlyArray<ThreadSummary>;
  onKeep: ((winnerId: string) => void) | undefined;
  keeping: boolean;
  box: InboxBox;
  now: number;
} & RowProps & {
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
    onLater && box === "inbox" && here && archivable
      ? (until: number) => {
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
    if (putOff)
      quick.push({ icon: Clock, label: "Later", key: "h", run: () => putOff(laterTime(Date.now())) });
    quick.push({ icon: Archive, label: "Archive", key: "e", run: each(onArchive) });
  }
  if (back && here) quick.push({ icon: Undo2, label: "Back to Inbox", key: "u", run: back });

  const count = (status: ThreadSummary["status"]) =>
    threads.filter((thread) => thread.status === status).length;
  const tally = [
    { count: count("running"), label: "working", tone: "text-running-text" },
    { count: count("failed"), label: "failed", tone: "text-error-text" },
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
        {...(putOff ? { onLater: putOff } : {})}
        menu={menu}
        selection={{
          active: picked.length > 0,
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
          onKeep={onKeep}
          keeping={keeping}
          comparisonThreads={comparisonThreads}
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
  selecting: boolean;
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
  selecting,
  onToggle,
  onSelect,
  onMarkRead,
  onMarkUnread,
  onNewThreadIn,
  onRename,
  onArchive,
  onRestore,
  onLater,
  onContinue,
  onDelete,
  onOpenWindow,
  scope,
  onScope,
  onSwipe,
}: InboxRowProps) {
  const { folder, project } = thread;
  const pins = useAtomValue(pinnedAtom);
  const setPins = useAtomSet(pinnedAtom);
  const pinned = pins.includes(thread.id);
  // Another machine's thread is put off, archived, renamed and deleted there: open it there.
  const here = thread.elsewhere === undefined;
  const putOff =
    onLater && box === "inbox" && here && canArchive(thread)
      ? (until: number) => void onLater(thread.id, until)
      : undefined;
  const back =
    box === "later" && onLater
      ? () => onLater(thread.id, undefined)
      : box === "archive"
        ? () => onRestore(thread.id)
        : undefined;
  const archive = () => onArchive(thread.id, box === "inbox" ? thread.title : undefined);

  const quick: Array<CardAction> = [];
  if (box === "inbox" && here && canArchive(thread)) {
    if (putOff)
      quick.push({ icon: Clock, label: "Later", key: "h", run: () => putOff(laterTime(Date.now())) });
    quick.push({ icon: Archive, label: "Archive", key: "e", run: archive });
  }
  if (back && here) quick.push({ icon: Undo2, label: "Back to Inbox", key: "u", run: back });

  // Swipes are shortcuts to what the menu offers; each leaves a pill to undo it.
  let primary: CardSwipe["primary"];
  if (here && box === "inbox" && canArchive(thread)) {
    primary = {
      kind: "done",
      run: () =>
        onSwipe({
          message: "Archived",
          act: () => onArchive(thread.id),
          undo: () => void onRestore(thread.id),
        }),
    };
  } else if (here && back) {
    const until = thread.laterUntil;
    primary = {
      kind: "inbox",
      run: () =>
        onSwipe({
          message: "Back in Inbox",
          act: back,
          undo: () => void (box === "archive" ? onArchive(thread.id) : onLater?.(thread.id, until)),
        }),
    };
  }
  const swipe: CardSwipe = {
    ...(primary ? { primary } : {}),
    ...(putOff && onLater
      ? {
          later: () =>
            onSwipe({
              message: "Moved to Later",
              act: () => onLater(thread.id, laterTime(Date.now())),
              undo: () => void onLater(thread.id, undefined),
            }),
        }
      : {}),
  };

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
          {back ? (
            <MenuItem icon={box === "archive" ? ArchiveRestore : Undo2} onClick={back}>
              Back to Inbox
            </MenuItem>
          ) : null}
          {box !== "archive" && onContinue ? (
            <MenuItem
              icon={CornerDownRight}
              disabled={!canArchive(thread)}
              onClick={() => void onContinue(thread.id)}
            >
              Continue in new thread
            </MenuItem>
          ) : null}
          {box === "archive" ? null : (
            <MenuItem icon={Archive} disabled={!canArchive(thread)} onClick={archive}>
              Archive
            </MenuItem>
          )}
          <MenuSeparator />
          <CopyLinkMenuItem threadId={thread.id} />
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
      {...(putOff ? { onLater: putOff } : {})}
      onDelete={onDelete}
      menu={menu}
      {...(here ? { swipe } : {})}
      selection={{ active: selecting, checked, mixed: false, onToggle: (mode) => onToggle(thread.id, mode) }}
    />
  );
}
