import type { TerminalInfo } from "@cerium/rpc";

// What the terminal drawer works out from the terminals a machine lists, and the room it has.

/** The `RPC_VERSION` that brought terminals; an older machine has none to open. */
export const TERMINAL_VERSION = 4;

/** The drawer's height: remembered between launches, `fallback` until the user has dragged it. */
export const DRAWER = { key: "cerium:terminalHeight", fallback: 280, min: 120 } as const;

/** What the transcript above the drawer is always left, so the conversation never disappears behind it. */
const MIN_ABOVE = 240;

export interface DrawerLayout {
  readonly height: number;
  readonly max: number;
}

/**
 * The drawer's height in a main column `columnHeight` tall, given the height the user last left it at:
 * never less than `DRAWER.min`, and never so tall that less than `MIN_ABOVE` of the thread remains.
 */
export const drawerLayout = (columnHeight: number, saved: number): DrawerLayout => {
  const max = Math.max(DRAWER.min, columnHeight - MIN_ABOVE);
  return { height: Math.min(Math.max(saved, DRAWER.min), max), max };
};

/** The `RPC_VERSION` that brought a project's terminals, opened before a thread starts there. */
export const PROJECT_TERMINAL_VERSION = 22;

/** The `RPC_VERSION` that brought a project's scripts (`RunProjectScript`); an older machine has none. */
export const SCRIPT_VERSION = 29;

/** The `RPC_VERSION` that brought a project's named actions and writing its `.cerium.toml`; an older machine has neither. */
export const ACTIONS_VERSION = 39;

/** Whose terminals the drawer shows: a work thread's, or a project's while a new thread is written there. */
export type TerminalOwner = { readonly threadId: string } | { readonly project: string };

/** What the drawer remembers per owner: the thread's id, or the project's folder. */
export const ownerKey = (owner: TerminalOwner): string =>
  "threadId" in owner ? owner.threadId : `project:${owner.project}`;

/** An owner's terminals, in the order they opened. */
export const terminalsOf = (
  all: ReadonlyArray<TerminalInfo>,
  owner: TerminalOwner,
): ReadonlyArray<TerminalInfo> =>
  all
    .filter((terminal) =>
      "threadId" in owner
        ? terminal.threadId === owner.threadId
        : terminal.threadId === undefined && terminal.project === owner.project,
    )
    .toSorted((a, b) => a.openedAt - b.openedAt);

/** What each tab says: the shell's name, numbered once a thread has several of the same. */
export const tabLabels = (terminals: ReadonlyArray<TerminalInfo>): ReadonlyArray<string> => {
  const seen = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const { shell } of terminals) totals.set(shell, (totals.get(shell) ?? 0) + 1);
  return terminals.map(({ shell }) => {
    const number = (seen.get(shell) ?? 0) + 1;
    seen.set(shell, number);
    return (totals.get(shell) ?? 0) > 1 ? `${shell} ${number}` : shell;
  });
};

/**
 * How a shell's end is told. Windows reports a program that was stopped as a large negative number, so
 * a code that isn't an ordinary one reads in hex, as Windows documents them.
 */
export const exitNote = (code: number | undefined): string => {
  if (code === undefined || code === 0) return "Exited";
  if (code < 0 || code > 255) return `Exited with code 0x${(code >>> 0).toString(16).toUpperCase()}`;
  return `Exited with code ${code}`;
};

/** What a failed call says to the user. */
export const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong.";

/** Input split into pieces the backend accepts in one call. */
export const inputPieces = (data: string, size: number): ReadonlyArray<string> => {
  const pieces: Array<string> = [];
  for (let at = 0; at < data.length;) {
    let end = Math.min(at + size, data.length);
    // Never between the halves of a character that takes two.
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(data.slice(at, end));
    at = end;
  }
  return pieces;
};

/** The terminal a thread shows: the one it last showed while it's still there, else the newest. */
export const shownTerminal = (
  terminals: ReadonlyArray<TerminalInfo>,
  chosen: string | undefined,
): TerminalInfo | undefined => terminals.find((terminal) => terminal.id === chosen) ?? terminals.at(-1);

/** What a terminal that runs one of a project's scripts is labelled, by the kind of script. */
export const SCRIPT_LABEL = { setup: "Setup", run: "Run" } as const;

/** An owner's terminal running a project script under `label`: the name of one of its actions (Test,
 * Lint), or what a setup or run is labelled. The newest wins: the same script's terminal takes the
 * last one's place, which then lingers, and a run that ended stays shown in the drawer until its
 * script starts again. */
export const labelledTerminalOf = (
  terminals: ReadonlyArray<TerminalInfo>,
  owner: TerminalOwner,
  label: string,
): TerminalInfo | undefined => {
  const theirs = terminalsOf(terminals, owner);
  for (let at = theirs.length - 1; at >= 0; at--) {
    const each = theirs[at];
    if (each?.script === label) return each;
  }
  return undefined;
};

/** An owner's terminal running one of its project's scripts (`Setup`, `Run`), if it has one. */
export const scriptTerminalOf = (
  terminals: ReadonlyArray<TerminalInfo>,
  owner: TerminalOwner,
  kind: keyof typeof SCRIPT_LABEL,
): TerminalInfo | undefined => labelledTerminalOf(terminals, owner, SCRIPT_LABEL[kind]);
