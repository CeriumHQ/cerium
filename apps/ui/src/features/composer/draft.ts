import { mentionToken, type Attachment, type Mention } from "@cerium/protocol";

// A message being written: its text with the files, folders and skills tagged inside it, and the
// files attached to it. Kept per thread, so switching threads keeps each one's draft.

export type Segment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly mention: Mention };

/** A file added to the draft, from the moment it is pasted until it is ready to send. */
export interface DraftAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  /** A local URL for an image's thumbnail. */
  readonly preview?: string;
  readonly state:
    | { readonly _tag: "Preparing" }
    | { readonly _tag: "Ready"; readonly attachment: Attachment }
    | { readonly _tag: "Failed"; readonly message: string };
}

export interface Draft {
  readonly segments: ReadonlyArray<Segment>;
  readonly attachments: ReadonlyArray<DraftAttachment>;
}

export const emptyDraft: Draft = { segments: [], attachments: [] };

/** The text agents read: each mention as its token. */
export const draftText = (segments: ReadonlyArray<Segment>): string =>
  segments
    .map((segment) => (segment.kind === "text" ? segment.text : mentionToken(segment.mention)))
    .join("");

/** Each mention once, in the order it first appears. */
export const draftMentions = (segments: ReadonlyArray<Segment>): ReadonlyArray<Mention> => {
  const seen = new Map<string, Mention>();
  for (const segment of segments) {
    if (segment.kind === "mention" && !seen.has(mentionToken(segment.mention))) {
      seen.set(mentionToken(segment.mention), segment.mention);
    }
  }
  return [...seen.values()];
};

/** Adjacent text segments merged, empty ones dropped. */
export const normalizeSegments = (segments: ReadonlyArray<Segment>): ReadonlyArray<Segment> =>
  segments.reduce<Array<Segment>>((merged, segment) => {
    if (segment.kind === "text" && segment.text === "") return merged;
    const last = merged.at(-1);
    if (segment.kind === "text" && last?.kind === "text") {
      merged[merged.length - 1] = { kind: "text", text: last.text + segment.text };
    } else {
      merged.push(segment);
    }
    return merged;
  }, []);

/** What is being typed after `@` or `$` right before the caret, if anything. */
export interface Trigger {
  readonly char: "@" | "$";
  readonly query: string;
  /** Where the trigger character sits in the text before the caret. */
  readonly start: number;
}

/**
 * The tag being typed at the end of `before` (the text from the start of the caret's text node to the
 * caret): `@` or `$` at the start or after whitespace, then anything but whitespace.
 */
export const triggerAt = (before: string): Trigger | undefined => {
  const match = /(^|\s)([@$])([^\s@$]*)$/.exec(before);
  if (match === null) return undefined;
  return {
    char: match[2] as "@" | "$",
    query: match[3]!,
    start: match.index + match[1]!.length,
  };
};
