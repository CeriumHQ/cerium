import { type ThreadOverview } from "@cerium/rpc";
import { RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useEffectEvent } from "react";

import { scaleAtom, stepScale } from "../features/settings/preferences.ts";
import { canScale } from "../features/settings/scale.ts";
import { openFind } from "../features/transcript/find.ts";
import { usesCommandKey } from "../lib/keys.ts";
import {
  isCapturingBinding,
  isField,
  matchesBinding,
  matchesFamily,
  type ShortcutId,
  typesInField,
} from "../lib/shortcuts.ts";

import type { Dispatch, SetStateAction } from "react";
import type { SoloThread } from "./threadWindow.ts";
import type { WorkspaceSession } from "./useWorkspaceSession.ts";
import type { WorkspaceTabs } from "./useWorkspaceTabs.ts";
import type { WorkspaceComposer } from "./useWorkspaceComposer.ts";
import type { WorkspacePanels } from "./useWorkspacePanels.ts";
import type { WorkspaceTools } from "./useWorkspaceTools.tsx";
import type { WorkspacePlaces } from "./useWorkspacePlaces.ts";
import type { WorkspacePreview } from "./useWorkspacePreview.tsx";
import type { WorkspacePaneActions } from "./useThreadPaneActions.tsx";

/** The window's shortcuts a thread's own window keeps: its zoom, its panels and its thread's. */
const SOLO_SHORTCUTS: ReadonlyArray<ShortcutId> = [
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "toggle-agents",
  "toggle-files",
  "toggle-source-control",
  "toggle-github-panel",
  "toggle-artifacts",
  "focus-composer",
  "open-model-picker",
  "steer-now",
  "prev-prompt",
  "next-prompt",
  "find-in-thread",
  "stop-all",
];

