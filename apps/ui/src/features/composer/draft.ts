import {
  mentionToken,
  type AccessMode,
  type Attachment,
  type Mention,
  type ReasoningEffort,
} from "@cerium/protocol";

// A message being written: its text with the files, folders and skills tagged inside it, and the
// files attached to it. Kept per thread, and per thread not started yet, in `drafts.ts`.

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

/** What a thread not started yet starts with, beyond the window's defaults for new threads. */
export interface DraftStart {
  readonly mode: "work" | "chat";
  /** When the user started writing it; drafts are listed newest first by this, so rows stay put. */
  readonly createdAt: number;
  /** The machine it starts on; none for this computer. */
  readonly machine?: string;
  /** The work thread's folder. */
  readonly folder?: string;
  /** Picks made in this draft's message box, which win over the defaults. */
  readonly model?: string;
  /**
   * Multi agent: the models (by `modelKey`) the first message starts a thread each with, side by
   * side, in place of `model`. Absent while the draft starts one thread.
   */
  readonly models?: ReadonlyArray<string>;
  readonly effort?: ReasoningEffort;
  /** Off when the user took this draft off Auto; absent, it starts on Auto while the effort router is on. */
  readonly autoEffort?: boolean;
  readonly access?: AccessMode;
  /** The thread runs in a git worktree of its own. */
  readonly worktree?: boolean;
}

export interface Draft {
  readonly segments: ReadonlyArray<Segment>;
  readonly attachments: ReadonlyArray<DraftAttachment>;
  /** Set for a thread not started yet. */
  readonly start?: DraftStart;
}

export const emptyDraft: Draft = { segments: [], attachments: [] };

/** Something the user wrote or attached, which a message could send. */
export const hasContent = (draft: Draft | undefined): draft is Draft =>
  draft !== undefined && (draftText(draft.segments).trim() !== "" || draft.attachments.length > 0);

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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A sent message's text back as segments: each mention's token becomes its chip again. */
export const segmentsOf = (text: string, mentions: ReadonlyArray<Mention>): ReadonlyArray<Segment> => {
  const byToken = new Map(mentions.map((mention) => [mentionToken(mention), mention]));
  if (byToken.size === 0) return normalizeSegments([{ kind: "text", text }]);
  // Longest first, so `@src/` isn't read as `@src` followed by a slash.
  const pattern = new RegExp(
    [...byToken.keys()]
      .toSorted((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  const segments: Array<Segment> = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    segments.push({ kind: "text", text: text.slice(from, match.index) });
    segments.push({ kind: "mention", mention: byToken.get(match[0])! });
    from = match.index + match[0].length;
  }
  segments.push({ kind: "text", text: text.slice(from) });
  return normalizeSegments(segments);
};

/** `added` after `segments`, starting on a line of its own when the draft already has text. */
export const appendSegments = (
  segments: ReadonlyArray<Segment>,
  added: ReadonlyArray<Segment>,
): ReadonlyArray<Segment> => {
  const text = draftText(segments);
  if (text.trim() === "") return normalizeSegments(added);
  if (text.endsWith("\n")) return normalizeSegments([...segments, ...added]);
  // Spaces at the end of the draft would otherwise end the line before the break.
  const last = segments.at(-1);
  const trimmed: ReadonlyArray<Segment> =
    last?.kind === "text"
      ? [...segments.slice(0, -1), { kind: "text", text: last.text.trimEnd() }]
      : segments;
  return normalizeSegments([...trimmed, { kind: "text", text: "\n" }, ...added]);
};

/**
 * `segments` without `text` at their end, and the line break before it, when they end with it: an
 * earlier answer the same source put there, which a new one replaces.
 */
export const withoutEnding = (segments: ReadonlyArray<Segment>, text: string): ReadonlyArray<Segment> => {
  const last = segments.at(-1);
  if (last?.kind !== "text" || text === "") return segments;
  const kept = last.text.trimEnd();
  if (!kept.endsWith(text)) return segments;
  const before = kept.slice(0, -text.length);
  // Only a whole line: the answer was put on one of its own.
  if (before !== "" && !before.endsWith("\n")) return segments;
  const rest = before.slice(0, -1);
  return normalizeSegments([
    ...segments.slice(0, -1),
    ...(rest === "" ? [] : [{ kind: "text" as const, text: rest }]),
  ]);
};

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
