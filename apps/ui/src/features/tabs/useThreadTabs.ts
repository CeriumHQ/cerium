import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import type { AppMode } from "../../app/mode.ts";
import { draftModeOf, isNewDraftKey, newDraftKey, newThreadDraftTabsAtom } from "../composer/drafts.ts";
import type { ThreadSummary } from "../threads/model.ts";
import { githubOfKey } from "../github/model.ts";
import { githubTitlesAtom } from "../github/tabs.ts";
import { commitFileOfKey, fileOfKey, turnFileOfKey } from "../viewer/model.ts";
import { isNonThreadKey } from "./tabKinds.ts";
import {
  closeTabs,
  emptyStrip,
  keepTab,
  moveTab,
  openBeside,
  renameTab,
  reopenTab,
  showTab,
  tabAtDigit,
  tabBeside,
  type OpenAs,
  type TabStrip,
} from "./model.ts";
import type { TabActions, TabView } from "./ThreadTabs.tsx";

/** Every machine's unified tabs: switching to another computer and back finds its tabs as they were. */
export type TabStrips = Readonly<Record<string, TabStrip>>;

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * The open threads' tabs for the window. Work threads, chats, drafts, files, and GitHub items all
 * share one strip per machine. The strip follows whatever the window shows: a thread opened any way
 * at all (the sidebar, search, a notification) takes the preview tab, unless `openAs` asked for a
 * tab of its own first. A file always takes a tab of its own, so it never replaces the thread.
 * The window still decides what's shown; the tabs ask it through `onShow`.
 */
