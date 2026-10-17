import { Button } from "@base-ui/react/button";
import type { AccessMode, ProviderId, ReasoningEffort } from "@cerium/protocol";
import {
  ArrowUp,
  CircleAlert,
  CircleStop,
  Eye,
  FilePen,
  FolderOpen,
  Gauge,
  Paperclip,
  ShieldQuestion,
  Square,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import {
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
} from "../../components/ui/Select.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { providerName } from "../threads/model.ts";
import { accessOptions, effortLabel, modelOptions } from "./models.ts";

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
};

const providers: ReadonlyArray<ProviderId> = ["claude", "codex", "muse", "cursor"];

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** What a new thread starts with. */
export interface ThreadSetup {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: ReasoningEffort;
  readonly access: AccessMode;
}

export type ComposerTarget =
  /** Messages go to an existing thread's lead. */
  | {
      readonly kind: "thread";
      readonly provider: ProviderId;
      readonly model: string;
      /** The lead stopped or failed: Cerium can't resume it yet, so the thread takes no more messages. */
      readonly ended?: "stopped" | "failed";
      readonly onStartNew: () => void;
    }
  /** The first message starts a thread with the chosen setup. */
  | {
      readonly kind: "new";
      readonly mode: "work" | "chat";
      /** Work threads need a folder before they can start. */
      readonly folder: string | undefined;
      readonly onPickFolder: () => void;
      /** Providers whose harness is installed and logged in. */
      readonly available: ReadonlySet<ProviderId>;
    };

interface ComposerProps {
  readonly target: ComposerTarget;
  /** A turn is in progress: the send button becomes stop. */
  readonly running: boolean;
  readonly onSend: (text: string, setup: ThreadSetup) => void;
  readonly onStop: () => void;
}

