import type { CatalogEntry } from "@cerium/orchestrator";
import type { ProviderId } from "@cerium/protocol";
import type { DiffHunk, ReviewerModel, ReviewFinding, ReviewLine } from "@cerium/rpc";
import { Option, Schema } from "effect";

import { parseDiff } from "./files.ts";

// What a cross-harness review reads and answers, kept apart from git and the orchestrator: a diff split
// into its files, told to the reviewer with each line's number so its findings can name lines, and the
// reviewer's answer read back into findings on those lines.

/** A file of a diff, with its hunks. */
export interface DiffFile {
  /** Relative to the repository's top, with forward slashes: the new path, or the old for a deleted file. */
  readonly path: string;
  readonly hunks: ReadonlyArray<DiffHunk>;
  readonly binary: boolean;
}

/** The path a `--- a/x` or `+++ b/x` line names; none for `/dev/null`. */
const sidePath = (line: string): string | undefined => {
  const name = line.slice(4).replace(/\t.*$/, "").trim();
  if (name === "/dev/null") return undefined;
  return name.replace(/^"(.*)"$/, "$1").replace(/^[ab]\//, "");
};

/** The files of git's unified diff of several files, in its order. */
export const splitFiles = (patch: string): ReadonlyArray<DiffFile> => {
  const chunks: Array<Array<string>> = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") || chunks.length === 0) chunks.push([]);
    chunks.at(-1)!.push(line);
  }
  return chunks.flatMap((lines): ReadonlyArray<DiffFile> => {
    const header = lines[0] ?? "";
    let path: string | undefined;
    const plus = lines.find((line) => line.startsWith("+++ "));
    const minus = lines.find((line) => line.startsWith("--- "));
    path = (plus && sidePath(plus)) ?? (minus && sidePath(minus));
    if (path === undefined) {
      const named = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
      path = named?.[2];
    }
    if (path === undefined) return [];
    const { hunks, binary } = parseDiff(lines.join("\n"));
    return [{ path, hunks, binary }];
  });
};

/** A whole new file as a diff that adds every line, for files git doesn't track yet. */
export const addedFile = (path: string, text: string): DiffFile => {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  return {
    path,
    binary: false,
    hunks: [
      { oldStart: 0, newStart: 1, lines: lines.map((line) => ({ kind: "added" as const, text: line })) },
    ],
  };
};

/** Each line of a hunk with the number it goes by: the new side's, or the old side's for a removed line. */
export const numberedLines = (hunk: DiffHunk): ReadonlyArray<ReviewLine> => {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((line) => {
    if (line.kind === "removed") return { marker: "-", text: line.text, number: oldLine++ };
    const numbered: ReviewLine = {
      marker: line.kind === "added" ? "+" : " ",
      text: line.text,
      number: newLine++,
    };
    if (line.kind === "context") oldLine++;
    return numbered;
  });
};

/** How much of the diff a review's prompt carries. */
export const PROMPT_DIFF_LIMIT = 80_000;

/**
 * The diff as the reviewer reads it: each file under its path, each line with its marker and number,
 * removed lines' numbers marked `old`. Files past `limit` are named, not shown.
 */
export const numberedDiff = (
  files: ReadonlyArray<DiffFile>,
  limit = PROMPT_DIFF_LIMIT,
): { readonly text: string; readonly left: ReadonlyArray<string> } => {
  const parts: Array<string> = [];
  const left: Array<string> = [];
  let size = 0;
  for (const file of files) {
    const body = file.binary
      ? ["(not text)"]
      : file.hunks.flatMap((hunk) => [
          "@@",
          ...numberedLines(hunk).map((line) =>
            line.marker === "-"
              ? `- old ${line.number}: ${line.text}`
              : `${line.marker} ${line.number}: ${line.text}`,
          ),
        ]);
    const part = [`### ${file.path}`, ...body].join("\n");
    if (size + part.length > limit && parts.length > 0) {
      left.push(file.path);
      continue;
    }
    parts.push(part.length > limit ? `${part.slice(0, limit)}\n(cut short)` : part);
    size += part.length;
  }
  return { text: parts.join("\n\n"), left };
};

/** What the reviewer is told with its turn: what it reviews, the diff, and the form of its answer. */
export const reviewPrompt = (input: {
  readonly label: string;
  readonly author: string | undefined;
  readonly files: ReadonlyArray<DiffFile>;
}): string => {
  const { text, left } = numberedDiff(input.files);
  return [
    `Review this diff: ${input.label}.` +
      (input.author === undefined
        ? ""
        : ` It was written by ${input.author}, a model from another provider.`),
    "Look for what would hurt once it ships: bugs and wrong behaviour, edge cases it misses, broken error" +
      " handling, races, security problems, data loss, and changes that break their callers. Read the files" +
      " around the changes when you need their context. Skip style and formatting a linter would catch, and" +
      " praise. Few findings you are sure of beat many you aren't; none is a fine answer.",
    "Each diff line below starts with its marker (`+` added, `-` removed, ` ` unchanged) and its line number:" +
      " the new file's for added and unchanged lines, and the old file's, written `old N`, for removed ones.",
    "",
    text,
    ...(left.length > 0
      ? ["", `Too long to show here, read them yourself if they matter: ${left.join(", ")}`]
      : []),
    "",
    "End your turn with your review as one JSON object and nothing after it, in this form:",
    "```json",
    '{"summary": "one or two sentences on the change as a whole",',
    ' "findings": [{"path": "src/file.ts", "line": 12, "endLine": 14, "side": "new",',
    '   "severity": "high", "title": "what is wrong, in a line", "body": "why it matters and what to do"}]}',
    "```",
    "`path` is a file of the diff as written above. `line` and `endLine` (the same as `line` for one line)" +
      " are the numbers shown beside the lines the finding is about; `side` is `old` only for removed lines." +
      " `severity` is `high` (a bug or a risk to ship), `medium` (should be fixed) or `low` (worth a look).",
  ].join("\n");
};

