import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { machineKey } from "../backend/machine.ts";
import { savedProjectsAtom } from "../backend/projects.ts";
import { draftModeOf, draftStartAtom, isNewDraftKey } from "../features/composer/drafts.ts";
import { followShown, isSplit, singlePane, type Panes } from "../features/split/model.ts";
import { commitFileOfKey, fileOfKey } from "../features/viewer/model.ts";
import { remember, stored } from "../lib/storage.ts";
import type { AppMode } from "./mode.ts";
import { freshBlank, restoredSession } from "./session.ts";

import type { DrivenMachine } from "../backend/machine.ts";
import type { SoloThread } from "./threadWindow.ts";

const FOLDER_KEY = "cerium:lastFolder";
export const MAIN_PANE = "main";
export const newPaneId = () => `pane-${crypto.randomUUID()}`;

export function useWorkspaceSession({
  driven,
  solo,
  compact,
  searchOpen,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly solo: SoloThread | undefined;
  readonly compact: boolean;
  readonly searchOpen: boolean;
}) {
  /** Where this tab was before a reload; it comes back once the window drives the same machine. */
  const [session] = useState(() => (solo ? undefined : restoredSession()));
  // Compared on its own line: the React Compiler skips a component whose ternary tests an optional chain.
  const sameMachine = session?.machine === driven?.id;
  const resumed = sameMachine ? session : undefined;
  const [resumePending, setResumePending] = useState(() => session !== undefined && resumed === undefined);
  /** Which sidebar list is shown (Home vs. Chat); open tabs and panes are unified across both. */
  const [mode, setMode] = useState<AppMode>(() => solo?.mode ?? session?.mode ?? "work");
  /** The open thread, file, PR/issue, or draft key; none means the blank new-thread draft. */
  const [openThread, setOpenThread] = useState<string | undefined>(() => solo?.id ?? resumed?.open);
  /** The fallback blank draft key: once written into, "New thread" / "New chat" starts another. */
  const [blank, setBlank] = useState(
    () => resumed?.blank ?? freshBlank(solo?.mode ?? session?.mode ?? "work"),
  );
  /** How the main area is split into panes, once split; the open item is the focused pane's. */
  const [storedPanes, setStoredPanes] = useState<Panes | undefined>(() => resumed?.panes);
  /** The narrow window's pane: the threads, or the open (or new) thread. */
  const [pane, setPane] = useState<"list" | "main">(() => resumed?.pane ?? "list");
  const folderKey = machineKey(FOLDER_KEY, driven);
  const [folder, setFolder] = useState(() => stored(folderKey));
  // Switching machines starts afresh there: its last folder, and no thread open from the other one.
  const [shownFolderKey, setShownFolderKey] = useState(folderKey);
  /** A thread on another machine the user opened, which opens once the window drives that machine. */
  const [openAfterSwitch, setOpenAfterSwitch] = useState<{
    readonly id: string;
    readonly panes?: Panes;
  }>();
  if (shownFolderKey !== folderKey) {
    const back = resumePending ? resumed : undefined;
    setShownFolderKey(folderKey);
    setFolder(stored(folderKey));
    setOpenThread(openAfterSwitch ? openAfterSwitch.id : back?.open);
    setBlank(back?.blank ?? freshBlank(mode));
    setStoredPanes(openAfterSwitch ? openAfterSwitch.panes : back?.panes);
    if (back) setPane(back.pane);
    setOpenAfterSwitch(undefined);
    setResumePending(false);
  }
  /** The thread not started yet the new-thread view shows: one opened from the sidebar, or the blank one. */
  const openDraft = isNewDraftKey(openThread) ? openThread : blank;
  const savedProjects = AsyncResult.getOrElse(useAtomValue(savedProjectsAtom), () => []);
  const refreshProjects = useAtomRefresh(savedProjectsAtom);
  useEffect(() => {
    if (searchOpen) refreshProjects();
  }, [refreshProjects, searchOpen]);
  const projects = savedProjects.filter((project) => project.missing !== true).map(({ path }) => path);
  const latestProject = projects[0];
  /** The folder a new thread starts in, unless its draft chose one: the last one, else the project used most recently. */
  const defaultFolder = folder ?? latestProject;
  /** What the window shows: the open thread/file/PR, or the draft of one not started yet. */
  const current = openThread ?? blank;
  const currentStart = useAtomValue(draftStartAtom(current));
  /**
   * The project the work thread not started yet that the window shows would start in: its files,
   * changes, GitHub repository and terminals are there to use before the first message.
   */
  const newProject =
    isNewDraftKey(current) && draftModeOf(current, currentStart?.mode) === "work"
      ? (currentStart?.folder ?? defaultFolder)
      : undefined;
  // The panes follow whatever the window shows: the focused pane takes it, or the pane showing it takes focus.
  const panes = storedPanes ? followShown(storedPanes, current) : singlePane(MAIN_PANE, current);
  if (storedPanes !== undefined && panes !== storedPanes) {
    setStoredPanes(panes);
  }
  const split = !compact && isSplit(panes);
  /** The file the open tab shows, when it shows one. */
  const openFile = fileOfKey(current);
  /** The folder of the file a commit's tab shows, which is the repository Source control and the files panel show. */
  const openCommitRoot = commitFileOfKey(current)?.root;
  const chooseFolder = (picked: string) => {
    setFolder(picked);
    remember(folderKey, picked);
  };

  return {
    session,
    resumePending,
    mode,
    setMode,
    openThread,
    setOpenThread,
    blank,
    setBlank,
    storedPanes,
    setStoredPanes,
    panes,
    split,
    pane,
    setPane,
    setOpenAfterSwitch,
    openDraft,
    defaultFolder,
    newProject,
    projects,
    savedProjects,
    current,
    openFile,
    openCommitRoot,
    chooseFolder,
  };
}

export type WorkspaceSession = ReturnType<typeof useWorkspaceSession>;
