import { Option, Schema } from "effect";

import { newDraftKey } from "../features/composer/drafts.ts";
import { closeKeys, leavesOf, type PaneNode as PaneNodeType } from "../features/split/model.ts";
import { closeTabs } from "../features/tabs/model.ts";
import { rememberForTab, storedForTab } from "../lib/storage.ts";
import type { AppMode } from "./mode.ts";

// Where the window is, kept for the tab, so a reload (or the web client moving to another build)
// comes back to the same thread or draft rather than to a blank new thread.

const SESSION_KEY = "cerium:session";

const Mode = Schema.Literals(["work", "chat"]);

const TabStrip = Schema.Struct({
  keys: Schema.Array(Schema.String),
  preview: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(Schema.String),
  closed: Schema.Array(Schema.String),
});

const PaneNode = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pane"), id: Schema.String, key: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("split"),
    axis: Schema.Literals(["row", "column"]),
    children: Schema.Array(Schema.suspend((): Schema.Codec<PaneNodeType> => PaneNode)),
    sizes: Schema.Array(Schema.Finite),
  }),
]);

const Panes = Schema.Struct({ root: PaneNode, focused: Schema.String, shown: Schema.String });

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
    /** Each machine's open tabs per mode. */
    tabs: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({ work: Schema.optionalKey(TabStrip), chat: Schema.optionalKey(TabStrip) }),
      ),
    ),
    /** How each mode's main area is split into panes. */
    panes: Schema.optionalKey(
      Schema.Struct({ work: Schema.optionalKey(Panes), chat: Schema.optionalKey(Panes) }),
    ),
  }),
);
export type Session = typeof Session.Type;

/** A blank new thread per mode, each with a draft of its own. */
export const freshBlank = (): Record<AppMode, string> => ({ work: newDraftKey(), chat: newDraftKey() });

/** The key a thread's browser had while it was a tab of its own, which an older session may hold. */
const BROWSER_TAB = "preview:";
const isBrowserTab = (key: string) => key.startsWith(BROWSER_TAB);

const eachMode = <A>(
  modes: { readonly work?: A; readonly chat?: A },
  change: (value: A) => A | undefined,
): { work?: A; chat?: A } => {
  const work = modes.work === undefined ? undefined : change(modes.work);
  const chat = modes.chat === undefined ? undefined : change(modes.chat);
  return { ...(work === undefined ? {} : { work }), ...(chat === undefined ? {} : { chat }) };
};

/**
 * `session` without the browser tabs and panes an older Cerium kept: each thread's browser docks
 * beside it now. A mode that showed one shows its thread instead.
 */
export const withoutBrowserTabs = (session: Session): Session => ({
  ...session,
  open: eachMode(session.open, (key) => (isBrowserTab(key) ? key.slice(BROWSER_TAB.length) : key)),
  ...(session.tabs === undefined
    ? {}
    : {
        tabs: Object.fromEntries(
          Object.entries(session.tabs).map(([machine, strips]) => [
            machine,
            eachMode(strips, (strip) => {
              const left = closeTabs(strip, strip.keys.filter(isBrowserTab), { remember: false }).strip;
              return { ...left, closed: left.closed.filter((key) => !isBrowserTab(key)) };
            }),
          ]),
        ),
      }),
  ...(session.panes === undefined
    ? {}
    : {
        panes: eachMode(session.panes, (panes) =>
          closeKeys(
            panes,
            leavesOf(panes.root)
              .map((leaf) => leaf.key)
              .filter(isBrowserTab),
          ),
        ),
      }),
});

/** Where this tab was before it reloaded, if it was anywhere. */
export const restoredSession = (): Session | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(Session)(storedForTab(SESSION_KEY)).pipe(Option.map(withoutBrowserTabs)),
  );

/** Remembers where the window is; like any remembered preference, failing never breaks the window. */
export const rememberSession = (
  session: Omit<Session, "open"> & { open: Partial<Record<AppMode, string | undefined>> },
) =>
  Schema.encodeOption(Session)({
    ...session,
    // A mode showing its blank new thread has nothing open.
    open: Object.fromEntries(Object.entries(session.open).filter(([, id]) => id !== undefined)),
  }).pipe(Option.map((encoded) => rememberForTab(SESSION_KEY, encoded)));
