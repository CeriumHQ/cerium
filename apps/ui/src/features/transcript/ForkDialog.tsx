import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { OFFERED_PROVIDERS, type ModelInfo } from "@cerium/protocol";
import { MessagesSquare } from "lucide-react";
import { useState } from "react";

import { Button, buttonClass } from "../../components/ui/Button.tsx";
import { dialogBackdropClass, dialogPopupClass, dialogTitleClass } from "../../components/ui/FormDialog.tsx";
import { modelKey, useModels } from "../composer/models.ts";
import { ModelPicker } from "../composer/ModelPicker.tsx";
import { pathTail } from "../git/workspace.ts";
import {
  forkFailure,
  harnessLine,
  workspaceOffers,
  type ForkActions,
  type ForkCheck,
  type ForkFailure,
  type ForkWorkspace,
} from "./fork.ts";

const row =
  "group flex w-full cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors select-none hover:bg-surface-hover focus-visible:bg-surface-hover data-checked:bg-surface-selected data-disabled:opacity-40 data-disabled:hover:bg-transparent max-md:py-2.5";

const mark =
  "mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong transition-colors group-data-checked:border-accent group-data-checked:bg-accent group-focus-visible:border-fg-secondary";

function Heading({ children }: { children: string }) {
  return <h3 className="text-caption font-medium text-fg-tertiary select-none">{children}</h3>;
}

/**
 * Asks where a fork of the thread works and what runs it, from one of the user's messages. The
 * workspace choices say why when they can't be picked, and a fork that fails says what to try.
 */
export function ForkDialog({
  open,
  onOpenChange,
  message,
  actions,
  check,
  onFork,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The text of the message the fork starts from. */
  message: string;
  actions: ForkActions;
  check: ForkCheck;
  /** Forks; rejects with the reason it couldn't. Opens the sibling once it has. */
  onFork: (choice: {
    readonly workspace?: ForkWorkspace;
    readonly harness?: ModelInfo["provider"];
    readonly model?: string;
  }) => Promise<void>;
}) {
  const models = useModels();
  const [workspace, setWorkspace] = useState<ForkWorkspace>("current");
  const [picked, setPicked] = useState<ModelInfo>();
  const [forking, setForking] = useState(false);
  const [failure, setFailure] = useState<ForkFailure>();
  const offers = workspaceOffers(actions, check);
  const hasFolder = actions.folder !== undefined;
  // A choice that stopped being possible falls back to the one that is.
  const chosen: ForkWorkspace = offers[workspace].available ? workspace : "current";

  const own = models.find((model) => model.provider === actions.provider && model.id === actions.model);
  const target = picked ?? own;
  const provider = target?.provider ?? actions.provider;
  const shown = target
    ? { provider: target.provider, label: target.label, key: modelKey(target) }
    : { provider: actions.provider, label: actions.model };
  const switched = picked !== undefined && (provider !== actions.provider || picked.id !== actions.model);
  const crossing = harnessLine(actions.provider, provider);

  const fork = () => {
    setForking(true);
    setFailure(undefined);
    const choice = {
      ...(hasFolder ? { workspace: chosen } : {}),
      ...(switched && picked
        ? { model: picked.id, ...(picked.provider === actions.provider ? {} : { harness: picked.provider }) }
        : {}),
    };
    onFork(choice).then(
      () => {
        setForking(false);
        onOpenChange(false);
      },
      (error: unknown) => {
        setForking(false);
        setFailure(forkFailure(error, hasFolder ? chosen : undefined));
      },
    );
  };

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (forking) return;
        onOpenChange(next);
        // The next time starts from this thread's own setup, with nothing said about the last.
        if (!next) {
          setFailure(undefined);
          setPicked(undefined);
          setWorkspace("current");
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={dialogBackdropClass} />
        <AlertDialog.Popup className={`${dialogPopupClass("md")} flex flex-col gap-4`}>
          <div className="flex flex-col gap-2">
            <AlertDialog.Title className={dialogTitleClass}>Fork into new thread</AlertDialog.Title>
            <AlertDialog.Description className="line-clamp-2 border-l-2 border-line-strong pl-2.5 text-body leading-relaxed text-fg-secondary">
              {message.trim() === "" ? "(attachments only)" : message}
            </AlertDialog.Description>
            <p className="text-meta text-fg-tertiary">
              The new thread carries the conversation through this message and its reply. This one stays as it
              is.
            </p>
          </div>

          {hasFolder ? (
            <div className="flex flex-col gap-1">
              <Heading>Where it works</Heading>
              <RadioGroup
                aria-label="Where the new thread works"
                value={chosen}
                onValueChange={(value) => {
                  if (value === "current" || value === "worktree") setWorkspace(value);
                }}
                className="-mx-1 flex flex-col"
              >
                <Radio.Root value="current" disabled={!offers.current.available} className={row}>
                  <span className={mark}>
                    <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg data-unchecked:hidden" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-medium text-fg-primary">This workspace</span>
                    <span className="truncate text-meta text-fg-tertiary" title={actions.folder}>
                      Uses the current files in {pathTail(actions.folder ?? "")}
                    </span>
                  </span>
                </Radio.Root>
                <Radio.Root value="worktree" disabled={!offers.worktree.available} className={row}>
                  <span className={mark}>
                    <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg data-unchecked:hidden" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-medium text-fg-primary">New worktree</span>
                    <span className="text-meta text-fg-tertiary">
                      {offers.worktree.available
                        ? "A branch of its own, from the files after this turn"
                        : (offers.worktree.reason ?? "Not available for this message")}
                    </span>
                  </span>
                </Radio.Root>
              </RadioGroup>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Heading>Runs on</Heading>
            <div className="flex items-center gap-2">
              <ModelPicker
                models={models}
                shown={shown}
                providers={OFFERED_PROVIDERS}
                available={new Set([actions.provider, ...actions.available])}
                onPick={setPicked}
              />
              {switched ? null : (
                <span className="min-w-0 truncate text-meta text-fg-tertiary">Same as this thread</span>
              )}
            </div>
            {crossing ? (
              <p className="flex items-start gap-2 text-meta leading-snug text-fg-secondary">
                <MessagesSquare size={13} strokeWidth={1.75} className="mt-[2px] shrink-0 text-fg-tertiary" />
                <span>{crossing}</span>
              </p>
            ) : null}
          </div>

          {failure ? (
            <div role="alert" className="flex flex-col items-start gap-1.5 text-body text-error-text">
              <p>{failure.message}</p>
              {failure.worktree && offers.current.available ? (
                <button
                  type="button"
                  onClick={() => {
                    setWorkspace("current");
                    setFailure(undefined);
                  }}
                  className="text-meta font-medium text-fg-primary underline decoration-line-strong underline-offset-2 hover:decoration-fg-secondary"
                >
                  Fork in this workspace instead
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <AlertDialog.Close disabled={forking} className={buttonClass()}>
              Cancel
            </AlertDialog.Close>
            <Button
              tone="primary"
              disabled={forking || (!target && actions.available.size === 0)}
              onClick={fork}
            >
              {forking ? "Forking…" : failure ? "Try again" : "Fork"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
