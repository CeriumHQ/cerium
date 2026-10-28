import type { FilesChanged } from "@cerium/rpc";
import { Cause, Clock, Effect, Option, Schedule, Stream } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  buildRows,
  indexChanges,
  noChanges,
  type ChangeIndex,
  type Listed,
  type Row,
} from "../features/files/model.ts";
import { Backend, connectionEpochAtom, localMediaUrl } from "./client.ts";

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
      get(connectionEpochAtom);
      get(versionAtoms(key("dir", id)));
      return Backend.use((client) => client("ListFiles", { root, dir }));
    })
    .pipe(Atom.setIdleTTL("2 minutes"));
});

/** The least time between two reads of a folder's git status, in milliseconds. */
const STATUS_SPACING = 1_000;

/**
 * What git says differs from the last commit under `root`. Each read is a whole `git status`, and
 * while files churn a batch of changes comes every 300 ms: one read runs at a time, bumps during it
 * make one more after it, and a read waits until `STATUS_SPACING` after the last, so a slow status
 * finishes instead of being restarted by every batch. A read that fails is tried again shortly,
 * keeping the last status meanwhile.
 */
export const statusAtom = Atom.family((root: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      const statuses = Backend.use((client) => client("FileStatuses", { root }));
      let readAt = Number.NEGATIVE_INFINITY;
      const read = Effect.gen(function* () {
        const wait = readAt + STATUS_SPACING - (yield* Clock.currentTimeMillis);
        if (wait > 0) yield* Effect.sleep(wait);
        readAt = yield* Clock.currentTimeMillis;
        return yield* statuses;
      });
      return get.stream(versionAtoms(key("status", root))).pipe(
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => read),
        Stream.retry(Schedule.spaced("5 seconds")),
      );
    })
    .pipe(Atom.setIdleTTL("2 minutes")),
);

/** A file as the viewer shows it, keyed `root` and its path. */
export const previewKey = (root: string, path: string) => key(root, path);

export const previewAtom = Atom.family((id: string) => {
  const [root = "", path = ""] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      get(versionAtoms(key("file", id)));
      return Backend.use((client) => client("ReadFile", { root, path }));
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/**
 * A changed file against the last commit, keyed `root`, its path, where it was before a rename and
 * how many unchanged lines to show around each change.
 */
export const diffKey = (root: string, path: string, from: string | undefined, context: number) =>
  key(root, path, from ?? "", String(context));

export const diffAtom = Atom.family((id: string) => {
  const [root = "", path = "", from = "", context = "3"] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      get(versionAtoms(key("file", key(root, path))));
      return Backend.use((client) =>
        client("DiffFile", { root, path, context: Number(context), ...(from === "" ? {} : { from }) }),
      );
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/** How far a media file has been read; `url` plays or shows it once it can. */
export interface MediaLoad {
  readonly received: number;
  readonly url?: string;
}

/** A media file's bytes as a URL the page can play, keyed `root`, its path and its media type. */
export const mediaKey = (root: string, path: string, mediaType: string) => key(root, path, mediaType);

const fromBase64 = (data: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const mediaAtom = Atom.family((id: string) => {
  const [root = "", path = "", type = ""] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      const version = get(versionAtoms(key("file", key(root, path))));
      const parts: Array<Uint8Array<ArrayBuffer>> = [];
      let received = 0;
      let url: string | undefined;
      get.addFinalizer(() => {
        if (url !== undefined) URL.revokeObjectURL(url);
      });
      // This computer's own files play from its backend as they load; another machine's come
      // over RPC, whole, before they show.
      const overRpc = Stream.unwrap(
        Backend.use((client) => Effect.succeed(client("ReadFileBytes", { root, path }))),
      ).pipe(
        Stream.map(({ data }): MediaLoad => {
          const bytes = fromBase64(data);
          parts.push(bytes);
          received += bytes.length;
          return { received };
        }),
        Stream.concat(
          Stream.sync((): MediaLoad => {
            url = URL.createObjectURL(new Blob(parts, { type }));
            parts.length = 0;
            return { received, url };
          }),
        ),
      );
      return Stream.unwrap(
        Effect.map(localMediaUrl(root, path, version), (direct) =>
          direct === undefined ? overRpc : Stream.succeed<MediaLoad>({ received: 0, url: direct }),
        ),
      );
    })
    .pipe(Atom.setIdleTTL("30 seconds"));
});

/**
 * What changes under `root`, batch by batch, for as long as something reads it. A machine that stops
 * watching (or can't) is asked again every few seconds.
 */
export const watchAtom = Atom.family((root: string) =>
  Backend.runtime.atom((get) => {
    get(connectionEpochAtom);
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

/** Reads a file the viewer shows again: its text or media, and its diff. */
export const refreshFile = (registry: AtomRegistry.AtomRegistry, root: string, path: string) =>
  bump(registry, key("file", key(root, path)));

/** Reads again what a batch of changes touched: the folders it is in that are open, and the status. */
export const applyChanges = (
  registry: AtomRegistry.AtomRegistry,
  root: string,
  batch: FilesChanged,
  expanded: ReadonlySet<string>,
) => {
  if (batch.overflow === true) {
    refreshListing(registry, root, "");
    for (const dir of expanded) refreshListing(registry, root, dir);
    refreshStatus(registry, root);
    return;
  }
  const folders = new Set<string>();
  for (const path of batch.paths) {
    // A change inside a folder changes that folder's listing; the folder's own change, its parent's.
    folders.add(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  }
  for (const dir of folders) {
    if (dir === "" || expanded.has(dir)) refreshListing(registry, root, dir);
  }
  if (batch.status) refreshStatus(registry, root);
};
