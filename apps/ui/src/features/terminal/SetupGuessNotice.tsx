import { Button } from "@base-ui/react/button";
import type { ThreadInfo } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Terminal, X } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { projectScriptsAtom, runProjectScript, setProjectScripts } from "../../backend/scripts.ts";
import { terminalsAtom } from "../../backend/terminals.ts";
import { Reveal } from "../../components/Reveal.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { remember, stored } from "../../lib/storage.ts";
import { scriptTerminalOf } from "./model.ts";
import { fittedSize } from "./session.ts";

// A new worktree's setup that Cerium only guessed (from the project's package manager) never runs by
// itself. The thread asks above its message box instead: run it once, run it and keep it as the
// project's setup, or leave it. The lead was told the same, so it knows the user was asked.

/** Where a thread remembers it was answered, so the question isn't asked twice. */
const answeredKey = (threadId: string) => `cerium.setupGuess.${threadId}`;

const base = "h-7 rounded-md px-2.5 text-meta transition-colors max-md:h-9 max-md:px-3.5 max-md:text-[13px]";
const primary = `${base} bg-accent font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 disabled:pointer-events-none disabled:opacity-40`;
const outlined = `${base} border border-line-strong font-medium text-fg-primary hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-40`;

/**
 * Above the message box of a work thread in a worktree whose project's setup is a guess nobody has
 * confirmed: the command, and Run or Always for this project.
 */
export function SetupGuessNotice({
  thread,
  attempt,
}: {
  thread: ThreadInfo;
  /** Runs a backend action, reporting a failure; resolves whether it worked. */
  attempt: (action: Promise<unknown>) => Promise<boolean>;
}) {
  const project = thread.worktree?.project;
  // Only a worktree is set up as it is made, and an archived thread's is gone.
  if (project === undefined || thread.archivedAt !== undefined) return null;
  return <GuessedSetup key={thread.id} threadId={thread.id} project={project} attempt={attempt} />;
}

function GuessedSetup({
  threadId,
  project,
  attempt,
}: {
  threadId: ThreadInfo["id"];
  project: string;
  attempt: (action: Promise<unknown>) => Promise<boolean>;
}) {
  const resolved = useAtomValue(projectScriptsAtom(project));
  const refreshResolved = useAtomRefresh(projectScriptsAtom(project));
  const terminals = AsyncResult.getOrElse(useAtomValue(terminalsAtom), () => []);
  const run = useAtomSet(runProjectScript, { mode: "promise" });
  const save = useAtomSet(setProjectScripts, { mode: "promise" });
  const [answered, setAnswered] = useState(() => stored(answeredKey(threadId)) !== undefined);
  const [busy, setBusy] = useState(false);

  const setup = AsyncResult.isSuccess(resolved) ? resolved.value.setup : undefined;
  // Setup already ran here, from the titlebar or an earlier answer: there's nothing left to ask.
  const ran = scriptTerminalOf(terminals, { threadId }, "setup") !== undefined;
  const guess = setup?.from === "guessed" && !answered && !ran ? setup.text : undefined;

  const answer = () => {
    remember(answeredKey(threadId), "answered");
    setAnswered(true);
    refreshResolved();
  };
  const start = () => run({ payload: { threadId, kind: "setup", size: fittedSize() } });
  const choose = async (always: boolean) => {
    if (busy || guess === undefined) return;
    setBusy(true);
    // The command is saved as the project's own first, so it runs for every thread there after this one.
    const worked =
      (!always || (await attempt(save({ payload: { path: project, setup: guess } })))) &&
      (await attempt(start()));
    setBusy(false);
    if (worked) answer();
  };

  return (
    <Reveal>
      {guess === undefined ? null : (
        <div className="mx-auto mb-2 max-w-[46.2rem]">
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-line-subtle bg-surface-raised py-2 pr-2 pl-3 shadow-raised max-md:flex-wrap">
            <Terminal size={15} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
            <div className="flex min-w-0 flex-1 flex-col max-md:basis-full">
              <span className="text-caption text-fg-tertiary max-md:text-[12px]">
                Cerium guesses this project's setup. A guess never runs by itself.
              </span>
              <code className="truncate font-mono text-meta text-fg-primary max-md:text-[13px]">{guess}</code>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button disabled={busy} onClick={() => void choose(false)} className={primary}>
                Run
              </Button>
              <Button disabled={busy} onClick={() => void choose(true)} className={outlined}>
                Always for this project
              </Button>
              <IconButton icon={X} label="Not now" onClick={answer} />
            </div>
          </div>
        </div>
      )}
    </Reveal>
  );
}