const Answer = Schema.Struct({
  summary: Schema.optional(Schema.String),
  findings: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        line: Schema.optional(Schema.Finite),
        endLine: Schema.optional(Schema.NullOr(Schema.Finite)),
        side: Schema.optional(Schema.String),
        severity: Schema.optional(Schema.String),
        title: Schema.optional(Schema.String),
        body: Schema.optional(Schema.String),
      }),
    ),
  ),
});
type Answer = typeof Answer.Type;

const decodeAnswer = Schema.decodeUnknownOption(Answer);

/** The last JSON object in `reply` that reads as an answer: fenced, or bare. */
const answerIn = (reply: string): Answer | undefined => {
  const candidates: Array<string> = [];
  for (const match of reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)) candidates.push(match[1]!);
  const open = reply.indexOf("{");
  const close = reply.lastIndexOf("}");
  if (open !== -1 && close > open) candidates.push(reply.slice(open, close + 1));
  for (const candidate of candidates.toReversed()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const answer = Option.getOrUndefined(decodeAnswer(parsed));
    if (answer !== undefined) return answer;
  }
  return undefined;
};

/** `path` as one of the diff's files names it, matched loosely: a leading `./` or `a/`, backslashes. */
const fileOf = (files: ReadonlyArray<DiffFile>, path: string): DiffFile | undefined => {
  const plain = path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^[ab]\//, "");
  return (
    files.find((file) => file.path === plain) ??
    files.find((file) => file.path.endsWith(`/${plain}`) || plain.endsWith(`/${file.path}`))
  );
};

const severityOf = (value: string | undefined): ReviewFinding["severity"] => {
  const word = (value ?? "").toLowerCase();
  if (/high|critical|blocker|major|bug/.test(word)) return "high";
  if (/low|minor|nit|info/.test(word)) return "low";
  return "medium";
};

/**
 * The reviewer's answer as findings on the diff's lines, each carrying the lines it covers. A finding
 * on a file outside the diff is kept on its path without lines; a reply that holds no answer reads as
 * a summary without findings.
 */
export const readReview = (
  reply: string,
  files: ReadonlyArray<DiffFile>,
): { readonly summary: string | undefined; readonly findings: ReadonlyArray<ReviewFinding> } => {
  const answer = answerIn(reply);
  if (answer === undefined) {
    const text = reply.trim();
    return { summary: text === "" ? undefined : text.slice(0, 2_000), findings: [] };
  }
  const findings = (answer.findings ?? []).flatMap((raw, index): ReadonlyArray<ReviewFinding> => {
    const body = (raw.body ?? "").trim();
    const title = (raw.title ?? "").trim() || body.split("\n")[0]!.slice(0, 120);
    if (title === "" && body === "") return [];
    const file = fileOf(files, raw.path);
    const side = raw.side === "old" ? "old" : "new";
    const first = Math.max(0, Math.round(raw.line ?? 0));
    const last = Math.max(first, Math.round(raw.endLine ?? first));
    const lines =
      file === undefined || first === 0
        ? []
        : file.hunks
            .flatMap(numberedLines)
            .filter(
              (line) =>
                line.number >= first &&
                line.number <= last &&
                (side === "old" ? line.marker === "-" : line.marker !== "-"),
            );
    return [
      {
        id: `f${index + 1}`,
        path: file?.path ?? raw.path.replaceAll("\\", "/"),
        start: first,
        end: last,
        side,
        severity: severityOf(raw.severity),
        title,
        body: body === title ? "" : body,
        lines,
        state: "open",
      },
    ];
  });
  const summary = answer.summary?.trim();
  return { summary: summary === "" ? undefined : summary, findings };
};

/**
 * The model a review runs on when the user picks none: the first on the roster on another harness
 * than the lead's, so the work is read with other eyes; else another model of the lead's harness;
 * else the lead's own model.
 */
export const defaultReviewer = (
  entries: ReadonlyArray<CatalogEntry>,
  lead: { readonly provider: ProviderId; readonly model: string },
): ReviewerModel | undefined => {
  const chosen =
    entries.find((entry) => entry.provider !== lead.provider) ??
    entries.find((entry) => entry.model !== lead.model) ??
    entries[0];
  if (chosen === undefined) return undefined;
  return {
    provider: chosen.provider,
    model: chosen.model,
    ...(chosen.effort === undefined ? {} : { effort: chosen.effort }),
  };
};
