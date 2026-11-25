import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  AppWindow,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArchiveRestore,
  Bot,
  Briefcase,
  Columns2,
  ClipboardCopy,
  Compass,
  CornerDownRight,
  FileDown,
  FoldVertical,
  FolderTree,
  GalleryVerticalEnd,
  GitBranch,
  GitPullRequestArrow,
  Globe,
  History,
  Inbox as InboxIcon,
  Link,
  MessagesSquare,
  OctagonX,
  PanelLeft,
  Play,
  RotateCcw,
  Rows2,
  ScrollText,
  Search,
  TextCursor,
  Settings,
  Square,
  SquarePen,
  SquareTerminal,
  UnfoldVertical,
  Wrench,
  X,
} from "lucide-react";
import { useContext } from "react";

import { compactAgent, manifestsAtom } from "../backend/atoms.ts";
import { WEB } from "../backend/target.ts";
import type { PaletteCommand } from "../features/palette/palette.ts";
import { appearanceCommands, projectCommands } from "../features/palette/workspaceCommands.ts";
import { themeAtom } from "../features/settings/preferences.ts";
import { paletteAtom } from "../features/settings/palettes.ts";
import { useDesktopColors } from "../features/settings/desktopColors.ts";
import { settingsPages } from "../features/settings/Settings.tsx";
import { useShownTheme } from "../features/settings/theme.ts";
import { workedChoiceAtom } from "../features/transcript/workToggles.ts";
import { useThreadExport } from "../features/export/useThreadExport.ts";
import { canArchive } from "../features/threads/model.ts";
import { openFind } from "../features/transcript/find.ts";
import { whatsNewOpenAtom } from "../features/whatsnew/state.ts";
import { welcomeOpenAtom } from "../features/onboarding/state.ts";
import { importOpenAtom } from "../features/imports/state.ts";
import { isNonThreadKey } from "../features/tabs/tabKinds.ts";
import { type ShortcutId } from "../lib/shortcuts.ts";
import { threadLink } from "../features/launch/CopyLink.tsx";
import { copyText } from "../features/transcript/menus.ts";

import type { SoloThread } from "./threadWindow.ts";
import type { WorkspaceSession } from "./useWorkspaceSession.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";
import type { WorkspaceTabs } from "./useWorkspaceTabs.ts";
import type { WorkspaceComposer } from "./useWorkspaceComposer.ts";
import type { WorkspacePanels } from "./useWorkspacePanels.ts";
import type { WorkspaceTools } from "./useWorkspaceTools.tsx";
import type { WorkspacePlaces } from "./useWorkspacePlaces.ts";
import type { WorkspaceThreadLifecycle } from "./useWorkspaceThreadLifecycle.tsx";
import type { WorkspacePreview } from "./useWorkspacePreview.tsx";
import type { WorkspacePaneActions } from "./useThreadPaneActions.tsx";
import type { useWorkspaceErrors } from "./workspaceErrors.ts";