export function useWorkspaceShortcuts({
  solo,
  compact,
  keys,
  searchOpen,
  setSearchOpen,
  places,
  sessionState,
  tabView,
  composer,
  panels,
  tools,
  preview,
  paneControls,
  selected,
  toggleSidebar,
  returnToComposer,
}: {
  readonly solo: SoloThread | undefined;
  readonly compact: boolean;
  readonly keys: (id: ShortcutId) => string;
  readonly searchOpen: boolean;
  readonly setSearchOpen: Dispatch<SetStateAction<boolean>>;
  readonly places: WorkspacePlaces;
  readonly sessionState: WorkspaceSession;
  readonly tabView: WorkspaceTabs;
  readonly composer: WorkspaceComposer;
  readonly panels: WorkspacePanels;
  readonly tools: WorkspaceTools;
  readonly preview: WorkspacePreview;
  readonly paneControls: WorkspacePaneActions;
  readonly selected: ThreadOverview | undefined;
  readonly toggleSidebar: () => void;
  readonly returnToComposer: () => void;
}) {
  const registry = useContext(RegistryContext);
  const { settingsOpen, setSettingsOpen, openPlace, showThreads } = places;
  const { setMode, panes } = sessionState;
  const { tabs, newThread, splitNew, jumpNextWaiting } = tabView;
  const { openModels, steerNow, stepPrompt } = composer;
  const { toggleFiles, toggleGit, toggleGitHub, toggleArtifacts, toggleInspector } = panels;
  const { githubOk, automationsOk, filesRoot, gitRoot, githubRoot, artifactsAvailable } = tools;
  const { askStopAll } = paneControls;
  const { previewThread, togglePreview } = preview;
  /**
   * The keys that step through and move the tabs. Control stays the Control key itself, as browsers
   * have it (a Mac's too, whose ⌘Tab switches apps); whether `event` was one.
   */
  const tabStepShortcut = (event: KeyboardEvent) => {
    const mac = usesCommandKey();
    if (matchesBinding(event, keys("next-tab"), mac)) tabs.step(1);
    else if (matchesBinding(event, keys("previous-tab"), mac)) tabs.step(-1);
    else if (matchesBinding(event, keys("move-tab-right"), mac)) tabs.shift(1);
    else if (matchesBinding(event, keys("move-tab-left"), mac)) tabs.shift(-1);
    else if (
      (event.key === "PageDown" || event.key === "PageUp") &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      // PageUp/PageDown with Control step even where the move bindings went elsewhere.
      const by = event.key === "PageDown" ? 1 : -1;
      if (event.shiftKey) tabs.shift(by);
      else tabs.step(by);
    } else return false;
    return true;
  };

  /** New, closed and closing tabs; whether `event` was one. */
  const tabShortcut = (event: KeyboardEvent) => {
    const mac = usesCommandKey();
    if (matchesBinding(event, keys("new-tab"), mac)) newThread();
    else if (matchesBinding(event, keys("reopen-tab"), mac)) tabs.reopen();
    else if (matchesBinding(event, keys("close-tab"), mac)) tabs.closeActive();
    else return false;
    return true;
  };

  // The shortcuts the window's buttons advertise in their tooltips, each following its rebind.
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    // Settings → Keyboard is listening for a rebind: the press being learned must not also run.
    if (isCapturingBinding()) return;
    const mac = usesCommandKey();
    const appChord = (id: ShortcutId) =>
      !event.defaultPrevented &&
      !event.isComposing &&
      !typesInField(event, isField(event.target)) &&
      matchesBinding(event, keys(id), mac);
    // A thread's own window takes its thread's keys alone, with no tabs, sidebar, places or
    // settings of its own; closing a tab closes the window.
    if (solo) {
      if (matchesBinding(event, keys("close-tab"), mac)) {
        event.preventDefault();
        window.close();
        return;
      }
      if (!SOLO_SHORTCUTS.some((id) => matchesBinding(event, keys(id), mac))) return;
    }
    // Returning to the composer works even from the command palette, while respecting modal dialogs
    // and letting a terminal selection claim Ctrl Shift L first during capture.
    if (
      !settingsOpen &&
      appChord("focus-composer") &&
      (searchOpen ||
        !(event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"]')))
    ) {
      event.preventDefault();
      if (!event.repeat) returnToComposer();
      return;
    }
    // Let the palette handle its keys before the workspace views it covers.
    if (searchOpen && !matchesBinding(event, keys("command-palette"), mac)) return;
    // Esc backs out of settings, unless something inside them (an open menu) already used it.
    if (event.key === "Escape" && settingsOpen && !event.defaultPrevented) {
      setSettingsOpen(false);
      return;
    }
    // The go-to-tab binding's digit goes to a tab, as the open-thread-row binding opens a sidebar row.
    if (matchesFamily(event, keys("go-to-tab"), mac)) {
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit === undefined || settingsOpen || searchOpen || compact) return;
      // A Mac's Option layer types with these keys (⌥3 is `#` on a British layout), and in a field
      // the character wins.
      if (typesInField(event, isField(event.target))) return;
      tabs.goTo(Number(digit));
      event.preventDefault();
      return;
    }
    const control = event.ctrlKey && !event.metaKey && !event.altKey;
    if (control && !searchOpen && !settingsOpen && !compact && tabStepShortcut(event)) {
      event.preventDefault();
      return;
    }
    // The zoom bindings scale the desktop window wherever focus is; a browser zooms the page itself.
    if (canScale()) {
      const scaling = matchesBinding(event, keys("zoom-in"), mac)
        ? 1
        : matchesBinding(event, keys("zoom-out"), mac)
          ? -1
          : matchesBinding(event, keys("zoom-reset"), mac)
            ? "reset"
            : undefined;
      if (scaling !== undefined) {
        registry.set(scaleAtom, scaling === "reset" ? 100 : stepScale(registry.get(scaleAtom), scaling));
        event.preventDefault();
        return;
      }
    }
    if (!settingsOpen && !compact && tabShortcut(event)) {
      event.preventDefault();
      return;
    }
    // The split bindings open a new thread beside the focused pane, below with the below binding.
    if (!settingsOpen && !compact && matchesBinding(event, keys("split-right"), mac)) {
      splitNew(panes.focused, "right");
      event.preventDefault();
      return;
    }
    if (!settingsOpen && !compact && matchesBinding(event, keys("split-below"), mac)) {
      splitNew(panes.focused, "bottom");
      event.preventDefault();
      return;
    }
    if (matchesBinding(event, keys("switch-to-work"), mac)) {
      showThreads();
      setMode("work");
    } else if (matchesBinding(event, keys("switch-to-chat"), mac)) {
      showThreads();
      setMode("chat");
    } else if (matchesBinding(event, keys("open-tasks"), mac)) {
      openPlace("tasks");
    } else if (matchesBinding(event, keys("open-github"), mac) && githubOk) {
      openPlace("github");
    } else if (matchesBinding(event, keys("open-automations"), mac) && automationsOk) {
      openPlace("automations");
    } else if (!settingsOpen && matchesBinding(event, keys("toggle-files"), mac) && filesRoot !== undefined) {
      toggleFiles();
    } else if (
      !settingsOpen &&
      matchesBinding(event, keys("toggle-source-control"), mac) &&
      gitRoot !== undefined
    ) {
      toggleGit();
    } else if (
      !settingsOpen &&
      matchesBinding(event, keys("toggle-github-panel"), mac) &&
      githubRoot !== undefined
    ) {
      toggleGitHub();
    } else if (!settingsOpen && matchesBinding(event, keys("stop-all"), mac)) {
      askStopAll();
    } else if (matchesBinding(event, keys("open-settings"), mac)) {
      setSettingsOpen(!settingsOpen);
    } else if (matchesBinding(event, keys("command-palette"), mac)) {
      setSearchOpen((open) => !open);
    } else if (settingsOpen) {
      return;
    } else if (appChord("open-model-picker")) {
      if (!event.repeat && !openModels()) return;
    } else if (appChord("steer-now")) {
      if (!event.repeat && !steerNow()) return;
    } else if (appChord("prev-prompt")) {
      if (!stepPrompt(-1)) return;
    } else if (appChord("next-prompt")) {
      if (!stepPrompt(1)) return;
    } else if (appChord("jump-next-waiting")) {
      if (!event.repeat && !jumpNextWaiting()) return;
    } else if (appChord("toggle-preview") && previewThread !== undefined) {
      if (!event.repeat) togglePreview();
    } else if (appChord("toggle-artifacts") && artifactsAvailable) {
      if (!event.repeat) toggleArtifacts();
    } else if (matchesBinding(event, keys("toggle-sidebar"), mac)) {
      toggleSidebar();
    } else if (matchesBinding(event, keys("new-thread"), mac)) {
      newThread();
    } else if (matchesBinding(event, keys("toggle-agents"), mac)) {
      if (selected === undefined) return;
      toggleInspector();
    } else if (matchesBinding(event, keys("find-in-thread"), mac)) {
      // The files panel's binding prevents default before the window hears it, and keeps the key.
      if (event.defaultPrevented) return;
      openFind();
    } else {
      return;
    }
    event.preventDefault();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Middle click never latches Chromium's autoscroll (the round arrows a website scrolls with):
  // the only middle click with a job of its own is a files row opening a thread tab.
  useEffect(() => {
    const listener = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };
    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, []);
}
