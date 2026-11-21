import "../src/styles/app.css";
import type { ThreadId } from "@cerium/protocol";
import type { IssueDetail, ThreadMatch } from "@cerium/rpc";
import { RegistryProvider, useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { SquarePen } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { paletteFilesAtom, workspaceSearchKey } from "../src/backend/files.ts";
import { issueAtom, issueKey } from "../src/backend/issues.ts";
import { threadSearchAtom, threadSearchKey } from "../src/backend/search.ts";
import { IssueViewer } from "../src/features/issues/IssueViewer.tsx";
import { CommandPalette } from "../src/features/palette/CommandPalette.tsx";
import { TaskList } from "../src/features/tasks/TasksPage.tsx";
import { ThreadTasks } from "../src/features/tasks/ThreadTasks.tsx";
import { addTask, taskFromIssue, taskFromMessage, tasksAtom } from "../src/features/tasks/tasks.ts";
import type { ThreadSummary } from "../src/features/threads/model.ts";
import { MessageMenuArea } from "../src/features/transcript/MessageMenu.tsx";
import { WorkDisclosures, WorkSection } from "../src/features/transcript/Work.tsx";
import { workedChoiceAtom } from "../src/features/transcript/workToggles.ts";

const app = "/projects/app";
const lib = "/projects/lib";
const work: ThreadSummary = {
  id: "work",
  title: "Deploy app",
  mode: "work",
  project: "app",
  folder: app,
  status: "running",
  providers: [],
  unread: false,
  updatedAt: 10,
};
const chat: ThreadSummary = { ...work, id: "chat", title: "Archived chat", mode: "chat", archivedAt: 8 };
const store = addTask(
  addTask({}, { title: "Check deployment", folder: app }, 1, "task"),
  "Read docs",
  2,
  "docs",
);
const passage: ThreadMatch = { threadId: "chat" as ThreadId, passage: [{ text: "needle", match: true }] };
const issue: IssueDetail = {
  number: 42,
  title: "Fix CI",
  state: "open",
  url: "https://github.com/org/app/issues/42",
  createdAt: 1,
  updatedAt: 1,
  comments: 0,
  labels: [],
  assignees: [],
  pullRequests: [],
  id: "issue-42",
  body: "CI is red",
  locked: false,
  reactions: [],
  branches: [],
  canUpdate: false,
  timeline: [],
  revision: "first",
};

function WorkedFixture({ id }: { readonly id: string }) {
  return (
    <WorkDisclosures threadId={id}>
      <section id={id}>
        {["one", "two"].map((step) => (
          <WorkSection
            key={step}
            tools={[]}
            timings={[]}
            stepIds={[step]}
            live={false}
            contains={() => false}
          >
            {step}
          </WorkSection>
        ))}
      </section>
    </WorkDisclosures>
  );
}

function Fixture() {
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState<string | null>();
  const [output, setOutput] = useState("");
  const [finished, setFinished] = useState(false);
  const setWorked = useAtomSet(workedChoiceAtom(work.id));
  const setTasks = useAtomSet(tasksAtom);
  const threads = new Map([
    [work.id, finished ? { ...work, status: "idle" as const } : work],
    [chat.id, chat],
  ]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <button id="finish-thread" type="button" onClick={() => setFinished(true)}>
        Finish thread
      </button>
      <output id="result">{output}</output>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        mode="work"
        threads={[...threads.values()]}
        messageSearch
        onOpenThread={(id, as) => setOutput(`${id}:${as}`)}
        fileRoots={[app, lib]}
        onOpenFile={(root, path, as) => setOutput(`${root}/${path}:${as}`)}
        modifierShortcuts
        commands={[
          {
            id: "expand",
            label: "Expand all Worked sections",
            group: "Actions",
            icon: SquarePen,
            run: () => setWorked({ open: true }),
          },
          {
            id: "collapse",
            label: "Collapse all Worked sections",
            group: "Actions",
            icon: SquarePen,
            run: () => setWorked({ open: false }),
          },
        ]}
      />
      <WorkedFixture id={work.id} />
      <WorkedFixture id={chat.id} />
      <ThreadTasks threadId={work.id} finished={finished} onOpenTask={(id) => setOutput(`task:${id}`)} />
      <section id="task-list">
        <TaskList
          selected={undefined}
          onSelect={(id) => setOutput(`select:${id}`)}
          onHandOff={(task) => setOutput(`handoff:${task.id}:${task.title}`)}
          project={project}
          onProjectChange={setProject}
          threads={threads}
          onOpenThread={(id) => setOutput(`thread:${id}`)}
        />
      </section>
      <section id="message">
        <MessageMenuArea
          text="Follow up on deploy"
          onAddTask={(text) =>
            setTasks((tasks) => addTask(tasks, taskFromMessage(text, work.id, app), 3, "message"))
          }
        >
          <p>Follow up on deploy</p>
        </MessageMenuArea>
      </section>
      <IssueViewer
        cwd={app}
        number={issue.number}
        onClose={() => undefined}
        onStartThread={() => undefined}
        onAddTask={(issue) => setTasks((tasks) => addTask(tasks, taskFromIssue(issue, app), 4, "issue"))}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <RegistryProvider
    defaultIdleTTL={60_000}
    initialValues={[
      [tasksAtom, store],
      [issueAtom(issueKey(app, issue.number)), AsyncResult.success(issue)],
      [threadSearchAtom(threadSearchKey("work", "needle")), AsyncResult.success([])],
      [threadSearchAtom(threadSearchKey("chat", "needle")), AsyncResult.success([passage])],
      [
        paletteFilesAtom(workspaceSearchKey(lib, "index")),
        AsyncResult.success([{ path: "src/index.ts", folder: false }]),
      ],
    ]}
  >
    <Fixture />
  </RegistryProvider>,
);