export function useWorkspaceCommands({
  solo,
  compact,
  keys,
  sessionState,
  threads,
  tabView,
  composer,
  panels,
  tools,
  places,
  lifecycle,
  preview,
  paneControls,
  errors,
  sidebarOpen,
  toggleSidebar,
  returnToComposer,
  onMoveToWork,
}: {
  readonly solo: SoloThread | undefined;
  readonly compact: boolean;
  readonly keys: (id: ShortcutId) => string;
  readonly sessionState: WorkspaceSession;
  readonly threads: WorkspaceThreads;
  readonly tabView: WorkspaceTabs;
  readonly composer: WorkspaceComposer;
  readonly panels: WorkspacePanels;
  readonly tools: WorkspaceTools;
  readonly places: WorkspacePlaces;
  readonly lifecycle: WorkspaceThreadLifecycle;
  readonly preview: WorkspacePreview;
  readonly paneControls: WorkspacePaneActions;
  readonly errors: ReturnType<typeof useWorkspaceErrors>;
  readonly sidebarOpen: boolean;
  readonly toggleSidebar: () => void;
  readonly returnToComposer: () => void;
  readonly onMoveToWork?: ((threadId: string) => void) | undefined;
}) {
  const registry = useContext(RegistryContext);
  const { mode, setMode, current, panes, savedProjects, projects, defaultFolder, chooseFolder } =
    sessionState;
  const { selected, viewed, cloudSelected, selectedSummary, openInWindow, projectOf } = threads;
  const { tabs, newThread, splitNew, jumpNextWaiting, startThreadFrom } = tabView;
  const { openModels, steerNow, stepPrompt } = composer;
  const {
    inspectedAgent,
    inspectorOpen,
    filesOpen,
    gitOpen,
    githubOpen,
    artifactsOpen,
    toggleInspector,
    toggleFiles,
    toggleGit,
    toggleGitHub,
    toggleArtifacts,
  } = panels;
  const {
    viewedLead,
    filesRoot,
    gitRoot,
    githubRoot,
    terminal,
    runRunning,
    runThreadId,
    toggleRun,
    setupProject,
    projectActions,
    toggleAction,
    artifactsAvailable,
  } = tools;
  const { showThreads, openSettings } = places;
  const { canContinue, continueFresh, restoreArchived } = lifecycle;
  const { previewThread, previewOpen, togglePreview } = preview;
  const { canSteer, canStopAll, askStopAll } = paneControls;
  const { attempt } = errors;
  const manifests = useAtomValue(manifestsAtom);
  const compactLead = useAtomSet(compactAgent, { mode: "promise" });
  const openWhatsNew = useAtomSet(whatsNewOpenAtom);
  const openImport = useAtomSet(importOpenAtom);
  const openWelcome = useAtomSet(welcomeOpenAtom);
  const exportThread = useThreadExport();
  /**
   * What the command palette (Ctrl K) runs besides opening a thread. To offer a new action, add an entry
   * to the "Actions" below: `keys` shows the shortcut it already has, `when` hides it while it can't run.
   */
  // The palette's actions the message box's `/` list offers too: each is named once here, and both
  // lists share it, so the two stay the same action.
  const newThreadCommand: PaletteCommand = {
    id: "new-thread",
    group: "Actions",
    label: mode === "work" ? "New thread" : "New chat",
    icon: SquarePen,
    keys: keys("new-thread"),
    run: () => newThread(mode),
  };
  const otherNewCommand: PaletteCommand = {
    id: mode === "work" ? "new-chat" : "new-work-thread",
    group: "Actions",
    label: mode === "work" ? "New chat" : "New thread",
    icon: mode === "work" ? MessagesSquare : SquarePen,
    run: () => newThread(mode === "work" ? "chat" : "work"),
  };
  const findCommand: PaletteCommand = {
    // The focused pane's thread finds the text: the files panel, when it has focus, finds files instead.
    id: "find-in-thread",
    group: "Actions",
    label: "Find in thread",
    icon: Search,
    keys: keys("find-in-thread"),
    keywords: "search messages transcript",
    when: selected !== undefined,
    run: openFind,
  };
  const compactCommand: PaletteCommand = {
    // The open thread's lead, between turns, where its harness compacts when asked.
    id: "compact",
    group: "Actions",
    label: "Compact conversation",
    icon: FoldVertical,
    keywords: "context summarize tokens",
    when:
      viewedLead !== undefined &&
      cloudSelected === undefined &&
      viewedLead.state === "idle" &&
      AsyncResult.isSuccess(manifests) &&
      manifests.value.some(
        (manifest) => manifest.provider === viewedLead.provider && manifest.compact === true,
      ),
    run: () => {
      if (viewedLead) void attempt(compactLead({ payload: { agentId: viewedLead.id } }));
    },
  };
  const continueCommand: PaletteCommand = {
    // The open thread of this machine's, between turns, in a new thread that starts small.
    id: "continue-thread",
    group: "Actions",
    label: "Continue in new thread",
    icon: CornerDownRight,
    keywords: "context handoff fresh tokens compact",
    when:
      selectedSummary !== undefined &&
      cloudSelected === undefined &&
      canContinue &&
      selectedSummary.elsewhere === undefined &&
      selectedSummary.archivedAt === undefined &&
      canArchive(selectedSummary),
    run: () => {
      if (selectedSummary) void continueFresh(selectedSummary.id);
    },
  };
  const settingsCommand: PaletteCommand = {
    id: "settings",
    group: "Actions",
    label: "Open settings",
    icon: Settings,
    keys: keys("open-settings"),
    run: () => openSettings(),
  };
  const shownTheme = useShownTheme();
  const desktopColors = useDesktopColors();
  const activeProject = filesRoot === undefined ? defaultFolder : projectOf(filesRoot);
  const projectChoices = [...new Set([activeProject, ...projects])]
    .filter((path) => path !== undefined)
    .filter((path) => !savedProjects.some((project) => project.path === path && project.missing === true));
  const paletteCommands: ReadonlyArray<PaletteCommand> = [
    newThreadCommand,
    otherNewCommand,
    ...projectCommands(projectChoices).map(({ folder, ...command }) => ({
      ...command,
      run: () => {
        chooseFolder(folder);
        startThreadFrom({ folder, text: "" });
      },
    })),
    ...appearanceCommands({
      shown: shownTheme,
      desktop: desktopColors !== undefined,
      setTheme: (theme) => registry.set(themeAtom, theme),
      setPalette: (palette) => registry.set(paletteAtom, palette),
    }),
    ...([true, false] as const).map((open): PaletteCommand => ({
      id: open ? "expand-worked" : "collapse-worked",
      group: "Actions",
      label: `${open ? "Expand" : "Collapse"} all Worked sections`,
      icon: open ? UnfoldVertical : FoldVertical,
      keywords: "worked tools steps open close fold unfold transcript",
      when: viewed !== undefined,
      run: () => {
        if (viewed !== undefined) registry.set(workedChoiceAtom(viewed.thread.id), { open });
      },
    })),
    {
      id: "sidebar",
      group: "Actions",
      label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
      icon: PanelLeft,
      keys: keys("toggle-sidebar"),
      run: toggleSidebar,
    },
    {
      id: "agents",
      group: "Actions",
      label: inspectorOpen ? "Hide agents" : "Show agents",
      icon: Bot,
      keys: keys("toggle-agents"),
      keywords: "inspector",
      when: selected !== undefined,
      run: toggleInspector,
    },
    findCommand,
    {
      id: "open-model-picker",
      group: "Actions",
      label: "Open model picker",
      icon: ArrowRightLeft,
      keys: keys("open-model-picker"),
      keywords: "switch model effort speed",
      when: !isNonThreadKey(current) && !inspectedAgent && (viewed === undefined || selected !== undefined),
      run: () => requestAnimationFrame(openModels),
    },
    {
      id: "steer-now",
      group: "Actions",
      label: "Steer now",
      icon: CornerDownRight,
      keys: keys("steer-now"),
      keywords: "send queued interrupt",
      when:
        canSteer &&
        selected !== undefined &&
        !inspectedAgent &&
        (viewedLead?.state === "running" || viewedLead?.state === "queued"),
      run: steerNow,
    },
    {
      id: "focus-composer",
      group: "Actions",
      label: "Focus message box",
      icon: TextCursor,
      keys: keys("focus-composer"),
      keywords: "composer prompt input type",
      run: returnToComposer,
    },
    ...(
      [
        { id: "prev-prompt", label: "Go to previous prompt", icon: ArrowUp, direction: -1 },
        { id: "next-prompt", label: "Go to next prompt", icon: ArrowDown, direction: 1 },
      ] as const
    ).map(({ id, label, icon, direction }): PaletteCommand => ({
      id,
      group: "Actions",
      label,
      icon,
      keys: keys(id),
      when: viewed !== undefined,
      run: () => stepPrompt(direction),
    })),
    {
      id: "jump-next-waiting",
      group: "Actions",
      label: "Go to next waiting or unread thread",
      icon: InboxIcon,
      keys: keys("jump-next-waiting"),
      keywords: "inbox attention approval failure",
      when: !solo,
      run: jumpNextWaiting,
    },
    compactCommand,
    continueCommand,
    {
      id: "move-chat-to-work",
      group: "Actions",
      label: "Move chat to work…",
      icon: Briefcase,
      keywords: "implement work project convert promote chat",
      when:
        onMoveToWork !== undefined &&
        selected !== undefined &&
        cloudSelected === undefined &&
        selected.thread.mode === "chat" &&
        selectedSummary !== undefined &&
        canArchive(selectedSummary),
      run: () => {
        if (selected && onMoveToWork) onMoveToWork(selected.thread.id);
      },
    },
    {
      id: "export-markdown",
      group: "Actions",
      label: "Export as Markdown…",
      icon: FileDown,
      keywords: "save download file thread conversation",
      when: selected !== undefined && cloudSelected === undefined,
      run: () => {
        if (selected) void exportThread(selected.thread.id, "markdown");
      },
    },
    {
      id: "export-text",
      group: "Actions",
      label: "Export as text…",
      icon: FileDown,
      keywords: "save download file thread conversation plain",
      when: selected !== undefined && cloudSelected === undefined,
      run: () => {
        if (selected) void exportThread(selected.thread.id, "text");
      },
    },
    {
      id: "copy-link",
      group: "Actions",
      label: "Copy thread link",
      icon: Link,
      keywords: "cerium url share note",
      when: selected !== undefined && cloudSelected === undefined,
      run: () => {
        if (selected) copyText(threadLink(selected.thread.id));
      },
    },
    {
      id: "copy-markdown",
      group: "Actions",
      label: "Copy as Markdown",
      icon: ClipboardCopy,
      keywords: "clipboard thread conversation",
      when: selected !== undefined && cloudSelected === undefined,
      run: () => {
        if (selected) void exportThread(selected.thread.id, "copy");
      },
    },
    {
      id: "stop-all",
      group: "Actions",
      label: "Stop everything",
      icon: OctagonX,
      keys: keys("stop-all"),
      keywords: "interrupt cancel halt agents deny approvals",
      when: canStopAll,
      run: askStopAll,
    },
    {
      id: "files",
      group: "Actions",
      label: filesOpen ? "Hide files" : "Show files",
      icon: FolderTree,
      keys: keys("toggle-files"),
      when: filesRoot !== undefined,
      run: toggleFiles,
    },
    {
      id: "source-control",
      group: "Actions",
      label: gitOpen ? "Hide source control" : "Show source control",
      icon: GitBranch,
      keys: keys("toggle-source-control"),
      keywords: "git changes stage commit",
      when: gitRoot !== undefined,
      run: toggleGit,
    },
    {
      id: "github",
      group: "Actions",
      label: githubOpen ? "Hide GitHub" : "Show GitHub",
      icon: GitPullRequestArrow,
      keys: keys("toggle-github-panel"),
      keywords: "pull requests prs issues reviews",
      when: githubRoot !== undefined,
      run: toggleGitHub,
    },
    {
      id: "terminal",
      group: "Actions",
      label: terminal.open ? "Hide terminal" : "Show terminal",
      icon: SquareTerminal,
      keys: keys("toggle-terminal"),
      when: terminal.available,
      run: terminal.toggle,
    },
    {
      id: "run-project",
      group: "Actions",
      label: runRunning ? "Stop project run" : "Run project",
      icon: runRunning ? Square : Play,
      keywords: "dev server start localhost stop",
      when: runThreadId !== undefined,
      run: toggleRun,
    },
    {
      // The project's setup command: what makes the thread's folder (or its new worktree) usable.
      id: "setup-project",
      group: "Actions",
      label: "Setup project",
      icon: Wrench,
      keywords: "install dependencies npm bun pnpm build",
      when: runThreadId !== undefined,
      run: setupProject,
    },
    // The project's named actions, each run in a terminal of the thread's own.
    ...projectActions.map((action) => ({
      id: `project-action:${action.name}`,
      group: "Actions" as const,
      label: `${action.running ? "Stop" : "Run"} ${action.name}`,
      icon: action.running ? Square : Play,
      keywords: "project action command script test lint build",
      when: runThreadId !== undefined,
      run: () => toggleAction(action.name),
    })),
    {
      id: "preview",
      group: "Actions",
      label: previewOpen ? "Hide preview" : "Show preview",
      icon: Globe,
      keys: keys("toggle-preview"),
      keywords: "browser web page localhost dev server",
      when: previewThread !== undefined,
      run: togglePreview,
    },
    {
      id: "artifacts",
      group: "Actions",
      label: artifactsOpen ? "Hide artifacts" : "Show artifacts",
      icon: GalleryVerticalEnd,
      keys: keys("toggle-artifacts"),
      when: artifactsAvailable,
      run: toggleArtifacts,
    },
    {
      id: "mode",
      group: "Actions",
      label: mode === "work" ? "Switch to Chat" : "Switch to Work",
      icon: MessagesSquare,
      keys: keys(mode === "work" ? "switch-to-chat" : "switch-to-work"),
      run: () => {
        showThreads();
        setMode(mode === "work" ? "chat" : "work");
      },
    },
    {
      id: "split-right",
      group: "Actions",
      label: "Split right",
      icon: Columns2,
      keys: keys("split-right"),
      keywords: "new thread beside pane",
      when: !compact,
      run: () => splitNew(panes.focused, "right"),
    },
    {
      id: "split-below",
      group: "Actions",
      label: "Split below",
      icon: Rows2,
      keys: keys("split-below"),
      keywords: "new thread pane",
      when: !compact,
      run: () => splitNew(panes.focused, "bottom"),
    },
    {
      id: "close-tab",
      group: "Actions",
      label: "Close tab",
      icon: X,
      keys: keys("close-tab"),
      when: !compact,
      run: tabs.closeActive,
    },
    {
      id: "reopen-tab",
      group: "Actions",
      label: "Reopen closed tab",
      icon: RotateCcw,
      keys: keys("reopen-tab"),
      when: !compact,
      run: tabs.reopen,
    },
    {
      // The open thread on a window of its own, to keep beside this one or on another screen.
      id: "open-window",
      group: "Actions",
      label: "Open in new window",
      icon: AppWindow,
      keywords: "pop out detach separate second monitor screen",
      when: openInWindow !== undefined && selected !== undefined,
      run: () => {
        if (selected) openInWindow?.(selected.thread.id);
      },
    },
    {
      // An archived thread, a chat most of all, is found through the palette, and brought back here.
      id: "restore-thread",
      group: "Actions",
      label: "Restore from archive",
      icon: ArchiveRestore,
      keywords: "unarchive archived",
      when: selectedSummary?.archivedAt !== undefined,
      run: () => {
        if (selectedSummary === undefined) return;
        void restoreArchived(selectedSummary.id);
      },
    },
    settingsCommand,
    {
      id: "whats-new",
      group: "Actions",
      label: "What's new",
      icon: ScrollText,
      keywords: "changelog release notes updates",
      run: () => openWhatsNew(true),
    },
    {
      id: "welcome",
      group: "Actions",
      label: "Welcome tour",
      icon: Compass,
      keywords: "onboarding introduction hello start themes harnesses",
      // The web client opens no welcome: it signs in to a desktop that had one.
      when: !WEB,
      run: () => openWelcome(true),
    },
    {
      id: "import-sessions",
      group: "Actions",
      label: "Import sessions…",
      icon: History,
      keywords: "bring sessions claude code codex opencode muse history resume",
      run: () => openImport(true),
    },
    ...settingsPages.map(({ id, label, icon, group }): PaletteCommand => ({
      id: `settings-${id}`,
      group: "Settings",
      label,
      icon,
      keywords: `settings ${group.toLowerCase()}`,
      run: () => openSettings(id),
    })),
  ];

  /**
   * The palette's actions the message box's `/` list offers: new thread, find in thread, compacting,
   * continuing in a new thread and settings. Each keeps its own `when`, so the list shows what runs here.
   */
  const slashCommands: ReadonlyArray<PaletteCommand> = [
    newThreadCommand,
    findCommand,
    compactCommand,
    continueCommand,
    {
      id: "move-chat-to-work",
      group: "Actions",
      label: "Move chat to work…",
      icon: Briefcase,
      keywords: "implement work project convert promote chat",
      when:
        onMoveToWork !== undefined &&
        selected !== undefined &&
        cloudSelected === undefined &&
        selected.thread.mode === "chat" &&
        selectedSummary !== undefined &&
        canArchive(selectedSummary),
      run: () => {
        if (selected && onMoveToWork) onMoveToWork(selected.thread.id);
      },
    },
    settingsCommand,
  ];

  return { paletteCommands, slashCommands };
}
