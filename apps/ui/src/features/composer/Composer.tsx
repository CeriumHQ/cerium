import { Button } from "@base-ui/react/button";
import type { AccessMode, Attachment, Mention, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  ArrowUp,
  Eye,
  FilePen,
  Gauge,
  Paperclip,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Square,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import { saveAttachment } from "../../backend/files.ts";
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
import { AttachmentTray } from "./AttachmentTray.tsx";
import { isPreviewable, mediaTypeOf, prepareAttachment } from "./attachments.ts";
import {
  draftMentions,
  draftText,
  emptyDraft,
  type Draft,
  type DraftAttachment,
  type Trigger,
} from "./draft.ts";
import { MentionMenu, useMentionOptions } from "./MentionMenu.tsx";
import type { MessageBox } from "./messageBox.ts";
import { accessOptions, effortFor, effortLabel, modelKey, pickModel, useModels } from "./models.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor.tsx";

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  auto: ShieldCheck,
  fullAccess: ShieldOff,
};

const providers: ReadonlyArray<ProviderId> = ["claude", "codex", "muse", "cursor"];
const allProviders: ReadonlySet<ProviderId> = new Set(providers);

/** A message as the box sends it: its text, which names each mention by its token. */
export interface OutgoingMessage {
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly mentions: ReadonlyArray<Mention>;
}

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
      /** The thread's folder, which `@` tags files from; absent for chats. */
      readonly folder?: string | undefined;
      /** The lead stopped or failed. */
      /** The lead stopped or failed; the next message picks the thread back up. */
      readonly ended?: "stopped" | "failed";
    }
  /** The first message starts a thread with the chosen setup. */
  | {
      readonly kind: "new";
      readonly mode: "work" | "chat";
      /** Work threads need a folder before they can start. */
      readonly folder: string | undefined;
      readonly onChooseFolder: (folder: string) => void;
      /** Providers whose harness is installed and logged in. */
      readonly available: ReadonlySet<ProviderId>;
    };

interface ComposerProps {
  readonly target: ComposerTarget;
  /** Which draft the box shows: each thread, and each mode's new thread, keeps its own. */
  readonly draftKey: string;
  /** The message box, for callers that move focus to it. */
  readonly inputRef?: RefObject<HTMLDivElement | null>;
  /** Filled with what others can put into the box; null while it takes no messages. */
  readonly messageBox?: Ref<MessageBox | null>;
  /** A turn is in progress: the send button becomes stop. */
  readonly running: boolean;
  /** Resolves false when the message didn't go through, so the box can give the draft back. */
  readonly onSend: (message: OutgoingMessage, setup: ThreadSetup) => Promise<boolean>;
  readonly onStop: () => void;
  /** Shown just above the box, such as requests waiting on the user. */
  readonly above?: ReactNode;
  /** Reports how much taller attached files make the box, so the transcript's end stays in view. */
  readonly onAttachmentsHeight?: (height: number) => void;
}

