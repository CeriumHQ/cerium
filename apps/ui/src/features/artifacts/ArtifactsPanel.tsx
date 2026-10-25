import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { LoaderCircle, Maximize2, RefreshCw, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { projectArtifactsAtom } from "../../backend/files.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { whenAgo } from "../../lib/time.ts";
import { ArtifactDialog, ArtifactThumbnail } from "../transcript/Artifact.tsx";
import { WorkspaceFolder } from "../transcript/FileChip.tsx";
import { projectArtifacts, type PanelArtifact } from "./model.ts";

type Scope = "thread" | "project";

const toggleClass =
  "rounded-md px-2 py-0.5 text-body font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[15px]";

/**
 * Every artifact of the open thread, or of its project's threads, beside the conversation: the
 * useful ones found again without scrolling back through long conversations.
 */
export function ArtifactsPanel({
  threadId,
  artifacts,
  project,
  threadTitle,
  folderOf,
  onShow,
  onReply,
  onClose,
}: {
  /** The open thread. */
  threadId: string;
  /** The open thread's artifacts, newest first. */
  artifacts: ReadonlyArray<PanelArtifact>;
  /** The open thread's project, when its machine can list a project's artifacts. */
  project: string | undefined;
  threadTitle: (threadId: string) => string | undefined;
  /** The folder a thread works in, which its artifacts' data files come from. */
  folderOf: (threadId: string) => string | undefined;
  /** Brings the artifact into view in its conversation, opening that first. */
  onShow: (artifact: PanelArtifact) => void;
  /** Puts an answer from one of the open thread's artifacts in its message box. */
  onReply: ((text: string) => void) | undefined;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>("thread");
  const shown: Scope = project === undefined ? "thread" : scope;
  const element = useRef<HTMLDivElement>(null);

  // Esc closes the panel while focus is inside it, unless something there used the key first.
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      element.current?.contains(document.activeElement)
    ) {
      onClose();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onEscape(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const list = (items: ReadonlyArray<PanelArtifact>) => (
    <ArtifactList
      artifacts={items}
      threadId={threadId}
      showThread={shown === "project"}
      threadTitle={threadTitle}
      folderOf={folderOf}
      onShow={onShow}
      onReply={onReply}
    />
  );

  return (
    <div ref={element} className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle pr-1.5 pl-2 max-md:h-12 max-md:pl-3">
        {project === undefined ? (
          <p className="px-2 text-body font-medium text-fg-primary max-md:text-[15px]">Artifacts</p>
        ) : (
          <ToggleGroup
            value={[shown]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "thread" || next === "project") setScope(next);
            }}
            aria-label="Artifacts of"
            className="flex items-center"
          >
            <Toggle value="thread" className={toggleClass}>
              Thread
              {artifacts.length > 0 ? (
                <span className="ml-1.5 text-fg-tertiary tabular-nums">{artifacts.length}</span>
              ) : null}
            </Toggle>
            <Toggle value="project" className={toggleClass}>
              Project
            </Toggle>
          </ToggleGroup>
        )}
        <div className="ml-auto flex items-center">
          {shown === "project" && project !== undefined ? <ProjectRefresh project={project} /> : null}
          <IconButton icon={X} label="Close" onClick={onClose} className="max-md:size-10" />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {shown === "project" && project !== undefined ? (
          <ProjectArtifacts
            project={project}
            threadId={threadId}
            threadCount={artifacts.length}
            render={list}
          />
        ) : artifacts.length === 0 ? (
          <Empty>Visuals the agents draw in this thread gather here.</Empty>
        ) : (
          list(artifacts)
        )}
      </div>
    </div>
  );
}

function ProjectRefresh({ project }: { project: string }) {
  const refresh = useAtomRefresh(projectArtifactsAtom(project));
  return <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} className="max-md:size-10" />;
}

