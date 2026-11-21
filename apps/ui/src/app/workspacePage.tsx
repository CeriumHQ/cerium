import { ScrollArea } from "../components/ui/ScrollArea.tsx";
import {
  AutomationDetail,
  AutomationList,
  AutomationsPage,
} from "../features/automations/AutomationsPage.tsx";
import { TaskDetail, TaskList, TasksPage, type HandOff } from "../features/tasks/TasksPage.tsx";
import { taskFromIssue } from "../features/tasks/tasks.ts";
import { GitHubPageEmpty, GitHubPageList } from "../features/github/GitHubPage.tsx";
import { GitHubTabView } from "../features/github/GitHubTab.tsx";
import { githubKey, type GitHubTab } from "../features/github/model.ts";
import { IssueViewer } from "../features/issues/IssueViewer.tsx";
import { AppFrame } from "./AppFrame.tsx";
import { paneClass } from "../components/ui/Pane.tsx";

import type { ComponentProps } from "react";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";
import type { WorkspaceTabs } from "./useWorkspaceTabs.ts";
import type { WorkspaceTools } from "./useWorkspaceTools.tsx";
import type { WorkspacePlaces } from "./useWorkspacePlaces.ts";

export function workspacePage({
  compact,
  places,
  threads,
  tabView,
  tools,
}: {
  readonly compact: boolean;
  readonly places: WorkspacePlaces;
  readonly threads: WorkspaceThreads;
  readonly tabView: WorkspaceTabs;
  readonly tools: WorkspaceTools;
}): ComponentProps<typeof AppFrame>["page"] {
  const {
    place,
    taskPick,
    setTaskPick,
    taskProject,
    setTaskProject,
    tasksPane,
    setTasksPane,
    closeTaskDetail,
    automationPick,
    setAutomationPick,
    automationsPane,
    setAutomationsPane,
    githubPick,
    setGithubPick,
    githubPane,
    setGithubPane,
    openCapturedTask,
  } = places;
  const { summaries, available, projectOf } = threads;
  const { startThreadFrom, openThreadById, openSummary, worktreesOk } = tabView;
  const { issuesOk, automationsOk, githubAutomationsOk } = tools;
  /** Hands a task to an agent: a new work thread with the task in its message box. */
  const handOff: HandOff = (task) =>
    startThreadFrom({
      taskId: task.id,
      folder: task.folder,
      text: task.note ? `${task.title}\n\n${task.note}` : task.title,
    });
  const taskThreads = {
    threads: new Map(
      summaries.toSorted((a, b) => b.updatedAt - a.updatedAt).map((thread) => [thread.id, thread]),
    ),
    onOpenThread: openThreadById,
  };
  const taskList = (
    <TaskList
      selected={taskPick}
      onSelect={(id) => {
        setTaskPick(id);
        setTasksPane("main");
      }}
      onHandOff={handOff}
      project={taskProject}
      onProjectChange={setTaskProject}
      {...taskThreads}
    />
  );
  /** Opens a thread an automation started, from its runs. */
  const openAutomationThread = (threadId: string) => {
    const summary = summaries.find((candidate) => candidate.id === threadId);
    if (summary) openSummary(summary);
  };
  const automationList = (
    <AutomationList
      selected={automationPick}
      onSelect={(id) => {
        setAutomationPick(id);
        setAutomationsPane("main");
      }}
      onNew={() => {
        setAutomationPick("new");
        setAutomationsPane("main");
      }}
    />
  );
  /** The picked automation's form, keyed so a switch starts it afresh. */
  const automationDetail = (onClose?: () => void) =>
    automationPick === undefined ? null : (
      <AutomationDetail
        key={automationPick}
        id={automationPick === "new" ? undefined : automationPick}
        available={available}
        githubOk={githubAutomationsOk}
        {...(onClose ? { onClose } : {})}
        onCreated={setAutomationPick}
        onDeleted={() => {
          setAutomationPick(undefined);
          setAutomationsPane("list");
        }}
        onOpenThread={openAutomationThread}
      />
    );
  /** The Automations page, laid out as the Tasks page is. */
  const automationsPage = compact
    ? {
        title: "Automations",
        list: <ScrollArea className="h-full">{automationList}</ScrollArea>,
        main: automationDetail(),
        pane: automationsPane,
        onBackToList: () => setAutomationsPane("list"),
      }
    : {
        title: "Automations",
        main: (
          <AutomationsPage
            list={automationList}
            detail={automationDetail(() => setAutomationPick(undefined))}
          />
        ),
        pane: "main" as const,
        onBackToList: () => setAutomationPick(undefined),
      };

  /**
   * The Tasks page lays out its own list and the picked task on a wide window; a narrow one shows
   * them a pane at a time.
   */
  const tasksPage = compact
    ? {
        title: "Tasks",
        list: <ScrollArea className="h-full">{taskList}</ScrollArea>,
        main:
          taskPick === undefined ? null : (
            <TaskDetail
              id={taskPick}
              onDeleted={() => setTasksPane("list")}
              onHandOff={handOff}
              {...taskThreads}
            />
          ),
        pane: tasksPane,
        onBackToList: () => setTasksPane("list"),
      }
    : {
        title: "Tasks",
        main: (
          <TasksPage
            list={taskList}
            detail={
              taskPick === undefined ? null : (
                <TaskDetail
                  id={taskPick}
                  onClose={closeTaskDetail}
                  onDeleted={closeTaskDetail}
                  onHandOff={handOff}
                  {...taskThreads}
                />
              )
            }
          />
        ),
        pane: "main" as const,
        onBackToList: closeTaskDetail,
      };

  /** The GitHub page's main area: the pull request or issue picked in its list, in a card of its own. */
  const githubPageMain =
    githubPick === undefined ? (
      <GitHubPageEmpty />
    ) : (
      <div
        className={`flex h-full flex-col overflow-hidden ${paneClass} max-md:rounded-none max-md:border-0`}
      >
        <GitHubTabView
          onOpenThread={openThreadById}
          key={githubKey(githubPick.root, githubPick.kind, githubPick.number)}
          tab={githubPick}
          worktrees={worktreesOk}
          onStartThread={({ text, worktree, workspace }) =>
            startThreadFrom({ folder: githubPick.root, text, worktree, ...(workspace ? { workspace } : {}) })
          }
          {...(issuesOk
            ? {
                issue: (tab: GitHubTab) => (
                  <IssueViewer
                    cwd={tab.root}
                    number={tab.number}
                    onClose={() => setGithubPick(undefined)}
                    onStartThread={(text) => startThreadFrom({ folder: tab.root, text })}
                    onAddTask={(issue) => openCapturedTask(taskFromIssue(issue, projectOf(tab.root)))}
                    onOpenPull={(number) => setGithubPick({ root: tab.root, kind: "pr", number })}
                  />
                ),
              }
            : {})}
          onClose={() => {
            setGithubPick(undefined);
            setGithubPane("list");
          }}
        />
      </div>
    );

  if (place === "github") {
    return {
      title: "GitHub",
      list: (
        <GitHubPageList
          selected={
            githubPick === undefined
              ? undefined
              : githubKey(githubPick.root, githubPick.kind, githubPick.number)
          }
          onOpen={(tab) => {
            setGithubPick(tab);
            setGithubPane("main");
          }}
          issues={issuesOk}
        />
      ),
      main: githubPageMain,
      pane: githubPane,
      onBackToList: () => setGithubPane("list"),
    };
  }
  if (place === "tasks") return tasksPage;
  if (place === "automations" && automationsOk) return automationsPage;
  return undefined;
}
