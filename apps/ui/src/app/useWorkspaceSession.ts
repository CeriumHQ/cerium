import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { machineKey } from "../backend/machine.ts";
import { savedProjectsAtom } from "../backend/projects.ts";
import { draftStartAtom, isNewDraftKey } from "../features/composer/drafts.ts";
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
  const [mode, setMode] = useState<AppMode>(() => solo?.mode ?? session?.mode ?? "work");
  /**
   * The open thread per mode, or the draft of a thread not started yet; none means the mode's blank
   * new thread.
   */
  const [openThread, setOpenThread] = useState<Partial<Record<AppMode, string>>>(() =>
    solo ? { [solo.mode]: solo.id } : (resumed?.open ?? {}),
  );
  /** Each mode's blank new thread: once it has something in it, "New thread" starts another. */
  const [blank, setBlank] = useState(() => resumed?.blank ?? freshBlank());
  /** How each mode's main area is split into panes, once the user split it; the open thread is the focused pane's. */
  const [panesByMode, setPanesByMode] = useState<Partial<Record<AppMode, Panes>>>(() => resumed?.panes ?? {});
  /** The narrow window's pane: the threads, or the open (or new) thread. */
  const [pane, setPane] = useState<"list" | "main">(() => resumed?.pane ?? "list");
  const folderKey = machineKey(FOLDER_KEY, driven);
  const [folder, setFolder] = useState(() => stored(folderKey));
  // Switching machines starts afresh there: its last folder, and no thread open from the other one.
  const [shownFolderKey, setShownFolderKey] = useState(folderKey);
  /** A thread on another machine the user opened, which opens once the window drives that machine. */
  const [openAfterSwitch, setOpenAfterSwitch] = useState<{
    readonly mode: AppMode;
    readonly id: string;
    readonly panes?: Panes;
  }>();
  if (shownFolderKey !== folderKey) {
    const back = resumePending ? resumed : undefined;
    setShownFolderKey(folderKey);
    setFolder(stored(folderKey));
    setOpenThread(openAfterSwitch ? { [openAfterSwitch.mode]: openAfterSwitch.id } : (back?.open ?? {}));
    setBlank(back?.blank ?? freshBlank());
    setPanesByMode(openAfterSwitch ? { [openAfterSwitch.mode]: openAfterSwitch.panes } : (back?.panes ?? {}));
    if (back) setPane(back.pane);
    setOpenAfterSwitch(undefined);
    setResumePending(false);
  }
  /** The thread not started yet the new-thread view shows: one opened from the sidebar, or the blank one. */
  const openDraft = isNewDraftKey(openThread[mode]) ? openThread[mode] : blank[mode];
  const savedProjects = AsyncResult.getOrElse(useAtomValue(savedProjectsAtom), () => []);
  const refreshProjects = useAtomRefresh(savedProjectsAtom);
  useEffect(() => {
    if (searchOpen) refreshProjects();
  }, [refreshProjects, searchOpen]);
  const projects = savedProjects.filter((project) => project.missing !== true).map(({ path }) => path);
  const latestProject = projects[0];
  /** The folder a new thread starts in, unless its draft chose one: the last one, else the project used most recently. */
  const defaultFolder = folder ?? latestProject;
  /** What the window shows: the open thread, or the draft of one not started yet. */
  const current = openThread[mode] ?? blank[mode];
  const currentStart = useAtomValue(draftStartAtom(current));
  /**
   * The project the work thread not started yet that the window shows would start in: its files,
   * changes, GitHub repository and terminals are there to use before the first message.
   */
  const newProject =
    mode === "work" && isNewDraftKey(current) ? (currentStart?.folder ?? defaultFolder) : undefined;
  // The panes follow whatever the window shows: the focused pane takes it, or the pane showing it takes focus.
  const storedPanes = panesByMode[mode];
  const panes = storedPanes ? followShown(storedPanes, current) : singlePane(MAIN_PANE, current);
  if (storedPanes !== undefined && panes !== storedPanes) {
    setPanesByMode((all) => ({ ...all, [mode]: panes }));
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
    panesByMode,
    setPanesByMode,
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