/** The project's artifacts, read from the machine, and again as the open thread draws more. */
function ProjectArtifacts({
  project,
  threadId,
  threadCount,
  render,
}: {
  project: string;
  threadId: string;
  threadCount: number;
  render: (artifacts: ReadonlyArray<PanelArtifact>) => ReactNode;
}) {
  const atom = projectArtifactsAtom(project);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  // Opening another of the project's threads changes nothing in the list; its thread drawing more does.
  const counted = useRef({ threadId, threadCount });
  useEffect(() => {
    const before = counted.current;
    counted.current = { threadId, threadCount };
    if (before.threadId === threadId && threadCount > before.threadCount) refresh();
  }, [threadId, threadCount, refresh]);

  // What was listed stays while it's read again.
  const listed = Option.getOrUndefined(AsyncResult.value(result));
  if (listed !== undefined) {
    const artifacts = projectArtifacts(listed);
    return artifacts.length === 0 ? (
      <Empty>Visuals the agents draw in this project's threads gather here.</Empty>
    ) : (
      render(artifacts)
    );
  }
  if (AsyncResult.isFailure(result)) return <Empty>Couldn't list this project's artifacts.</Empty>;
  return (
    <div className="grid h-full place-items-center text-fg-tertiary">
      <LoaderCircle size={16} strokeWidth={1.75} className="animate-spin" aria-label="Loading" />
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="px-6 py-8 text-center text-body text-balance text-fg-tertiary max-md:text-[14px]">
      {children}
    </p>
  );
}

function ArtifactList({
  artifacts,
  threadId,
  showThread,
  threadTitle,
  folderOf,
  onShow,
  onReply,
}: {
  artifacts: ReadonlyArray<PanelArtifact>;
  threadId: string;
  showThread: boolean;
  threadTitle: (threadId: string) => string | undefined;
  folderOf: (threadId: string) => string | undefined;
  onShow: (artifact: PanelArtifact) => void;
  onReply: ((text: string) => void) | undefined;
}) {
  return (
    <ScrollArea className="h-full">
      <ul className="flex flex-col gap-1 p-1.5">
        {artifacts.map((artifact) => (
          <li key={`${artifact.threadId}:${artifact.id}`}>
            <WorkspaceFolder value={folderOf(artifact.threadId)}>
              <ArtifactCard
                artifact={artifact}
                thread={showThread ? threadTitle(artifact.threadId) : undefined}
                onShow={() => onShow(artifact)}
                // A page answers only into its own thread's message box.
                onReply={artifact.threadId === threadId ? onReply : undefined}
              />
            </WorkspaceFolder>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

function ArtifactCard({
  artifact,
  thread,
  onShow,
  onReply,
}: {
  artifact: PanelArtifact;
  /** The thread it's in, named when the list spans several. */
  thread: string | undefined;
  onShow: () => void;
  onReply: ((text: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = artifact.title ?? "Untitled";
  return (
    <div className="group/card relative rounded-lg transition-colors hover:bg-surface-hover">
      <Button
        onClick={onShow}
        aria-label={`Show ${title} in the conversation`}
        className="block w-full rounded-lg p-1.5 text-left"
      >
        <ArtifactThumbnail
          code={artifact.code}
          title={artifact.title}
          className="rounded-md border border-line-subtle"
        />
        <span className="mt-1.5 block truncate px-0.5 text-body font-medium text-fg-primary max-md:text-[14px]">
          {title}
        </span>
        <span className="block truncate px-0.5 text-meta text-fg-tertiary max-md:text-[13px]">
          {thread ? `${thread} · ` : ""}
          {whenAgo(artifact.at)}
        </span>
      </Button>
      <IconButton
        icon={Maximize2}
        label="Expand"
        onClick={() => setExpanded(true)}
        className="absolute top-3 right-3 bg-surface-overlay opacity-0 shadow-raised backdrop-blur-xl transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      />
      <ArtifactDialog
        code={artifact.code}
        title={artifact.title}
        open={expanded}
        onOpenChange={setExpanded}
        onReply={
          onReply
            ? (text) => {
                onReply(text);
                setExpanded(false);
              }
            : undefined
        }
      />
    </div>
  );
}
