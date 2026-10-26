import type { Attachment, Mention } from "@cerium/protocol";
import { createContext, useContext, useRef } from "react";

import type { DraftCommentFile, Segment } from "./draft.ts";

/**
 * What the rest of the window can put into the open thread's message box. Each call changes only
 * that thread's draft, then focuses the box so the user carries on writing.
 */
export interface MessageBox {
  /**
   * A chip for `mention` where the box's caret was when the user left it (the end of the draft when
   * there was none), spaced from the words around it.
   */
  mention(mention: Mention): void;
  /**
   * Text, chips and attachments after the draft, on a line of their own when the draft has text.
   * Attachments the draft already has aren't added twice. `replacing`, a line put there before that
   * the draft still ends with, is taken out first: an artifact's earlier answer, for one.
   */
  append(content: {
    readonly segments: ReadonlyArray<Segment>;
    readonly attachments?: ReadonlyArray<Attachment>;
    readonly replacing?: string | undefined;
  }): void;
  /**
   * A comment on a passage of the agent's response, or (`file`) on lines of a diff of its work,
   * listed above the draft's text and sent before it. Focus stays where it is, so the user can go
   * on to the next passage.
   */
  comment(content: { readonly quote: string; readonly text: string; readonly file?: DraftCommentFile }): void;
  /** The draft the box writes to: a thread's id, or a thread not started yet's key. */
  key(): string | undefined;
}

/** The open thread's message box; absent while there is none to write in (an ended thread's). */
export const MessageBoxContext = createContext<MessageBox | undefined>(undefined);

export const useMessageBox = () => useContext(MessageBoxContext);

/**
 * A ref for the composer to fill (its `messageBox` prop), and a `MessageBox` that reaches it, for
 * providing to the rest of the window.
 */
export const useMessageBoxHandle = () => {
  const ref = useRef<MessageBox>(null);
  const box: MessageBox = {
    mention: (mention) => ref.current?.mention(mention),
    append: (content) => ref.current?.append(content),
    comment: (content) => ref.current?.comment(content),
    key: () => ref.current?.key(),
  };
  return [ref, box] as const;
};
