import { Button } from "@base-ui/react/button";
import { mentionToken } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import type { OutgoingMessage } from "../composer/Composer.tsx";
import { isSendKey, sendKeyAtom } from "../settings/preferences.ts";
import type { UserBlock } from "./model.ts";

/**
 * One of the user's messages opened for editing in place: sending it takes the conversation back to
 * before it and goes on from the new text, with the message's attachments, and the mentions it
 * still names.
 */
export function MessageEditor({
  block,
  onSend,
  onCancel,
}: {
  block: UserBlock;
  /** Resolves whether the new version was sent. */
  onSend: (message: OutgoingMessage) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(block.text.trim());
  const [sending, setSending] = useState(false);
  const sendKey = useAtomValue(sendKeyAtom);
  const changed = text.trim() !== block.text.trim();
  const sendable = changed && (text.trim() !== "" || block.attachments.length > 0) && !sending;

  const send = async () => {
    if (!sendable) return;
    setSending(true);
    const sent = await onSend({
      text: text.trim(),
      attachments: block.attachments,
      mentions: block.mentions.filter((mention) => text.includes(mentionToken(mention))),
    });
    // Sent, the editor gives way to the new message; refused, the text stays to try again.
    if (!sent) setSending(false);
  };

  return (
    <div className="flex w-[36rem] max-w-full flex-col gap-2 rounded-2xl rounded-br-md border border-line-strong bg-surface-raised p-2 shadow-raised">
      <textarea
        // The editor opens where the user asked for it.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        aria-label="Edit message"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onFocus={(event) => event.currentTarget.setSelectionRange(text.length, text.length)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (isSendKey(event, sendKey)) {
            event.preventDefault();
            void send();
          }
        }}
        className="field-sizing-content max-h-80 min-h-12 w-full resize-none bg-transparent px-2 py-1 text-[14px] leading-relaxed text-fg-primary outline-none placeholder:text-fg-tertiary"
      />
      <div className="flex items-center gap-2 pl-2">
        <p className="min-w-0 flex-1 truncate text-2xs text-fg-tertiary">
          Later turns are kept as an earlier version
        </p>
        <Button
          onClick={onCancel}
          className="h-7 rounded-md px-2.5 text-[13px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          Cancel
        </Button>
        <Button
          onClick={() => void send()}
          disabled={!sendable}
          className="h-7 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:opacity-30"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
