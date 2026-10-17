import { Button } from "@base-ui/react/button";
import type { AccessMode, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  ArrowUp,
  CircleAlert,
  CircleStop,
  Eye,
  FilePen,
  FolderOpen,
  Gauge,
  Paperclip,
  ShieldOff,
  ShieldQuestion,
  Square,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";

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
import { accessAtom, effortAtom, isSendKey, modelAtom, sendKeyAtom } from "../settings/preferences.ts";
import { providerName } from "../threads/model.ts";
import { accessOptions, effortFor, effortLabel, modelKey, pickModel, useModels } from "./models.ts";

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  fullAccess: ShieldOff,
};

const providers: ReadonlyArray<ProviderId> = ["claude", "codex", "muse", "cursor"];
const allProviders: ReadonlySet<ProviderId> = new Set(providers);

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** What a new thread starts with. */
export interface ThreadSetup {
  readonly provider: ProviderId;
  readonly model: string;
  /** Absent for models the harness offers no effort setting for. */
  readonly effort?: ReasoningEffort;
  readonly access: AccessMode;
}

export type ComposerTarget =
  /** Messages go to an existing thread's lead. */
  | {
      readonly kind: "thread";
      readonly provider: ProviderId;
      readonly model: string;
      /** The lead stopped or failed. */
      readonly ended?: "stopped" | "failed";
      /** The ended lead's harness session can be resumed: the next message picks the thread back up. */
      readonly resumable?: boolean;
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
  /** Which draft the box shows: each thread, and each mode's new thread, keeps its own. */
  readonly draftKey: string;
  /** The message box, for callers that move focus to it. */
  readonly inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** A turn is in progress: the send button becomes stop. */
  readonly running: boolean;
  /** Resolves false when the message didn't go through, so the box can give the text back. */
  readonly onSend: (text: string, setup: ThreadSetup) => Promise<boolean>;
  readonly onStop: () => void;
  /** Shown just above the box, such as requests waiting on the user. */
  readonly above?: ReactNode;
}

/** The message box, floating over the bottom of the transcript. */
export function Composer({ target, draftKey, inputRef, running, onSend, onStop, above }: ComposerProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? ownRef;
  // New threads start with the model, effort and access the last one was given, which are also the
  // defaults in settings.
  const [modelId, setModelId] = useAtom(modelAtom);
  const [effort, setEffort] = useAtom(effortAtom);
  const [access, setAccess] = useAtom(accessAtom);
  const sendKey = useAtomValue(sendKeyAtom);
  const choose =
    <A extends string>(set: (value: A) => void) =>
    (value: A | null) => {
      if (value !== null) set(value);
    };

  const models = useModels();
  const model = pickModel(models, modelId, target.kind === "new" ? target.available : allProviders);
  // Keep the effort valid when switching to a model with fewer levels.
  const activeEffort = model ? effortFor(model, effort) : undefined;
  const AccessIcon = accessIcon[access];
  const isNew = target.kind === "new";
  const needsFolder = isNew && target.mode === "work" && target.folder === undefined;
  const text = drafts[draftKey] ?? "";
  const canSend = text.trim() !== "" && !needsFolder && (!isNew || model !== undefined);
  const recipient = target.kind === "thread" ? target.model : (model?.label ?? "an agent");

  // Opening a thread, or a new one, puts the cursor where the next message goes.
  useEffect(() => {
    input.current?.focus();
  }, [input, draftKey]);

  const setText = (value: string) => setDrafts((current) => ({ ...current, [draftKey]: value }));
  const send = () => {
    if (!canSend || model === undefined) return;
    const key = draftKey;
    const sent = text.trim();
    setText("");
    void onSend(sent, {
      provider: model.provider,
      model: model.id,
      ...(activeEffort ? { effort: activeEffort } : {}),
      access: isNew && target.mode === "chat" ? "readOnly" : access,
    }).then((delivered) => {
      // Give an undelivered message back, unless the user has started typing another.
      if (!delivered) setDrafts((current) => (current[key] ? current : { ...current, [key]: sent }));
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSendKey(event, sendKey)) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && running) {
      event.preventDefault();
      onStop();
    }
  };

  const resumes = target.kind === "thread" && target.ended !== undefined && target.resumable === true;

  if (target.kind === "thread" && target.ended && !resumes) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-8 pb-5">
        {above}
        <div className="pointer-events-auto mx-auto flex max-w-[42rem] items-center gap-2.5 rounded-2xl border border-line-subtle bg-surface-raised py-2 pr-2 pl-4 backdrop-blur-2xl">
          {target.ended === "failed" ? (
            <CircleAlert size={14} strokeWidth={1.75} className="shrink-0 text-error" />
          ) : (
            <CircleStop size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
          )}
          <p className="min-w-0 flex-1 text-[13px] text-fg-secondary">
            <span className="font-medium text-fg-primary">{target.model}</span>{" "}
            {target.ended === "failed" ? "failed" : "stopped"} before its session started, so there is nothing
            to resume.
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
      {above}
      <div className="pointer-events-auto mx-auto max-w-[42rem] rounded-2xl border border-line-subtle bg-surface-raised backdrop-blur-2xl transition-colors focus-within:border-line-strong">
        <textarea
          ref={input}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            needsFolder
              ? "Choose a folder to work in first"
              : resumes
                ? `Message ${recipient} to pick this thread back up`
                : isNew && target.mode === "chat"
                  ? `Ask ${recipient} anything`
                  : `Message ${recipient}`
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

              <SelectRoot value={model ? modelKey(model) : null} onValueChange={choose(setModelId)}>
                <SelectTrigger label="Model">
                  {model ? (
                    <>
                      <ProviderLogo provider={model.provider} size={13} />
                      <span className="font-medium text-fg-primary">{model.label}</span>
                    </>
                  ) : (
                    <span className="text-fg-tertiary">Finding models…</span>
                  )}
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
                      {models
                        .filter((option) => option.provider === provider)
                        .map((option) => (
                          <SelectItem
                            key={option.id}
                            value={modelKey(option)}
                            disabled={!target.available.has(provider)}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ))}
                </SelectPopup>
              </SelectRoot>

              {model && activeEffort ? (
                <SelectRoot value={activeEffort} onValueChange={choose<ReasoningEffort>(setEffort)}>
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
              ) : null}

              {target.mode === "work" ? (
                <SelectRoot value={access} onValueChange={choose<AccessMode>(setAccess)}>
                  <SelectTrigger label="Access">
                    <AccessIcon size={13} strokeWidth={1.75} />
                    {accessOptions.find((option) => option.value === access)?.label}
                  </SelectTrigger>
                  <SelectPopup>
                    {accessOptions.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        icon={accessIcon[option.value]}
                        description={option.description}
                      >
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
              <Tooltip label="Send" shortcut={sendKey === "enter" ? "Enter" : "Ctrl Enter"}>
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
