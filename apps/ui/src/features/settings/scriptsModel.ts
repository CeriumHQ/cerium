import { actionNameProblem, type ActionCommand, type ProjectScripts, type ScriptSource } from "@cerium/rpc";

// What the Project scripts card in Git & GitHub keeps of a project's commands: the fields it shows,
// what each command came from, and how what's typed becomes what's saved on this machine or written
// to the project's `.cerium.toml`.

/** The commands with a field of their own, in the order the card lists them. */
export const SCRIPT_FIELDS = [
  { kind: "setup", label: "Setup" },
  { kind: "run", label: "Run" },
  { kind: "teardown", label: "Teardown" },
] as const;
export type ScriptField = (typeof SCRIPT_FIELDS)[number]["kind"];

/** Where a command came from, in a word, and what that means for the project's team. */
export const SOURCE_TEXT: Readonly<
  Record<ScriptSource, { readonly label: string; readonly detail: string }>
> = {
  saved: {
    label: "This machine",
    detail: "Saved on this machine only. It wins over the project's .cerium.toml.",
  },
  project: { label: ".cerium.toml", detail: "Read from the project's .cerium.toml, which its team shares." },
  guessed: {
    label: "Guess",
    detail: "Cerium's guess from the project's files. A thread asks before running it.",
  },
};

/** What a script's field holds, as the text of the command its resolution offers. */
export const fieldText = (scripts: ProjectScripts, kind: ScriptField): string => scripts[kind]?.text ?? "";

/** The fields' texts as the resolution offers them. */
export const textsOf = (scripts: ProjectScripts): Record<ScriptField, string> => ({
  setup: fieldText(scripts, "setup"),
  run: fieldText(scripts, "run"),
  teardown: fieldText(scripts, "teardown"),
});

/**
 * What to save on this machine for a script's field. A command left as the file or the guess offered
 * it defers (`null`), so the project's own word can change underneath it; one already saved, changed
 * or typed in is the user's word. An emptied field is `""`, which turns the command off.
 */
export const savedWord = (scripts: ProjectScripts, kind: ScriptField, text: string): string | null => {
  const offered = scripts[kind];
  if (offered === undefined) return text;
  return text === offered.text && offered.from !== "saved" ? null : text;
};

/** One row of the actions list: the name and command as typed, with an id the row keeps while it's edited. */
export interface ActionRow {
  readonly id: number;
  readonly name: string;
  readonly command: string;
}

/** The rows an action list starts as: the resolution's actions. */
export const rowsOf = (scripts: ProjectScripts, firstId = 0): ReadonlyArray<ActionRow> =>
  (scripts.actions ?? []).map((action, at) => ({
    id: firstId + at,
    name: action.name,
    command: action.text,
  }));

/** The rows that hold anything: a row left blank is one the user added and didn't fill. */
const filled = (rows: ReadonlyArray<ActionRow>) =>
  rows.filter((row) => row.name.trim() !== "" || row.command.trim() !== "");

/** The commands the rows say, trimmed, without the blank rows. */
export const commandsOf = (rows: ReadonlyArray<ActionRow>): ReadonlyArray<ActionCommand> =>
  filled(rows).map((row) => ({ name: row.name.trim(), command: row.command.trim() }));

/** What's wrong with each row, by its id, written for the user; rows that are fine are left out. */
export const rowProblems = (rows: ReadonlyArray<ActionRow>): ReadonlyMap<number, string> => {
  const problems = new Map<number, string>();
  const kept = filled(rows);
  for (const [at, row] of kept.entries()) {
    const problem =
      row.name.trim() === ""
        ? "Give it a name."
        : row.command.trim() === ""
          ? "Add a command."
          : actionNameProblem(
              row.name,
              kept.slice(0, at).map((other) => other.name),
            );
    if (problem !== undefined) problems.set(row.id, problem);
  }
  return problems;
};

/** Whether the resolution's actions are the user's own: a saved list, even an empty one. */
export const actionsSaved = (scripts: ProjectScripts): boolean => {
  const listed = scripts.actions;
  return listed !== undefined && (listed.length === 0 || listed[0]?.from === "saved");
};

const sameCommands = (a: ReadonlyArray<ActionCommand>, b: ReadonlyArray<ActionCommand>) =>
  a.length === b.length && a.every((one, at) => one.name === b[at]?.name && one.command === b[at]?.command);

/**
 * What to save on this machine for the actions list. A list left as the project's file has it defers
 * (`null`); a saved one is saved again as it reads now, and any other list is the user's own, an
 * empty one turning the file's actions off.
 */
export const savedActions = (
  scripts: ProjectScripts,
  rows: ReadonlyArray<ActionRow>,
): ReadonlyArray<ActionCommand> | null => {
  const now = commandsOf(rows);
  if (actionsSaved(scripts)) return now;
  const offered = (scripts.actions ?? []).map((action) => ({ name: action.name, command: action.text }));
  return sameCommands(now, offered) ? null : now;
};

/** What the card edits, as one value to tell whether anything changed since the project was read. */
export interface CardState {
  readonly texts: Readonly<Record<ScriptField, string>>;
  readonly rows: ReadonlyArray<ActionRow>;
}

/** Whether the card holds something the project's resolution doesn't already say. */
export const changed = (scripts: ProjectScripts, state: CardState): boolean =>
  SCRIPT_FIELDS.some(({ kind }) => state.texts[kind].trim() !== fieldText(scripts, kind)) ||
  !sameCommands(
    commandsOf(state.rows),
    (scripts.actions ?? []).map((action) => ({ name: action.name, command: action.text })),
  );

/**
 * Whether writing the card to the project's file would add nothing: everything shown is already
 * the file's own word, and nothing has been edited.
 */
export const alreadyInFile = (scripts: ProjectScripts, state: CardState): boolean =>
  !changed(scripts, state) &&
  SCRIPT_FIELDS.every(({ kind }) => (scripts[kind]?.from ?? "project") === "project") &&
  !actionsSaved(scripts);

/** The project the card opens on: the one the user came from, else the first the machine knows. */
export const initialProject = (
  projects: ReadonlyArray<string>,
  preferred: string | undefined,
): string | undefined => {
  const plain = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return projects.find((each) => preferred !== undefined && plain(each) === plain(preferred)) ?? projects[0];
};
