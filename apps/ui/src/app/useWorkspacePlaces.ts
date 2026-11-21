import { RegistryContext } from "@effect/atom-react";
import { useContext, useState } from "react";

import { captureTask, type NewTask } from "../features/tasks/tasks.ts";
import { type GitHubTab } from "../features/github/model.ts";
import { type SettingsCategory } from "../features/settings/Settings.tsx";

import type { SoloThread } from "./threadWindow.ts";

export type WorkspacePlace = "tasks" | "github" | "automations";

export function useWorkspacePlaces(solo: SoloThread | undefined) {
  const registry = useContext(RegistryContext);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The rail's place besides the threads that shows, if any: the user's tasks, GitHub's items, or the
   * automations.
   */
  const [place, setPlace] = useState<WorkspacePlace>();
  /** The automation the Automations page shows beside its list: one saved, or `"new"`. */
  const [automationPick, setAutomationPick] = useState<string>();
  /** The narrow window's Automations pane: the list, or the automation picked in it. */
  const [automationsPane, setAutomationsPane] = useState<"list" | "main">("list");
  /** The task the Tasks page shows beside its list. */
  const [taskPick, setTaskPick] = useState<string>();
  const [taskProject, setTaskProject] = useState<string | null>();
  /** The narrow window's Tasks pane: the list, or the task picked in it. */
  const [tasksPane, setTasksPane] = useState<"list" | "main">("list");
  /** The pull request or issue the GitHub page shows. */
  const [githubPick, setGithubPick] = useState<GitHubTab>();
  /** The narrow window's GitHub pane: the list, or what was picked in it. */
  const [githubPane, setGithubPane] = useState<"list" | "main">("list");
  /** Back to the threads, from settings or another of the rail's places. */
  const showThreads = () => {
    setSettingsOpen(false);
    setPlace(undefined);
  };
  const openTask = (id: string) => {
    setTaskPick(id);
    setTaskProject(undefined);
    setTasksPane("main");
    setSettingsOpen(false);
    setPlace("tasks");
  };
  const closeTaskDetail = () => {
    setTaskPick(undefined);
    if (solo) showThreads();
  };
  const openCapturedTask = (task: NewTask) => openTask(captureTask(registry, task));
  /** Its settings pane: the categories, or the open category's page. */
  const [settingsPane, setSettingsPane] = useState<"nav" | "page">("nav");
  /** The category settings open on: the last one visited. */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("appearance");
  const openSettings = (category?: SettingsCategory) => {
    if (category) setSettingsCategory(category);
    setSettingsPane(category ? "page" : "nav");
    setSettingsOpen(true);
  };

  const openPlace = (next: WorkspacePlace) => {
    setSettingsOpen(false);
    setPlace(next);
  };

  return {
    place,
    openPlace,
    showThreads,
    openTask,
    openCapturedTask,
    closeTaskDetail,
    settingsOpen,
    setSettingsOpen,
    settingsPane,
    setSettingsPane,
    settingsCategory,
    setSettingsCategory,
    openSettings,
    automationPick,
    setAutomationPick,
    automationsPane,
    setAutomationsPane,
    taskPick,
    setTaskPick,
    taskProject,
    setTaskProject,
    tasksPane,
    setTasksPane,
    githubPick,
    setGithubPick,
    githubPane,
    setGithubPane,
  };
}

export type WorkspacePlaces = ReturnType<typeof useWorkspacePlaces>;