export function useThreadTabs({
  machine,
  mode,
  active,
  threads,
  loaded,
  initial,
  onShow,
  onFresh,
  onClosed,
}: {
  /** The machine the window drives, whose tabs show. */
  machine: string;
  /** The sidebar's active mode, deciding whether the "+" button opens a new work thread or a new chat. */
  mode: AppMode;
  /** The thread, or the key of the thread not started yet, the window shows. */
  active: string;
  threads: ReadonlyArray<ThreadSummary>;
  /** The thread list has loaded, so a tab whose thread it lacks is gone. */
  loaded: boolean;
  initial: TabStrips | undefined;
  /** Shows a tab's thread or draft. */
  onShow: (key: string) => void;
  /** Shows the blank new thread `key` in place of the window's current one. */
  onFresh: (key: string, focus: boolean) => void;
  /**
   * Tabs closed, for the window to forget the empty drafts among them and close their panes. Returns
   * what shows in place of the active tab when it closed, if the window has its own idea (the pane
   * beside the closed one); else the tab beside it shows.
   */
  onClosed: (keys: ReadonlyArray<string>) => string | undefined;
}) {
  const [strips, setStrips] = useState<TabStrips>(() => initial ?? {});
  /** How the next thread shown opens, when it isn't the preview. */
  const [opening, setOpening] = useState<{ readonly key: string; readonly as: OpenAs }>();
  const drafts = useAtomValue(newThreadDraftTabsAtom);
  const githubTitles = useAtomValue(githubTitlesAtom);
  const strip = strips[machine] ?? emptyStrip;
  const update = (change: (strip: TabStrip) => TabStrip) =>
    setStrips((all) => ({
      ...all,
      [machine]: change(all[machine] ?? emptyStrip),
    }));

  /** A tab that holds a new thread with nothing in it yet, which can be replaced or reused without loss. */
  const isEmpty = (key: string) => isNewDraftKey(key) && !drafts.some((draft) => draft.key === key);
  const isEmptyOfMode = (key: string, targetMode: AppMode) => isEmpty(key) && draftModeOf(key) === targetMode;
  const threadOf = (key: string) => threads.find((thread) => thread.id === key);

  // Whatever the window shows has a tab.
  if (strip.active !== active) {
    // A thread not started yet is the user's own writing, never a mere preview. A file is a tab of
    // its own too: the preview slot is the thread's, and a file must not take it.
    const as =
      opening?.key === active
        ? opening.as
        : isNewDraftKey(active) || isNonThreadKey(active)
          ? "tab"
          : "preview";
    update((current) => showTab(current, active, as, isEmpty));
    if (opening !== undefined) setOpening(undefined);
  }

  // A tab whose thread has gone (deleted elsewhere, say) no longer shows; a file's tab stays, and
  // says so itself when its file has gone.
  const keys = strip.keys.filter(
    (key) =>
      key === active || !loaded || isNewDraftKey(key) || isNonThreadKey(key) || threadOf(key) !== undefined,
  );
  const visible = { ...strip, keys };
  const tabs: ReadonlyArray<TabView> = keys.map((key) => {
    const preview = strip.preview === key;
    const github = githubOfKey(key);
    if (github)
      return {
        key,
        // The tab says what it is called once it has been read; until then, its number.
        title: githubTitles.get(key) ?? `#${github.number}`,
        draft: false,
        preview,
        github,
        project: `${github.kind === "pr" ? "Pull request" : "Issue"} #${github.number} · ${baseName(github.root)}`,
      };
    const commit = commitFileOfKey(key);
    const turn = turnFileOfKey(key);
    const file = fileOfKey(key) ?? commit ?? turn;
    if (file)
      return {
        key,
        title: baseName(file.path),
        draft: false,
        preview,
        file,
        // A file as a commit or a turn changed it says so, its folder would say nothing.
        project:
          commit !== undefined
            ? commit.sha.slice(0, 7)
            : turn !== undefined
              ? "Agent's change"
              : file.path.includes("/")
                ? `${baseName(file.root)}/${file.path}`
                : baseName(file.root),
      };
    const thread = threadOf(key);
    if (thread)
      return {
        key,
        title: thread.title,
        draft: false,
        preview,
        chat: thread.mode === "chat",
        status: thread.status,
        unread: thread.unread,
        ...(thread.providers[0] ? { provider: thread.providers[0] } : {}),
        ...(thread.project ? { project: thread.project } : thread.mode === "chat" ? { project: "Chat" } : {}),
        thread,
      };
    const draft = drafts.find((candidate) => candidate.key === key);
    const tabMode = draftModeOf(key, draft?.mode);
    return {
      key,
      // A thread the list hasn't brought yet says nothing rather than something wrong. A draft's own
      // title is read where it shows (`newThreadDraftTitleAtom`), so typing doesn't render the window.
      title: isNewDraftKey(key) ? (tabMode === "work" ? "New thread" : "New chat") : "",
      draft: isNewDraftKey(key),
      chat: tabMode === "chat",
      preview,
      ...(draft?.folder
        ? { project: baseName(draft.folder) }
        : tabMode === "chat"
          ? { project: "Chat" }
          : {}),
    };
  });

  const show = (key: string | undefined) => {
    if (key !== undefined && key !== active) onShow(key);
  };
  /** Opens a blank new thread or chat in a tab of its own. */
  const fresh = (focus = true, targetMode: AppMode = mode) => {
    const key = newDraftKey(targetMode);
    setOpening({ key, as: "tab" });
    onFresh(key, focus);
  };
  /** Opens a new thread/chat: reuses an empty tab of the same mode if one exists, else opens a fresh one. */
  const newTab = (targetMode: AppMode = mode) => {
    const emptyTab = isEmptyOfMode(active, targetMode)
      ? active
      : keys.find((key) => isEmptyOfMode(key, targetMode));
    if (emptyTab === undefined) fresh(true, targetMode);
    else show(emptyTab);
  };

  const close = (closing: ReadonlyArray<string>, remember = true, replacement?: string) => {
    // The last tab, holding nothing, stays: closing it would only open another like it.
    if (keys.length === 1 && closing.includes(active) && isEmpty(active)) return;
    const { next } = closeTabs(visible, closing, { remember });
    update((current) => closeTabs(current, closing, { remember }).strip);
    const instead = onClosed(closing);
    if (!closing.includes(active)) return;
    const shown = replacement ?? instead ?? next;
    if (shown === undefined) fresh(remember, mode);
    else onShow(shown);
  };
  const canReopen = (key: string) =>
    isNonThreadKey(key) ||
    (isNewDraftKey(key) ? drafts.some((draft) => draft.key === key) : threadOf(key) !== undefined);
  const reopenable = strip.closed.some((key) => !keys.includes(key) && canReopen(key));
  const reopen = () => {
    const { key } = reopenTab(visible, canReopen);
    if (key === undefined) return;
    update((current) => ({ ...current, closed: current.closed.filter((each) => each !== key) }));
    setOpening({ key, as: "tab" });
    onShow(key);
  };

  const actions: TabActions = {
    onActivate: show,
    onClose: (closing) => close(closing),
    onKeep: (key) => update((current) => keepTab(current, key)),
    onMove: (key, index) => update((current) => moveTab({ ...current, keys }, key, index)),
    onNewTab: () => newTab(mode),
    ...(reopenable ? { onReopen: reopen } : {}),
  };

  return {
    strips,
    tabs,
    actions,
    /** Asks for the next thread shown to open as `as`: the sidebar's Ctrl click wants a tab of its own. */
    openAs: (key: string, as: OpenAs) => setOpening({ key, as }),
    /** The user worked in the tab: it's no longer the preview. */
    keep: (key: string) => update((current) => keepTab(current, key)),
    /**
     * A new thread started: its tab is now the thread's, and the threads started with it (multi
     * agent) open in tabs right after it.
     */
    started: (draft: string, thread: string, beside: ReadonlyArray<string> = []) =>
      update((current) => openBeside(renameTab(keepTab(current, draft), draft, thread), thread, beside)),
    /** Closes `key`'s tab, if it has one, without offering to reopen it: its thread is gone. */
    drop: (key: string) => {
      if (keys.includes(key)) close([key], false);
    },
    /** Drops archived tabs together. A background strip updates without changing the current view. */
    dropMany: (archived: ReadonlyArray<string>, replacement: string, background = false) => {
      if (archived.length === 0) return;
      if (background) update((current) => closeTabs(current, archived, { remember: false }).strip);
      else close(archived, false, replacement);
    },
    /** Opens a new thread or chat: in an empty tab of that mode if one exists, else in a tab of its own. */
    newTab,
    // The shortcuts.
    closeActive: () => close([active]),
    reopen,
    step: (by: number) => show(tabBeside(keys, active, by)),
    goTo: (digit: number) => show(tabAtDigit(keys, digit)),
    shift: (by: number) =>
      update((current) => moveTab({ ...current, keys }, active, keys.indexOf(active) + by)),
  };
}