/** The message box, floating over the bottom of the transcript. */
export function Composer({ target, running, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const [modelId, setModelId] = useState(modelOptions[0]!.id);
  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [access, setAccess] = useState<AccessMode>("ask");

  const model = modelOptions.find((option) => option.id === modelId) ?? modelOptions[0]!;
  // Keep the effort valid when switching to a model with fewer levels.
  const activeEffort = model.efforts.includes(effort) ? effort : model.efforts.at(-1)!;
  const AccessIcon = accessIcon[access];
  const isNew = target.kind === "new";
  const needsFolder = isNew && target.mode === "work" && target.folder === undefined;
  const canSend = text.trim() !== "" && !needsFolder;
  const recipient = target.kind === "thread" ? target.model : model.label;

  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), {
      provider: model.provider,
      model: model.id,
      effort: activeEffort,
      access: isNew && target.mode === "chat" ? "readOnly" : access,
    });
    setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  if (target.kind === "thread" && target.ended) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-8 pb-5">
        <div className="pointer-events-auto mx-auto flex max-w-[42rem] items-center gap-2.5 rounded-2xl border border-line-subtle bg-surface-raised py-2 pr-2 pl-4 backdrop-blur-2xl">
          {target.ended === "failed" ? (
            <CircleAlert size={14} strokeWidth={1.75} className="shrink-0 text-error" />
          ) : (
            <CircleStop size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
          )}
          <p className="min-w-0 flex-1 text-[13px] text-fg-secondary">
            <span className="font-medium text-fg-primary">{target.model}</span>{" "}
            {target.ended === "failed" ? "failed" : "has stopped"}, and Cerium can't resume a thread yet.
          </p>
          <Button
            onClick={target.onStartNew}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80"
          >
            <SquarePen size={13} strokeWidth={2} />
            Start a new one
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-8 pb-5">
      <div className="pointer-events-auto mx-auto max-w-[42rem] rounded-2xl border border-line-subtle bg-surface-raised backdrop-blur-2xl transition-colors focus-within:border-line-strong">
        <textarea
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            needsFolder
              ? "Choose a folder to work in first"
              : `Message ${recipient}, or @ to mention an agent or file`
          }
          aria-label="Message"
          className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] leading-[1.6] text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <IconButton icon={Paperclip} label="Attach files" />

          {target.kind === "thread" ? (
            <span className="flex h-7 items-center gap-1.5 px-2 text-[12.5px]">
              <ProviderLogo provider={target.provider} size={13} />
              <span className="font-medium text-fg-primary">{target.model}</span>
            </span>
          ) : (
            <>
              {target.mode === "work" ? (
                <Tooltip label={target.folder ?? "Choose the folder agents work in"}>
                  <Button
                    onClick={target.onPickFolder}
                    className={`flex h-7 max-w-44 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors hover:bg-surface-hover ${
                      target.folder ? "text-fg-primary" : "text-attention"
                    }`}
                  >
                    <FolderOpen size={13} strokeWidth={1.75} className="shrink-0" />
                    <span className="truncate font-medium">
                      {target.folder ? baseName(target.folder) : "Choose folder"}
                    </span>
                  </Button>
                </Tooltip>
              ) : null}

              <SelectRoot value={model.id} onValueChange={(value) => value && setModelId(value)}>
                <SelectTrigger label="Model">
                  <ProviderLogo provider={model.provider} size={13} />
                  <span className="font-medium text-fg-primary">{model.label}</span>
                </SelectTrigger>
                <SelectPopup>
                  {providers.map((provider, index) => (
                    <SelectGroup key={provider}>
                      {index > 0 ? <SelectSeparator /> : null}
                      <SelectGroupLabel>
                        <ProviderLogo
                          provider={provider}
                          size={11}
                          {...(target.available.has(provider) ? {} : { className: "opacity-35 grayscale" })}
                        />
                        {providerName[provider]}
                        {target.available.has(provider) ? null : (
                          <span className="ml-auto font-normal text-fg-disabled">Unavailable</span>
                        )}
                      </SelectGroupLabel>
                      {modelOptions
                        .filter((option) => option.provider === provider)
                        .map((option) => (
                          <SelectItem
                            key={option.id}
                            value={option.id}
                            disabled={!target.available.has(provider)}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ))}
                </SelectPopup>
              </SelectRoot>

              <SelectRoot
                value={activeEffort}
                onValueChange={(value) => value && setEffort(value as ReasoningEffort)}
              >
                <SelectTrigger label="Reasoning effort">
                  <Gauge size={13} strokeWidth={1.75} />
                  {effortLabel[activeEffort]}
                </SelectTrigger>
                <SelectPopup>
                  {model.efforts.map((level) => (
                    <SelectItem key={level} value={level}>
                      {effortLabel[level]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </SelectRoot>

              {target.mode === "work" ? (
                <SelectRoot value={access} onValueChange={(value) => value && setAccess(value as AccessMode)}>
                  <SelectTrigger label="Access">
                    <AccessIcon size={13} strokeWidth={1.75} />
                    {accessOptions.find((option) => option.value === access)?.label}
                  </SelectTrigger>
                  <SelectPopup>
                    {accessOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value} description={option.description}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </SelectRoot>
              ) : null}
            </>
          )}

          <div className="ml-auto">
            {running ? (
              <Tooltip label="Stop" shortcut="Esc">
                <Button
                  onClick={onStop}
                  aria-label="Stop"
                  className="grid size-8 place-items-center rounded-full bg-surface-active text-fg-primary transition-colors hover:bg-line-strong"
                >
                  <Square size={12} fill="currentColor" />
                </Button>
              </Tooltip>
            ) : (
              <Tooltip label="Send" shortcut="Enter">
                <Button
                  onClick={send}
                  disabled={!canSend}
                  aria-label="Send"
                  className="grid size-8 place-items-center rounded-full bg-accent text-accent-fg transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:opacity-30"
                >
                  <ArrowUp size={16} strokeWidth={2.25} />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