/** The message box, floating over the bottom of the transcript. */
export function Composer({
  target,
  draftKey,
  inputRef,
  messageBox,
  running,
  onSend,
  onStop,
  above,
  onAttachmentsHeight,
}: ComposerProps) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  /** Bumped when the box itself replaces a draft (sent, or given back), so the editor shows it. */
  const [epoch, setEpoch] = useState(0);
  const ownRef = useRef<HTMLDivElement>(null);
  const input = inputRef ?? ownRef;
  const editor = useRef<PromptEditorHandle>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  /** The `@` or `$` tag being typed. */
  const [trigger, setTrigger] = useState<Trigger>();
  /** A tag whose list Esc closed; it stays closed until another tag starts. */
  const [dismissed, setDismissed] = useState<Trigger>();
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const save = useAtomSet(saveAttachment, { mode: "promise" });
  // New threads start with the model and effort the last one was given, which are also the defaults
  // in settings. Access always starts from the settings default; a pick here covers this thread only.
  const [modelId, setModelId] = useAtom(modelAtom);
  const [effort, setEffort] = useAtom(effortAtom);
  const defaultAccess = useAtomValue(accessAtom);
  const [accessPick, setAccess] = useState<AccessMode>();
  const access = accessPick ?? defaultAccess;
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
  const draft = drafts[draftKey] ?? emptyDraft;
  const text = draftText(draft.segments);
  const preparing = draft.attachments.some((attachment) => attachment.state._tag === "Preparing");
  const ready = draft.attachments.flatMap((attachment) =>
    attachment.state._tag === "Ready" ? [attachment.state.attachment] : [],
  );
  const canSend =
    (text.trim() !== "" || ready.length > 0) && !preparing && !needsFolder && (!isNew || model !== undefined);
  const recipient = target.kind === "thread" ? target.model : (model?.label ?? "an agent");

  // `@` tags files in the thread's folder; `$` the skills of the harness the message goes to.
  const sources = {
    folder: target.kind === "thread" ? target.folder : target.mode === "work" ? target.folder : undefined,
    provider: target.kind === "thread" ? target.provider : model?.provider,
    chat: target.kind === "thread" ? target.folder === undefined : target.mode === "chat",
  };
  const menuTrigger =
    trigger !== undefined && !(trigger.char === dismissed?.char && trigger.start === dismissed.start)
      ? trigger
      : undefined;
  const results = useMentionOptions(menuTrigger, sources);
  // A `$` that matches no skill is most likely just a dollar sign ("$5"), so its list stays shut.
  const menuOpen =
    menuTrigger !== undefined &&
    (menuTrigger.char === "@" || menuTrigger.query === "" || results.options.length > 0);
  const activeIndex = Math.min(active, Math.max(0, results.options.length - 1));

  // Opening a thread, or a new one, puts the cursor where the next message goes.
  useEffect(() => {
    input.current?.focus();
  }, [input, draftKey]);

  const updateDraft = (key: string, update: (current: Draft) => Draft) =>
    setDrafts((current) => ({ ...current, [key]: update(current[key] ?? emptyDraft) }));

  const setAttachment = (key: string, id: string, state: DraftAttachment["state"]) =>
    updateDraft(key, (current) => ({
      ...current,
      attachments: current.attachments.map((attachment) =>
        attachment.id === id ? { ...attachment, state } : attachment,
      ),
    }));

  /** Attaches pasted, dropped or picked files; each shows at once and is ready once it is on disk. */
  const addFiles = (files: ReadonlyArray<File>) => {
    const key = draftKey;
    for (const file of files) {
      const id = crypto.randomUUID();
      const preview = isPreviewable(file) ? URL.createObjectURL(file) : undefined;
      updateDraft(key, (current) => ({
        ...current,
        attachments: [
          ...current.attachments,
          {
            id,
            name: file.name || "Pasted image",
            mediaType: mediaTypeOf(file),
            ...(preview ? { preview } : {}),
            state: { _tag: "Preparing" },
          },
        ],
      }));
      prepareAttachment(file, (payload) => save({ payload })).then(
        (attachment) => setAttachment(key, id, { _tag: "Ready", attachment }),
        (error: unknown) =>
          setAttachment(key, id, {
            _tag: "Failed",
            message: error instanceof Error ? error.message : `${file.name} couldn't be attached.`,
          }),
      );
    }
  };

  const removeAttachment = (id: string) => {
    const removed = draft.attachments.find((attachment) => attachment.id === id);
    if (removed?.preview) URL.revokeObjectURL(removed.preview);
    updateDraft(draftKey, (current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) => attachment.id !== id),
    }));
  };

  const resumes = target.kind === "thread" && target.ended !== undefined;

  useImperativeHandle<MessageBox | null, MessageBox | null>(messageBox, () => ({
    mention: (mention) => editor.current?.mentionAtCaret(mention),
    append: ({ segments, attachments = [] }) => {
      const key = draftKey;
      updateDraft(key, (current) => {
        const attached = new Set(
          current.attachments.flatMap((attachment) =>
            attachment.state._tag === "Ready" ? [attachment.state.attachment.path] : [],
          ),
        );
        return {
          ...current,
          attachments: [
            ...current.attachments,
            ...attachments
              .filter((attachment) => !attached.has(attachment.path))
              .map((attachment): DraftAttachment => ({
                id: crypto.randomUUID(),
                name: attachment.name,
                mediaType: attachment.mediaType,
                state: { _tag: "Ready", attachment },
              })),
          ],
        };
      });
      editor.current?.append(segments);
    },
  }));

  const pick = (mention: Mention) => {
    editor.current?.insertMention(mention);
    setActive(0);
  };

  const send = () => {
    if (!canSend || model === undefined) return;
    const key = draftKey;
    const sent = draft;
    setDrafts((current) => ({ ...current, [key]: emptyDraft }));
    setEpoch((current) => current + 1);
    setTrigger(undefined);
    void onSend(
      { text: text.trim(), attachments: ready, mentions: draftMentions(draft.segments) },
      {
        provider: model.provider,
        model: model.id,
        ...(activeEffort ? { effort: activeEffort } : {}),
        access: isNew && target.mode === "chat" ? "readOnly" : access,
      },
    ).then((delivered) => {
      if (delivered) {
        for (const attachment of sent.attachments) {
          if (attachment.preview) URL.revokeObjectURL(attachment.preview);
        }
        // The next new thread starts from the default access again.
        if (isNew) setAccess(undefined);
        return;
      }
      // Give an undelivered message back, unless the user has started writing another.
      setDrafts((current) => {
        const now = current[key];
        return now && (now.segments.length > 0 || now.attachments.length > 0)
          ? current
          : { ...current, [key]: sent };
      });
      setEpoch((current) => current + 1);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = results.options.length;
    if (menuOpen && count > 0 && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((activeIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pick(results.options[activeIndex]!.mention);
        return;
      }
    }
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setDismissed(menuTrigger);
      return;
    }
    if (isSendKey(event, sendKey)) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && running) {
      event.preventDefault();
      onStop();
    }
  };

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] md:px-8 md:pb-5">
      {above}
      {/* The list sits beside the box, not in it: inside the box's own blur it couldn't blur what's behind. */}
      <div className="relative mx-auto max-w-[46.2rem]">
        {menuOpen ? (
          <MentionMenu
            trigger={menuTrigger}
            sources={sources}
            results={results}
            active={activeIndex}
            onActive={setActive}
            onPick={pick}
          />
        ) : null}
        <div
          onDragOver={(event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(event) => {
            setDragging(false);
            if (!hasFiles(event)) return;
            event.preventDefault();
            addFiles([...event.dataTransfer.files]);
          }}
          className={`pointer-events-auto rounded-2xl border bg-surface-raised backdrop-blur-2xl transition-colors ${
            dragging ? "border-accent" : "border-line-subtle focus-within:border-line-strong"
          }`}
        >
          {draft.attachments.length > 0 ? (
            <AttachmentTray
              attachments={draft.attachments}
              onRemove={removeAttachment}
              onHeight={onAttachmentsHeight}
            />
          ) : null}
          <PromptEditor
            ref={input}
            handle={editor}
            resetKey={`${draftKey}:${epoch}`}
            segments={draft.segments}
            placeholder={
              needsFolder
                ? "Choose a project to work in first"
                : resumes
                  ? `Message ${recipient} to pick this thread back up`
                  : isNew && target.mode === "chat"
                    ? `Ask ${recipient} anything`
                    : `Message ${recipient}`
            }
            onChange={(segments) => updateDraft(draftKey, (current) => ({ ...current, segments }))}
            onTrigger={(next) => {
              if (
                next?.char !== trigger?.char ||
                next?.start !== trigger?.start ||
                next?.query !== trigger?.query
              ) {
                setActive(0);
              }
              setTrigger(next);
            }}
            onKeyDown={onKeyDown}
            onFiles={addFiles}
            activeOption={
              menuOpen && results.options.length > 0 ? `mention-option-${activeIndex}` : undefined
            }
          />
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <div className="flex items-center gap-0.5 px-2 pb-2 max-md:flex-wrap max-md:gap-y-1">
            <IconButton icon={Paperclip} label="Attach files" onClick={() => filePicker.current?.click()} />

            {target.kind === "thread" ? (
              <span className="flex h-7 items-center gap-1.5 px-2 text-[12.5px]">
                <ProviderLogo provider={target.provider} size={13} />
                <span className="font-medium text-fg-primary">{target.model}</span>
              </span>
            ) : (
              <>
                {target.mode === "work" ? (
                  <ProjectPicker folder={target.folder} onChoose={target.onChooseFolder} />
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
    </div>
  );
}
