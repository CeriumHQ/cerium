import type { FilesChanged } from "@cerium/rpc";
import { Cause, Effect, Option, Schedule, Stream } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  buildRows,
  indexChanges,
  noChanges,
  type ChangeIndex,
  type Listed,
  type Row,
} from "../features/files/model.ts";
import { Backend, connectionAtom } from "./client.ts";

// The file explorer's reads of the driven machine's disk. Each is an atom keyed by the folder it reads
// (`root`, the thread's folder, then the path in it, on separate lines), and each starts over when
// its version atom counts up: what the machine says changed (or an agent's edit) bumps them, so
// what's on screen is read again and nothing else.

const key = (...parts: ReadonlyArray<string>) => parts.join("\n");

const versionAtoms = Atom.family((_key: string) => Atom.make(0));

/** One folder's entries, with the key of `listingKey`. */
export const listingKey = (root: string, dir: string) => key(root, dir);

export const listingAtom = Atom.family((id: string) => {
  const [root = "", dir = ""] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(versionAtoms(key("dir", id)));
      return Backend.use((client) => client("ListFiles", { root, dir }));
    })
    .pipe(Atom.setIdleTTL("2 minutes"));
});

/** What git says differs from the last commit under `root`. */
export const statusAtom = Atom.family((root: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(versionAtoms(key("status", root)));
      return Backend.use((client) => client("FileStatuses", { root }));
    })
    .pipe(Atom.setIdleTTL("2 minutes")),
);

/** A file as the preview shows it, keyed `root` and its path. */
export const previewKey = (root: string, path: string) => key(root, path);

export const previewAtom = Atom.family((id: string) => {
  const [root = "", path = ""] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(versionAtoms(key("file", id)));
      return Backend.use((client) => client("ReadFile", { root, path }));
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/** A changed file against the last commit, keyed `root`, its path and where it was before a rename. */
export const diffKey = (root: string, path: string, from: string | undefined) => key(root, path, from ?? "");

export const diffAtom = Atom.family((id: string) => {
  const [root = "", path = "", from = ""] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(versionAtoms(key("file", key(root, path))));
      return Backend.use((client) => client("DiffFile", { root, path, ...(from === "" ? {} : { from }) }));
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/**
 * What changes under `root`, batch by batch, for as long as something reads it. A machine that stops
 * watching (or can't) is asked again every few seconds.
 */
export const watchAtom = Atom.family((root: string) =>
  Backend.runtime.atom((get) => {
    get(connectionAtom);
    return Stream.unwrap(Backend.use((client) => Effect.succeed(client("WatchFiles", { root })))).pipe(
      Stream.retry(Schedule.spaced("5 seconds")),
    );
  }),
);

/** The folders open in the tree of `root`, which stay open while the window does. */
export const expandedAtom = Atom.family((_root: string) =>
  Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive),
);

const message = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "That folder couldn't be read.";
};

/** What the explorer shows of `root`: its rows, git's view of them, and what went wrong. */
export interface Tree {
  readonly rows: ReadonlyArray<Row>;
  readonly changes: ChangeIndex;
  /** The top level is still being read. */
  readonly loading: boolean;
  /** The top level couldn't be read, in words for the user. */
  readonly error?: string;
}

/** What git says about `root`, ready to look paths up in; the last it said while it is asked again. */
export const changesAtom = Atom.family((root: string) =>
  Atom.make((get): ChangeIndex =>
    Option.match(AsyncResult.value(get(statusAtom(root))), { onNone: () => noChanges, onSome: indexChanges }),
  ),
);

export const treeAtom = Atom.family((root: string) =>
  Atom.make((get): Tree => {
    const expanded = get(expandedAtom(root));
    const changes = get(changesAtom(root));
    const listing = (dir: string): Listed => {
      const result = get(listingAtom(listingKey(root, dir)));
      return Option.match(AsyncResult.value(result), {
        onSome: (listed) => listed,
        onNone: () => (AsyncResult.isFailure(result) ? "failed" : "loading"),
      });
    };
    const top = get(listingAtom(listingKey(root, "")));
    return {
      rows: buildRows({ expanded, listing, changes }),
      changes,
      loading: Option.isNone(AsyncResult.value(top)) && !AsyncResult.isFailure(top),
      ...(AsyncResult.isFailure(top) && Option.isNone(AsyncResult.value(top))
        ? { error: message(top.cause) }
        : {}),
    };
  }),
);

/** Counts up the version a read of `what` waits on, so it reads again. */
const bump = (registry: AtomRegistry.AtomRegistry, id: string) =>
  registry.update(versionAtoms(id), (count) => count + 1);

export const refreshListing = (registry: AtomRegistry.AtomRegistry, root: string, dir: string) =>
  bump(registry, key("dir", listingKey(root, dir)));

export const refreshStatus = (registry: AtomRegistry.AtomRegistry, root: string) =>
  bump(registry, key("status", root));

export const refreshFile = (registry: AtomRegistry.AtomRegistry, root: string, path: string) =>
  bump(registry, key("file", key(root, path)));

/** Reads again what a batch of changes touched: the folders it is in that are open, the status, and the file shown. */
export const applyChanges = (
  registry: AtomRegistry.AtomRegistry,
  root: string,
  batch: FilesChanged,
  shown: { readonly expanded: ReadonlySet<string>; readonly file?: string | undefined },
) => {
  if (batch.overflow === true) {
    refreshListing(registry, root, "");
    for (const dir of shown.expanded) refreshListing(registry, root, dir);
    refreshStatus(registry, root);
    if (shown.file !== undefined) refreshFile(registry, root, shown.file);
    return;
  }
  const folders = new Set<string>();
  for (const path of batch.paths) {
    // A change inside a folder changes that folder's listing; the folder's own change, its parent's.
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    folders.add(parent);
    if (path === shown.file) refreshFile(registry, root, path);
  }
  for (const dir of folders) {
    if (dir === "" || shown.expanded.has(dir)) refreshListing(registry, root, dir);
  }
  if (batch.status) refreshStatus(registry, root);
  // A change to git's own state (a commit) moves what the open file differs from.
  if (shown.file !== undefined && batch.status) refreshFile(registry, root, shown.file);
};
