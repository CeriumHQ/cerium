import { Button } from "@base-ui/react/button";

import { CeriumMark } from "../components/CeriumMark.tsx";

/**
 * Where a new thread starts, above the message box, which holds the project, model and the rest.
 * Only a chat says anything beyond the question, since its limits aren't on the box, and a machine
 * with no harness ready says what to do first.
 */
export function EmptyThread({
  mode,
  onSetUp,
}: {
  mode: "work" | "chat";
  /** No harness can run a thread yet: opens where one is set up. */
  onSetUp?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 pb-32 text-center">
      <CeriumMark size={36} className="text-fg-disabled" />
      <h1 className="text-[17px] font-medium tracking-tight text-fg-primary">
        {onSetUp
          ? "No harness is ready"
          : mode === "work"
            ? "What should we work on?"
            : "What would you like to know?"}
      </h1>
      {onSetUp ? (
        <>
          <p className="max-w-sm text-[13px] leading-relaxed text-fg-tertiary">
            Set up Claude, Codex, Cursor or OpenCode to start.
          </p>
          <Button
            onClick={onSetUp}
            className="mt-1 flex h-8 items-center rounded-lg bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80"
          >
            Set up a harness
          </Button>
        </>
      ) : mode === "chat" ? (
        <p className="max-w-sm text-[13px] leading-relaxed text-fg-tertiary">
          Chats read and search the web, and never change your files.
        </p>
      ) : null}
    </div>
  );
}
