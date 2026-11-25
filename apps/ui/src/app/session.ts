import { Option, Schema } from "effect";

import { newDraftKey } from "../features/composer/drafts.ts";
import { closeKeys, leavesOf, type PaneNode as PaneNodeType } from "../features/split/model.ts";
import { closeTabs, type TabStrip as TabStripModel } from "../features/tabs/model.ts";
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

const UnifiedSession = Schema.Struct({
  /** The machine the window drove; none for this computer. */
  machine: Schema.optionalKey(Schema.String),
  /** Which sidebar list is open (Home vs. Chat); tabs and panes are shared across both. */
  mode: Mode,
  /** The open thread, file, PR/issue, or draft key. */
  open: Schema.optionalKey(Schema.String),
  /** The fallback blank new-thread draft key. */
  blank: Schema.String,
  pane: Schema.Literals(["list", "main"]),
  /** Each machine's unified open tabs (work threads, chats, drafts, files, GitHub). */
  tabs: Schema.optionalKey(Schema.Record(Schema.String, TabStrip)),
  /** How the main area is split into panes. */
  panes: Schema.optionalKey(Panes),
});
export type Session = typeof UnifiedSession.Type;

const SessionJson = Schema.fromJsonString(UnifiedSession);

/** Older sessions stored `open`, `blank`, `tabs`, and `panes` separately per mode. */
const LegacySessionJson = Schema.fromJsonString(
  Schema.Struct({
    machine: Schema.optionalKey(Schema.String),
    mode: Mode,
    open: Schema.Struct({ work: Schema.optionalKey(Schema.String), chat: Schema.optionalKey(Schema.String) }),
    blank: Schema.Struct({ work: Schema.String, chat: Schema.String }),
    pane: Schema.Literals(["list", "main"]),
    tabs: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({ work: Schema.optionalKey(TabStrip), chat: Schema.optionalKey(TabStrip) }),
      ),
    ),
    panes: Schema.optionalKey(
      Schema.Struct({ work: Schema.optionalKey(Panes), chat: Schema.optionalKey(Panes) }),
    ),
  }),
);

const dedupe = (keys: ReadonlyArray<string>): Array<string> => [...new Set(keys)];

const mergeStrips = (
  primary: TabStripModel | undefined,
  secondary: TabStripModel | undefined,
): TabStripModel | undefined => {
  if (primary === undefined) return secondary;
  if (secondary === undefined) return primary;
  const keys = dedupe([...primary.keys, ...secondary.keys]);
  const open = new Set(keys);
  const closed = dedupe([...primary.closed, ...secondary.closed]).filter((key) => !open.has(key));
  const active = primary.active ?? secondary.active;
  const preview = primary.preview ?? secondary.preview;
  return {
    keys,
    closed,
    ...(active === undefined ? {} : { active }),
    ...(preview === undefined ? {} : { preview }),
  };
};

const migrateLegacy = (legacy: typeof LegacySessionJson.Type): Session => {
  const other: AppMode = legacy.mode === "work" ? "chat" : "work";
  const open = legacy.open[legacy.mode] ?? legacy.open[other];
  const blank = legacy.blank[legacy.mode] ?? freshBlank(legacy.mode);
  const panes = legacy.panes?.[legacy.mode] ?? legacy.panes?.[other];
  const tabs =
    legacy.tabs === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(legacy.tabs).flatMap(([machine, strips]) => {
            const merged = mergeStrips(strips[legacy.mode], strips[other]);
            return merged === undefined ? [] : [[machine, merged]];
          }),
        );
  return {
    ...(legacy.machine === undefined ? {} : { machine: legacy.machine }),
    mode: legacy.mode,
    ...(open === undefined ? {} : { open }),
    blank,
    pane: legacy.pane,
    ...(tabs === undefined ? {} : { tabs }),
    ...(panes === undefined ? {} : { panes }),
  };
};

/** A fresh blank draft key for `mode`. */
export const freshBlank = (mode: AppMode = "work"): string => newDraftKey(mode);

/** The key a thread's browser had while it was a tab of its own, which an older session may hold. */
const BROWSER_TAB = "preview:";
const isBrowserTab = (key: string) => key.startsWith(BROWSER_TAB);

/**
 * `session` without the browser tabs and panes an older Cerium kept: each thread's browser docks
 * beside it now. A session that showed one shows its thread instead.
 */
export const withoutBrowserTabs = (session: Session): Session => {
  const { open: prevOpen, panes: prevPanes, tabs: prevTabs, ...rest } = session;
  const open =
    prevOpen === undefined
      ? undefined
      : isBrowserTab(prevOpen)
        ? prevOpen.slice(BROWSER_TAB.length)
        : prevOpen;
  const panes =
    prevPanes === undefined
      ? undefined
      : closeKeys(
          prevPanes,
          leavesOf(prevPanes.root)
            .map((leaf) => leaf.key)
            .filter(isBrowserTab),
        );
  return {
    ...rest,
    ...(open === undefined ? {} : { open }),
    ...(prevTabs === undefined
      ? {}
      : {
          tabs: Object.fromEntries(
            Object.entries(prevTabs).map(([machine, strip]) => {
              const left = closeTabs(strip, strip.keys.filter(isBrowserTab), { remember: false }).strip;
              return [machine, { ...left, closed: left.closed.filter((key) => !isBrowserTab(key)) }];
            }),
          ),
        }),
    ...(panes === undefined ? {} : { panes }),
  };
};

/** Where this tab was before it reloaded, if it was anywhere. */
export const restoredSession = (): Session | undefined => {
  const raw = storedForTab(SESSION_KEY);
  const decoded = Schema.decodeUnknownOption(SessionJson)(raw).pipe(
    Option.orElse(() => Schema.decodeUnknownOption(LegacySessionJson)(raw).pipe(Option.map(migrateLegacy))),
    Option.map(withoutBrowserTabs),
  );
  return Option.getOrUndefined(decoded);
};

/** Remembers where the window is; like any remembered preference, failing never breaks the window. */
export const rememberSession = ({ open, ...rest }: Omit<Session, "open"> & { open: string | undefined }) =>
  Schema.encodeOption(SessionJson)({
    ...rest,
    ...(open === undefined ? {} : { open }),
  }).pipe(Option.map((json) => rememberForTab(SESSION_KEY, json)));
