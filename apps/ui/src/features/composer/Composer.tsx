import { Button } from "@base-ui/react/button";
import type { AccessMode, ProviderId, ReasoningEffort } from "@cerium/protocol";
import {
  ArrowUp,
  Eye,
  FilePen,
  Gauge,
  Paperclip,
  ShieldQuestion,
  Square,
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

interface ComposerProps {
  /** A turn is in progress: the send button becomes stop. */
  readonly running: boolean;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
}

/** The message box, floating over the bottom of the transcript. */
export function Composer({ running, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const [modelId, setModelId] = useState(modelOptions[0]!.id);
  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [access, setAccess] = useState<AccessMode>("ask");

  const model = modelOptions.find((option) => option.id === modelId) ?? modelOptions[0]!;
  // Keep the effort valid when switching to a model with fewer levels.
  const activeEffort = model.efforts.includes(effort) ? effort : model.efforts.at(-1)!;
  const AccessIcon = accessIcon[access];
  const canSend = text.trim() !== "";

  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-8 pb-5">
      <div className="pointer-events-auto mx-auto max-w-[42rem] rounded-2xl border border-line-subtle bg-surface-raised backdrop-blur-2xl transition-colors focus-within:border-line-strong">
        <textarea
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${model.label}, or @ to mention an agent or file`}
          aria-label="Message"
          className="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] leading-[1.6] text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <IconButton icon={Paperclip} label="Attach files" />

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
                    <ProviderLogo provider={provider} size={11} />
                    {providerName[provider]}
                  </SelectGroupLabel>
                  {modelOptions
                    .filter((option) => option.provider === provider)
                    .map((option) => (
                      <SelectItem key={option.id} value={option.id}>
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
