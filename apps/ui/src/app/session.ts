import { Option, Schema } from "effect";

import { newDraftKey } from "../features/composer/drafts.ts";
import { rememberForTab, storedForTab } from "../lib/storage.ts";
import type { AppMode } from "./ModeSwitch.tsx";

// Where the window is, kept for the tab, so a reload (or the web client moving to another build)
// comes back to the same thread or draft rather than to a blank new thread.

const SESSION_KEY = "cerium:session";

const Mode = Schema.Literals(["work", "chat"]);

const Session = Schema.fromJsonString(
  Schema.Struct({
    /** The machine the window drove; none for this computer. */
    machine: Schema.optionalKey(Schema.String),
    mode: Mode,
    /** The thread, or the draft of a thread not started yet, open per mode. */
    open: Schema.Struct({ work: Schema.optionalKey(Schema.String), chat: Schema.optionalKey(Schema.String) }),
    /** Each mode's blank new thread: the draft "New thread" writes into. */
    blank: Schema.Struct({ work: Schema.String, chat: Schema.String }),
    pane: Schema.Literals(["list", "main"]),
  }),
);
export type Session = typeof Session.Type;

/** A blank new thread per mode, each with a draft of its own. */
export const freshBlank = (): Record<AppMode, string> => ({ work: newDraftKey(), chat: newDraftKey() });

/** Where this tab was before it reloaded, if it was anywhere. */
export const restoredSession = (): Session | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Session)(storedForTab(SESSION_KEY)));

/** Remembers where the window is; like any remembered preference, failing never breaks the window. */
export const rememberSession = (
  session: Omit<Session, "open"> & { open: Partial<Record<AppMode, string | undefined>> },
) =>
  Schema.encodeOption(Session)({
    ...session,
    // A mode showing its blank new thread has nothing open.
    open: Object.fromEntries(Object.entries(session.open).filter(([, id]) => id !== undefined)),
  }).pipe(Option.map((encoded) => rememberForTab(SESSION_KEY, encoded)));
